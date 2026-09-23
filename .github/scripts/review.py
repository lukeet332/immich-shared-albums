# .github/scripts/review.py — a free re-implementation of the CodeRabbit review pipeline. See review.md.

import argparse
import fnmatch
import json
import os
import random
import re
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
MARKER = "<!-- isa-review-pipeline -->"
# Above this many lines GitHub serves no unified diff at all, and answers the request with 406.
GITHUB_DIFF_LINE_LIMIT = 20000
FILES_PER_PAGE = 100
MAX_DIFF_FILES = 300
MAX_CHUNK_DIFF_LINES = 120
MAX_FILE_CHARS = 12000
MAX_RULES_CHARS = 4000
SOURCE_SUFFIXES = (".ts", ".tsx", ".rs", ".mjs", ".js")
MAX_DIFF_CHARS = 20000
DEFAULT_MENTION = "@isa"
COMMANDS = ("review", "summary", "ask", "help")
HELP_TEXT = f"""{MARKER}
### Review bot commands

| Command | What it does |
| --- | --- |
| `/review` | review the current changes now |
| `/summary` | review, but post only the summary — no inline comments |
| `/ask <question>` | answer a question about this pull request |
| `/help` | this list |

`{DEFAULT_MENTION} <anything>` also works and is treated as `/ask`, but `{DEFAULT_MENTION}` is a
local alias rather than an account — GitHub links it to an unrelated user — so the slash commands are
the ones to use. Replies to an inline comment arrive in that comment's own thread.

The automatic review runs on `opened`, `reopened`, `ready_for_review` and every push to the branch."""
MAX_COMMENTS = 12
SEVERITIES = ("high", "medium")
STAGES = ("summarise", "review", "verify")
# Read from .coderabbit.yaml's `path_filters`, so both reviewers spend the file budget on the same
# files. These are the same exclusions in glob form, used only when that file cannot be read.
EXCLUDED_FALLBACK = (
    "package-lock.json",
    "src/web/dist/**",
    "src/web/panel.bundle.js",
    "src/web/accept.bundle.js",
    "src/web/share.bundle.js",
)
DEADLINE_SECONDS = 900
# Outer bounds rather than targets: DEADLINE_SECONDS is what actually stops a large pull request,
# and both are overridable per run for one that is too big to cover in four chunks.
MAX_REQUESTS = 8
MAX_CHUNKS = 4
# Workers, not threads: `http` bounds each request with a process-global SIGALRM. See review.md.
# Two rather than one because every model in the chain reasons before it answers: see the token cap.
PARALLEL = 2
CALL_TIMEOUT_SECONDS = 240
CALL_ATTEMPTS = 1
# Sized for a reasoning model, which thinks for thousands of tokens before it writes a word: a 6,451
# token prompt cost one 9,398 reasoning tokens to answer, so a 3,000 cap came back
# `finish_reason=length` with empty content — a wasted request that read as a model with nothing to say.
MAX_OUTPUT_TOKENS = 16000
# The most room a retry may ask for: a chunk that cannot answer in this much has not been cut off.
MAX_OUTPUT_ROOM = 32000
# A per-minute limit is a pause, not a retirement. Groq's is 8,000 tokens a minute against a ~6,500
# token prompt, so the same model answers again ~45 seconds later — and until this existed the first
# 429 retired the model for the whole run, which came out as one chunk reviewed out of twelve.
RATE_LIMIT_MAX_WAIT = 120
MAX_RATE_LIMIT_WAITS = 3
DEAD_KEY_STATUS_CODES = (401, 402, 403)
DEAD_MODEL_STATUS_CODES = (404, 429)


class Budget:
    """Stops the pipeline outliving either the CI timeout or the provider's daily allowance."""

    def __init__(self, max_requests, deadline_seconds):
        self.requests_left = max_requests
        self.deadline = time.monotonic() + deadline_seconds
        self.dead_providers = set()
        self.dead_candidates = set()
        # Whichever providers actually answered. `verify` avoids them, because a model that has just
        # written a finding is the worst possible judge of it — on #130 the verifier was the same
        # model as the reviewer and confirmed all three of its own false positives.
        self.answered_by = set()

    def exhausted(self):
        return self.requests_left <= 0 or time.monotonic() >= self.deadline

    def spend(self):
        self.requests_left -= 1

PROVIDERS = {
    "cerebras": ("https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
    "nvidia": ("https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY"),
    "mistral": ("https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "sambanova": ("https://api.sambanova.ai/v1", "SAMBANOVA_API_KEY"),
}

SYSTEM_REVIEW = """You are a code reviewer for a repository whose conventions live in AGENTS.md.
Return ONLY JSON. Report a finding only when you can name the concrete failure it causes.
Rules:
- Obey the repository rules given to you; they override your defaults.
- Do NOT report anything CI already catches: formatting, lint, types, import cycles, test failures.
- Do NOT report style, naming preferences, or missing tests unless a rule says otherwise.
- Prefer few high-confidence findings over many speculative ones. Reporting nothing is correct when
  the change is sound.
- `line` must be copied verbatim from the left column of the diff, which is the new file's line number.
Schema: {"findings":[{"line":int,"severity":"high"|"medium"|"low","title":str,"body":str}]}"""

SYSTEM_SUMMARISE = """Summarise a code change for a reviewer who will then judge it.
Return ONLY JSON: {"intent":str,"what_changed":[str],"risk_areas":[str],"rules_touched":[str]}.
Be terse and factual. Do not review, judge, or suggest anything."""

SYSTEM_VERIFY = """You are an adversarial verifier. For each candidate finding, decide independently
whether it is a real defect in the code shown. Refute anything speculative, stylistic, already caught
by CI, or unsupported by the diff. Return ONLY JSON:
{"verdicts":[{"index":int,"verdict":"confirm"|"refute","reason":str}]}"""

SYSTEM_ASK = """You are answering a question about a pull request, for the person who opened it.
Answer in a few sentences. Name the file and line you mean. Say plainly when the diff does not tell
you. Do not review the change unless the question asks for that, and do not list findings."""


def log(message):
    print(message, flush=True)


def warn(message):
    print(f"::warning::{message}", flush=True)


def notice(message):
    print(f"::notice::{message}", flush=True)


def request_timed_out(signum, frame):
    raise TimeoutError("wall-clock deadline reached")


def retry_after(error, body):
    """Seconds to wait, or None when this is not a short limit. Groq states it in a header and in the
    message; anything longer than RATE_LIMIT_MAX_WAIT is a daily cap wearing a per-minute's clothes."""
    header = (error.headers.get("retry-after") if error.headers else None) or ""
    try:
        seconds = float(header)
    except ValueError:
        found = re.search(r"try again in (\d+(?:\.\d+)?)s", body)
        if not found:
            return None
        seconds = float(found.group(1))
    return seconds if 0 < seconds <= RATE_LIMIT_MAX_WAIT else None


def http(method, url, token, body=None, accept="application/vnd.github+json", timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", accept)
    request.add_header("User-Agent", "isa-review-pipeline")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    if data:
        request.add_header("Content-Type", "application/json")
    # urlopen's timeout is per socket read, and a queued free endpoint streams keep-alive whitespace,
    # which resets it indefinitely. Only an alarm bounds the request by wall clock.
    previous = signal.signal(signal.SIGALRM, request_timed_out)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8", "replace")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    return json.loads(payload) if payload.strip().startswith(("{", "[")) else payload


def api(repo, path, token, method="GET", body=None, accept="application/vnd.github+json"):
    return http(method, f"{API}/repos/{repo}{path}", token, body=body, accept=accept)


def key_for(provider):
    _, env_name = PROVIDERS[provider]
    return os.environ.get(env_name, "").strip()


def rotate(candidates, offset):
    """Start each pull request at a different candidate, so one provider's daily allowance is not drained first."""
    if not candidates:
        return candidates
    offset %= len(candidates)
    return candidates[offset:] + candidates[:offset]


def stage_models_for(path, seed):
    with open(path, encoding="utf-8") as handle:
        configured = json.load(handle)
    usable = {}
    for stage in STAGES:
        candidates = [
            candidate
            for candidate in (configured.get(stage) or [])
            if isinstance(candidate, dict) and key_for(candidate["provider"])
        ]
        if candidates:
            usable[stage] = rotate(candidates, seed)
    return usable


def complete(stage, candidates, system, user, budget, max_tokens=MAX_OUTPUT_TOKENS, avoid=()):
    """First candidate that answers wins; a provider failing is not an error, it is a fallback.

    `avoid` is pushed to the back of the queue, not dropped: if it is all there is, it still answers.
    """
    last_error = None
    order = [c for c in candidates if c["provider"] not in avoid] + [
        c for c in candidates if c["provider"] in avoid
    ]
    for candidate in order:
        provider, model = candidate["provider"], candidate["model"]
        identifier = f"{provider}/{model}"
        if provider in budget.dead_providers or identifier in budget.dead_candidates:
            continue
        if budget.exhausted():
            warn(f"{stage}: skipped — this run's budget is spent")
            return None
        base_url, env_name = PROVIDERS[provider]
        room = max_tokens
        attempt, waits = 0, 0
        while True:
            try:
                while True:
                    budget.spend()
                    payload = http(
                        "POST",
                        f"{base_url}/chat/completions",
                        os.environ.get(env_name, ""),
                        body={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": system},
                                {"role": "user", "content": user},
                            ],
                            "temperature": 0,
                            "max_tokens": room,
                        },
                        timeout=CALL_TIMEOUT_SECONDS,
                    )
                    if not isinstance(payload, dict) or "choices" not in payload:
                        # Print the provider's own body: a bare KeyError hides what it actually said.
                        raise RuntimeError(f"unexpected response: {str(payload)[:300]}")
                    choice = payload["choices"][0]
                    content = choice.get("message", {}).get("content")
                    if content:
                        log(f"  {stage}: {identifier} answered ({len(content)} chars)")
                        budget.answered_by.add(provider)
                        return content
                    last_error = (
                        f"{identifier} no content (finish_reason={choice.get('finish_reason')}, "
                        f"usage={payload.get('usage') or {}})"
                    )
                    if not (choice.get("finish_reason") == "length" and room < MAX_OUTPUT_ROOM):
                        break
                    # A reasoning model that ran out of room has not failed — it was cut off mid
                    # thought, before it wrote a word. The same request with more room answers.
                    room = min(room * 2, MAX_OUTPUT_ROOM)
                    warn(f"{stage}: {identifier} was cut off; retrying with max_tokens={room}")
                    if budget.exhausted():
                        break
                raise RuntimeError(last_error)
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", "replace")
                detail = body[:300]
                last_error = f"{identifier} HTTP {error.code}: {detail}"
                if error.code in DEAD_KEY_STATUS_CODES:
                    # The key is dead, so no model behind this provider can answer either.
                    budget.dead_providers.add(provider)
                    warn(f"{stage}: {provider} unusable this run (HTTP {error.code}) — {detail[:120]}")
                    break
                if error.code == 429:
                    wait = retry_after(error, body)
                    if (
                        wait is not None
                        and waits < MAX_RATE_LIMIT_WAITS
                        and time.monotonic() + wait < budget.deadline
                    ):
                        waits += 1
                        warn(f"{stage}: {identifier} is rate limited; waiting {wait:.0f}s for it")
                        time.sleep(wait)
                        continue
                if error.code in DEAD_MODEL_STATUS_CODES:
                    # Only this model is saturated or gone; the next candidate may be fine.
                    budget.dead_candidates.add(identifier)
                    warn(f"{stage}: {identifier} unavailable this run (HTTP {error.code})")
                    break
                attempt += 1
                if attempt >= CALL_ATTEMPTS:
                    break
                time.sleep(2**attempt + random.random())
            except Exception as error:
                last_error = f"{identifier}: {error}"
                attempt += 1
                if attempt >= CALL_ATTEMPTS:
                    break
                time.sleep(2**attempt + random.random())
        warn(f"{stage}: falling back past {identifier} — {last_error}")
    warn(f"{stage}: no provider answered ({last_error})")
    return None


def parse_json_object(raw):
    if not raw:
        return None
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        text = fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def diff_via_files(repo, pr, token):
    """Rebuild a unified diff from the files API, for a pull request too large to serve one."""
    parts, unpatched, page = [], 0, 1
    while page <= MAX_DIFF_FILES // FILES_PER_PAGE:
        batch = api(repo, f"/pulls/{pr}/files?per_page={FILES_PER_PAGE}&page={page}", token)
        if not isinstance(batch, list) or not batch:
            break
        for entry in batch:
            patch = entry.get("patch")
            if not patch:
                # Binary, or changed too much for GitHub to inline a patch: not reviewable input.
                unpatched += 1
                continue
            parts.append(f"+++ b/{entry['filename']}\n{patch}\n")
        if len(batch) < FILES_PER_PAGE:
            break
        page += 1
    if unpatched:
        warn(f"{unpatched} file(s) carry no patch (binary or oversized) and were not reviewable")
    return "\n".join(parts)


def fetch_diff(repo, pr, token):
    """The unified diff, or one rebuilt from the files API when GitHub refuses to serve it."""
    try:
        return api(repo, f"/pulls/{pr}", token, accept="application/vnd.github.v3.diff")
    except urllib.error.HTTPError as error:
        if error.code != 406:
            raise
        warn(
            f"#{pr} has no unified diff (HTTP 406: over {GITHUB_DIFF_LINE_LIMIT} lines) "
            "— rebuilding it from the files API"
        )
        return diff_via_files(repo, pr, token)


def changed_lines_by_file(diff_text):
    """Per path: the NEW-file line numbers the diff adds, and hunks as (line_number, text)."""
    files, path, new_line = {}, None, 0
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            path = line[6:].strip()
            path = path[2:] if path.startswith("b/") else path
            if path != "/dev/null":
                files.setdefault(path, {"added": [], "hunks": []})
            continue
        if line.startswith("@@"):
            match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            if match and path in files:
                new_line = int(match.group(1))
                files[path]["hunks"].append([(None, line)])
            continue
        if path not in files or not files[path]["hunks"]:
            continue
        hunk = files[path]["hunks"][-1]
        if line.startswith("+"):
            files[path]["added"].append(new_line)
            hunk.append((new_line, line))
            new_line += 1
        elif line.startswith("-"):
            hunk.append((None, line))
        elif line.startswith(" "):
            hunk.append((new_line, line))
            new_line += 1
    return files


def split_hunk(hunk, limit):
    """A single hunk can be enormous — a new file is one hunk — so slice inside it, not just between."""
    header, body = hunk[0], hunk[1:]
    slices, current, added = [], [header], 0
    for entry in body:
        if entry[1].startswith("+") and added >= limit:
            slices.append(current)
            current, added = [header], 0
        current.append(entry)
        if entry[1].startswith("+"):
            added += 1
    if len(current) > 1:
        slices.append(current)
    return slices


def excluded_patterns(root):
    """The `!` patterns under .coderabbit.yaml's path_filters, so one config decides what is reviewed."""
    try:
        with open(os.path.join(root, ".coderabbit.yaml"), encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return EXCLUDED_FALLBACK
    block = re.search(r"^ {2}path_filters:\n((?: {4}.*\n|\n)*)", text, re.M)
    found = tuple(re.findall(r"^ {4}- '(![^']+)'", block.group(1), re.M)) if block else ()
    # An include-list form carries no `!`, so there is nothing to exclude and the fallback holds.
    return found or EXCLUDED_FALLBACK


def is_excluded(path, patterns):
    """fnmatch, not a prefix test: `rust/examples/**` is a pattern, and `**` spans separators here."""
    return any(fnmatch.fnmatch(path, pattern.lstrip("!").replace("**", "*")) for pattern in patterns)


def split_into_chunks(files, patterns):
    """Keep each chunk near MAX_CHUNK_DIFF_LINES: review quality collapses as diffs grow."""
    chunks = []
    for path, data in files.items():
        if is_excluded(path, patterns):
            continue
        pending, added = [], 0
        for hunk in data["hunks"]:
            for slice_lines in split_hunk(hunk, MAX_CHUNK_DIFF_LINES):
                slice_added = sum(1 for entry in slice_lines if entry[1].startswith("+"))
                if pending and added + slice_added > MAX_CHUNK_DIFF_LINES:
                    chunks.append({"path": path, "lines": pending})
                    pending, added = [], 0
                pending.extend(slice_lines)
                added += slice_added
        if pending:
            chunks.append({"path": path, "lines": pending})
    return sorted(chunks, key=chunk_priority)


def chunk_priority(chunk):
    """Source before config before prose: with few chunks, review the most consequential file."""
    is_source = chunk["path"].endswith(SOURCE_SUFFIXES)
    return (0 if is_source else 1, -len(chunk["lines"]))


def render_chunk_lines(lines):
    """The left column is the NEW file's line number, so no model ever has to compute an anchor."""
    rendered = []
    for number, text in lines:
        rendered.append(f"{str(number) if number is not None else '':>6} {text}")
    return "\n".join(rendered)


def rules_for(path, root):
    """The root AGENTS.md plus every one on the path to the file, nearest last — as Codex does."""
    collected, parts = [], path.split("/")[:-1]
    candidates = ["AGENTS.md"] + [f"{'/'.join(parts[: i + 1])}/AGENTS.md" for i in range(len(parts))]
    for relative in candidates:
        full = os.path.join(root, relative)
        if os.path.isfile(full):
            with open(full, encoding="utf-8") as handle:
                collected.append(f"--- {relative} ---\n{handle.read()[:MAX_RULES_CHARS]}")
    return "\n\n".join(collected)


def file_excerpt(path, root):
    full = os.path.join(root, path)
    if not os.path.isfile(full):
        return ""
    with open(full, encoding="utf-8", errors="replace") as handle:
        return handle.read()[:MAX_FILE_CHARS]


def chunk_prompt(chunk, root, extra=""):
    diff = render_chunk_lines(chunk["lines"])
    rules = rules_for(chunk["path"], root)
    excerpt = file_excerpt(chunk["path"], root)
    return (
        f"Repository rules:\n{rules}\n\n"
        f"File: {chunk['path']}\n\n"
        f"Diff (left column is the line number in the new file; use it verbatim as `line`):\n{diff}\n\n"
        f"Full file at head (truncated):\n{excerpt}\n{extra}"
    )


def review_chunk(chunk, allowed, stages, root, budget, label):
    """One chunk's model calls. Splitting these out is what lets a slice run in another process."""
    log(f"chunk {label}: {chunk['path']}")
    summary = None
    if "summarise" in stages:
        summary = parse_json_object(
            complete(
                "summarise", stages["summarise"], SYSTEM_SUMMARISE, chunk_prompt(chunk, root), budget
            )
        )
    extra = f"\nSummary of this change:\n{json.dumps(summary)}\n" if summary else ""
    raw = complete(
        "review", stages["review"], SYSTEM_REVIEW, chunk_prompt(chunk, root, extra), budget
    )
    found = []
    for finding in (parse_json_object(raw) or {}).get("findings", []):
        if isinstance(finding.get("line"), int) and finding["line"] in allowed:
            finding["path"] = chunk["path"]
            found.append(finding)
    # None means no candidate answered at all, which is not the same as a clean chunk.
    return found, raw is not None


def review_slice(work, stages, root, budget, total):
    """A contiguous slice of `work` sharing one budget: a sequential run is the slice of everything.

    `read` counts the chunks a model actually answered, which is not the same as the chunks handed to
    it: a run that is rate limited out reads one of twelve and must not report twelve.
    """
    findings, answered, read = [], False, 0
    for done, (position, chunk, allowed) in enumerate(work):
        if budget.exhausted():
            warn(f"stopping after {done} of {len(work)} assigned chunks — budget spent")
            break
        chunk_findings, chunk_answered = [], False
        try:
            chunk_findings, chunk_answered = review_chunk(
                chunk, set(allowed), stages, root, budget, f"{position + 1}/{total}"
            )
        except Exception as error:
            # One unbuildable prompt must not cost the chunks either side of it their review.
            warn(f"chunk {position + 1} failed: {type(error).__name__}: {error}")
        findings.extend(chunk_findings)
        answered = answered or chunk_answered
        read += 1 if chunk_answered else 0
    return findings, answered, read


def review_in_parallel(work, stages, root, workers, max_requests, deadline_seconds, total):
    """One child process per slice of the work, or None if this platform cannot fork.

    Not threads: `http` bounds a request with SIGALRM, which is process-global and settable only from
    a main thread, so a thread would either lose that bound or refuse to start. Not a process pool
    either, because a pool's queue needs a semaphore and a container can refuse `sem_open` — here,
    that is a fallback to one process rather than a lost review.
    """
    if not hasattr(os, "fork"):
        warn("this platform cannot fork, so the chunks are reviewed one at a time")
        return None
    share = max(1, max_requests // workers)
    size = max(1, (len(work) + workers - 1) // workers)
    slices = [work[at : at + size] for at in range(0, len(work), size)]
    log(f"{len(work)} chunks → {len(slices)} workers, {share} request(s) and one budget each")
    children = []
    for order, piece in enumerate(slices):
        handle, path = tempfile.mkstemp(prefix=f"isa-review-{order}-", suffix=".json")
        os.close(handle)
        pid = os.fork()
        if pid == 0:
            try:
                worker = Budget(share, deadline_seconds)
                found, heard, read = review_slice(piece, stages, root, worker, total)
                with open(path, "w", encoding="utf-8") as result:
                    json.dump(
                        {
                            "findings": found,
                            "answered": heard,
                            "read": read,
                            "answered_by": sorted(worker.answered_by),
                        },
                        result,
                    )
                log(f"worker {order + 1} read {len(piece)} chunk(s), {len(found)} finding(s)")
            except BaseException as error:
                # A worker must never take the run down: `os._exit` skips the parent's own cleanup.
                warn(f"worker {order + 1} failed: {type(error).__name__}: {error}")
            os._exit(0)
        children.append((order, pid, path))
    finish_by = time.monotonic() + deadline_seconds + 60
    for order, pid, _ in children:
        reaped = 0
        while not reaped and time.monotonic() < finish_by:
            reaped = os.waitpid(pid, os.WNOHANG)[0]
            time.sleep(0.2)
        if not reaped:
            warn(f"worker {order + 1} ran past the deadline; its chunks are unreviewed")
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    findings, answered, read, reviewed_by = [], False, 0, set()
    for _, _, path in children:
        try:
            with open(path, encoding="utf-8") as result:
                piece = json.load(result)
        except (OSError, ValueError):
            continue
        finally:
            # The child is reaped, so its result is complete or was never written.
            try:
                os.unlink(path)
            except OSError:
                pass
        findings.extend(piece["findings"])
        answered = answered or piece["answered"]
        read += piece["read"]
        reviewed_by.update(piece.get("answered_by", []))
    return findings, answered, read, reviewed_by


def read_trigger():
    """An empty kind means a pull_request event, not a comment."""
    return {
        "kind": os.environ.get("COMMENT_KIND", "").strip(),
        "id": os.environ.get("COMMENT_ID", "").strip(),
        "body": os.environ.get("COMMENT_BODY", ""),
    }


def parse_command(body, mention=DEFAULT_MENTION):
    """The first line decides, so a quoted command deeper in a reply is not mistaken for one."""
    lines = (body or "").strip().splitlines()
    if not lines:
        return None, ""
    line = lines[0].strip()
    slash = re.match(r"^/([A-Za-z]+)\b\s*(.*)$", line)
    if slash and slash.group(1).lower() in COMMANDS:
        return slash.group(1).lower(), slash.group(2).strip()
    if line.lower().startswith(mention.lower()):
        rest = line[len(mention) :].strip()
        words = rest.split(maxsplit=1)
        if words and words[0].lower() in COMMANDS:
            return words[0].lower(), words[1] if len(words) > 1 else ""
        # A bare mention with a question is the natural way to ask one.
        return "ask", rest
    return None, ""


def already_commented(repo, pr, token):
    """The (path, line, title) triples this account has already commented on.

    Inline comments are not rewritten in place the way the summary is, so without this a re-run of the
    same slice posts the same finding again — which is what the Rust port's first two runs did.
    """
    try:
        login = (http("GET", f"{API}/user", token) or {}).get("login", "")
    except Exception:
        return set()
    if not login:
        return set()
    existing = api(repo, f"/pulls/{pr}/comments?per_page=100", token)
    posted = set()
    for comment in existing if isinstance(existing, list) else []:
        if (comment.get("user") or {}).get("login") != login:
            continue
        title = comment.get("body", "").split("\n", 1)[0].strip("* ").strip()
        posted.add((comment.get("path"), comment.get("line") or comment.get("original_line"), title))
    return posted


def post_comment(repo, pr, token, body, marker=MARKER):
    """Update our own comment rather than stacking one per reply."""
    existing = api(repo, f"/issues/{pr}/comments?per_page=100", token)
    mine = next((comment for comment in existing if marker in comment.get("body", "")), None)
    if mine:
        return api(repo, f"/issues/comments/{mine['id']}", token, method="PATCH", body={"body": body})
    return api(repo, f"/issues/{pr}/comments", token, method="POST", body={"body": body})


def report_failure(args, failure):
    """A run that posted nothing reads as a clean pull request, so say it failed instead."""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token or args.dry_run:
        return
    reason = f"{type(failure).__name__}: {failure}"[:300].replace("\n", " ")
    body = (
        f"{MARKER}\n### Review\n\n"
        f"The review did not complete — `{reason}`.\n\n"
        "**Nothing here has been reviewed**, and no findings were produced. The job log carries the "
        "full warning."
    )
    try:
        post_comment(args.repo, args.pr, token, body)
    except Exception as error:
        # The exit code must not change: a reviewer never decides whether a merge happens.
        warn(f"could not report the failure on the pull request: {type(error).__name__}: {error}")


def reply_to_trigger(repo, pr, token, trigger, body):
    """AGENTS.md: answer a finding in its own thread, never as a top-level comment."""
    if trigger["kind"] == "review" and trigger["id"]:
        return api(
            repo,
            f"/pulls/{pr}/comments/{trigger['id']}/replies",
            token,
            method="POST",
            body={"body": body},
        )
    # A fresh comment, not post_comment: the marker belongs to the summary, which this must not clobber.
    return api(repo, f"/issues/{pr}/comments", token, method="POST", body={"body": body})


def acknowledge(repo, pr, token, trigger):
    """React before working: a command that shows nothing looks broken."""
    if not trigger["id"]:
        return
    base = f"/pulls/comments/{trigger['id']}" if trigger["kind"] == "review" else f"/issues/comments/{trigger['id']}"
    try:
        api(repo, f"{base}/reactions", token, method="POST", body={"content": "eyes"})
    except urllib.error.HTTPError as error:
        warn(f"could not react to the triggering comment ({error.code})")


def answer_question(question, pull, diff_text, root, stages, budget):
    prompt = (
        f"Repository rules:\n{rules_for('AGENTS.md', root)}\n\n"
        f"Pull request: {pull.get('title', '')}\n\n{(pull.get('body') or '')[:4000]}\n\n"
        f"Diff, truncated to {MAX_DIFF_CHARS} characters:\n{diff_text[:MAX_DIFF_CHARS]}\n\n"
        f"Question:\n{question}"
    )
    return complete("ask", stages["review"], SYSTEM_ASK, prompt, budget)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--root", default=".")
    parser.add_argument("--config", default=".github/review_models.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-comments", type=int, default=MAX_COMMENTS)
    parser.add_argument("--max-requests", type=int, default=MAX_REQUESTS)
    parser.add_argument("--deadline-seconds", type=int, default=DEADLINE_SECONDS)
    parser.add_argument("--max-chunks", type=int, default=MAX_CHUNKS)
    parser.add_argument("--chunk-offset", type=int, default=0)
    parser.add_argument("--parallel", type=int, default=PARALLEL)
    try:
        args = parser.parse_args()
    except SystemExit as failure:
        # The workflow comes from the dispatch ref but the reviewer comes from the default branch, so
        # a flag can arrive before the script that understands it. Warn; never fail the job.
        if failure.code:
            warn(f"unusable arguments ({failure}) — is the reviewer older than this workflow?")
        return 0
    try:
        return run(args)
    except Exception as failure:
        # A reviewer must never decide whether a merge happens. See AGENTS.md ("How changes land").
        warn(f"review pipeline failed open: {type(failure).__name__}: {failure}")
        report_failure(args, failure)
        return 0


def run(args):
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    stages = stage_models_for(args.config, args.pr)
    ready = {name for name, candidates in stages.items() if candidates}
    if not token:
        warn("GITHUB_TOKEN is not set — nothing to do")
        return 0

    log(f"stages configured: {sorted(ready) or 'none'}")
    if not ready:
        notice("No model key is configured; add one (e.g. OPENROUTER_API_KEY) to enable reviews.")
        return 0

    pull = api(args.repo, f"/pulls/{args.pr}", token)
    if pull["head"]["repo"] and pull["head"]["repo"]["fork"]:
        notice("Fork PR: the pull_request token is read-only, so no review is posted.")
        return 0

    budget = Budget(args.max_requests, args.deadline_seconds)

    trigger = read_trigger()
    command, argument = None, ""
    if trigger["kind"]:
        command, argument = parse_command(trigger["body"])
        if command is None:
            log("the triggering comment is not addressed to this bot")
            return 0
        log(f"command: {command}")
        acknowledge(args.repo, args.pr, token, trigger)
        if command == "help":
            reply_to_trigger(args.repo, args.pr, token, trigger, HELP_TEXT)
            return 0

    diff_text = fetch_diff(args.repo, args.pr, token)
    if command == "ask":
        answer = answer_question(argument, pull, diff_text, args.root, stages, budget)
        reply_to_trigger(
            args.repo,
            args.pr,
            token,
            trigger,
            answer or "No model answered just now, so I cannot answer that.",
        )
        return 0

    files = changed_lines_by_file(diff_text)
    chunks = split_into_chunks(files, excluded_patterns(args.root))
    total_chunks = len(chunks)
    start, end = args.chunk_offset, args.chunk_offset + args.max_chunks
    if end < total_chunks:
        notice(
            f"{total_chunks} chunks, reviewing {start + 1}-{min(end, total_chunks)}: each chunk costs "
            "a request against the providers' free daily allowances."
        )
    chunks = chunks[start:end]
    if not chunks:
        warn(f"No chunks at offset {start}: this pull request has {total_chunks}.")
    log(
        f"{len(files)} files → {len(chunks)} chunks from offset {start} of {total_chunks}, "
        f"budget {args.max_requests} requests"
    )

    work = [
        (start + offset, chunk, sorted(files[chunk["path"]]["added"]))
        for offset, chunk in enumerate(chunks)
    ]
    findings, answered, read, parallel = [], False, 0, None
    if args.parallel > 1 and len(work) > 1:
        parallel = review_in_parallel(
            work,
            stages,
            args.root,
            args.parallel,
            args.max_requests,
            args.deadline_seconds,
            total_chunks,
        )
    if parallel is None:
        findings, answered, read = review_slice(work, stages, args.root, budget, total_chunks)
        reviewed_by = budget.answered_by
    else:
        findings, answered, read, reviewed_by = parallel
    log(f"{len(findings)} candidate findings")

    verified = False
    if findings and "verify" in stages:
        payload = json.dumps([{k: f.get(k) for k in ("path", "line", "severity", "title", "body")} for f in findings])
        verdicts = parse_json_object(
            complete(
                "verify",
                stages["verify"],
                SYSTEM_VERIFY,
                f"Candidates:\n{payload}",
                budget,
                avoid=reviewed_by,
            )
        )
        if verdicts is None:
            # A verifier that answered nothing must not read as one that refuted everything: dropping
            # the findings here turns an outage into "no issues found", which is the same false clean
            # the review stage avoids by tracking whether anything answered at all.
            warn("verification did not run, so the findings are posted unverified")
        else:
            verified = True
            confirmed = []
            for verdict in verdicts.get("verdicts", []):
                index = verdict.get("index")
                if (
                    isinstance(index, int)
                    and 0 <= index < len(findings)
                    and verdict.get("verdict") == "confirm"
                ):
                    findings[index]["verification"] = verdict.get("reason", "")
                    confirmed.append(findings[index])
            log(f"{len(confirmed)} of {len(findings)} survived verification")
            findings = confirmed

    findings = [f for f in findings if f.get("severity") in SEVERITIES][: args.max_comments]
    log(f"{len(findings)} findings to post")
    if args.dry_run:
        print(json.dumps(findings, indent=1)[:4000])
        return 0

    lines = [MARKER, "### Review", ""]
    if not findings:
        if answered:
            lines.append("No high-confidence issues found in the changed lines.")
        else:
            lines.append(
                "**No model answered, so nothing on this pull request was reviewed.** See the job warnings."
            )
    for finding in findings:
        lines.append(
            f"- **{finding.get('severity', 'medium')}** `{finding['path']}:{finding['line']}` — "
            f"{finding.get('title', '')}"
        )
    if read < total_chunks:
        lines.append("")
        given = (
            f"chunks {start + 1}-{start + len(chunks)}" if chunks else f"no chunks, at offset {start}"
        )
        lines.append(
            f"**{total_chunks - read} of {total_chunks} chunks were not reviewed.** This run was given "
            f"{given} and a model read {read} of them, across {len(files)} changed files."
        )
        if end < total_chunks:
            lines.append(
                f"_Next slice: `gh workflow run review.yml -f pr={args.pr} -f chunk_offset={end}`_"
            )
    if findings and not verified:
        lines.append("")
        lines.append("_The verification stage did not answer, so these findings are unverified._")
    body = "\n".join(lines)[:60000]
    post_comment(args.repo, args.pr, token, body)

    if command == "summary":
        log("summary only: inline comments skipped")
    else:
        head_sha = pull["head"]["sha"]
        comments = [
            {
                "path": finding["path"],
                "line": finding["line"],
                "side": "RIGHT",
                "body": f"**{finding.get('title', '')}**\n\n{finding.get('body', '')}"[:60000],
            }
            for finding in findings
        ]
        already = already_commented(args.repo, args.pr, token) if comments else set()
        fresh = [
            comment
            for comment in comments
            if (comment["path"], comment["line"], comment["body"].split("\n", 1)[0].strip("* ").strip())
            not in already
        ]
        if len(fresh) < len(comments):
            log(f"{len(comments) - len(fresh)} finding(s) already have a comment; not repeating them")
        comments = fresh
        if comments:
            posted = False
            try:
                api(
                    args.repo,
                    f"/pulls/{args.pr}/reviews",
                    token,
                    method="POST",
                    body={"commit_id": head_sha, "event": "COMMENT", "comments": comments},
                )
                posted = True
            except urllib.error.HTTPError as error:
                warn(f"batched inline review rejected ({error.code}); retrying one at a time")
            if not posted:
                # One unanchorable line must not cost the other findings their inline comments.
                for comment in comments:
                    try:
                        api(
                            args.repo,
                            f"/pulls/{args.pr}/reviews",
                            token,
                            method="POST",
                            body={"commit_id": head_sha, "event": "COMMENT", "comments": [comment]},
                        )
                    except urllib.error.HTTPError as error:
                        warn(f"could not anchor {comment['path']}:{comment['line']} ({error.code})")

    if trigger["kind"]:
        outcome = (
            f"Reviewed {len(chunks)} chunk(s) and found {len(findings)} issue(s)"
            if answered
            else "No model answered, so nothing was reviewed"
        )
        reply_to_trigger(args.repo, args.pr, token, trigger, f"{outcome} — see the summary comment.")
    log("posted")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as failure:
        # Last resort: `main` reports its own failures, so this covers what it cannot — a bad
        # invocation, or the reporting itself throwing. A review must never turn the job red.
        warn(f"review pipeline could not run: {type(failure).__name__}: {failure}")
        sys.exit(0)
