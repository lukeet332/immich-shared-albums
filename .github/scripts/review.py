# .github/scripts/review.py — a free re-implementation of the CodeRabbit review pipeline. See review.md.

import argparse
import json
import os
import random
import re
import signal
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
MARKER = "<!-- isa-review-pipeline -->"
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

`{DEFAULT_MENTION} <anything>` also works and is treated as `/ask`, so a plain question reads
naturally. Replies to an inline comment arrive in that comment's own thread.

The automatic review runs on `opened`, `reopened` and `ready_for_review`, not on every push."""
MAX_COMMENTS = 12
SEVERITIES = ("high", "medium")
STAGES = ("summarise", "review", "verify")
# The same generated output .coderabbit.yaml excludes: reviewing compiled bytes wastes a request.
EXCLUDED_PATHS = (
    "package-lock.json",
    "src/web/dist/",
    "src/web/panel.bundle.js",
    "src/web/accept.bundle.js",
    "src/web/share.bundle.js",
)
DEADLINE_SECONDS = 300
MAX_REQUESTS = 4
MAX_CHUNKS = 2
CALL_TIMEOUT_SECONDS = 60
CALL_ATTEMPTS = 1
MAX_OUTPUT_TOKENS = 3000
DEAD_KEY_STATUS_CODES = (401, 402, 403)
DEAD_MODEL_STATUS_CODES = (404, 429)


class Budget:
    """Stops the pipeline outliving either the CI timeout or the provider's daily allowance."""

    def __init__(self, max_requests, deadline_seconds):
        self.requests_left = max_requests
        self.deadline = time.monotonic() + deadline_seconds
        self.dead_providers = set()
        self.dead_candidates = set()

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


def load_stage_models(path):
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
            usable[stage] = candidates
    return usable


def complete(stage, candidates, system, user, budget, max_tokens=MAX_OUTPUT_TOKENS):
    """First candidate that answers wins; a provider failing is not an error, it is a fallback."""
    last_error = None
    for candidate in candidates:
        provider, model = candidate["provider"], candidate["model"]
        identifier = f"{provider}/{model}"
        if provider in budget.dead_providers or identifier in budget.dead_candidates:
            continue
        if budget.exhausted():
            warn(f"{stage}: skipped — this run's budget is spent")
            return None
        base_url, env_name = PROVIDERS[provider]
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": max_tokens,
        }
        for attempt in range(CALL_ATTEMPTS):
            try:
                budget.spend()
                payload = http(
                    "POST",
                    f"{base_url}/chat/completions",
                    os.environ.get(env_name, ""),
                    body=body,
                    timeout=CALL_TIMEOUT_SECONDS,
                )
                if not isinstance(payload, dict) or "choices" not in payload:
                    # Print the provider's own body: a bare KeyError hides what it actually said.
                    raise RuntimeError(f"unexpected response: {str(payload)[:300]}")
                content = payload["choices"][0].get("message", {}).get("content")
                if not content:
                    choice = payload["choices"][0]
                    raise RuntimeError(
                        f"no content (finish_reason={choice.get('finish_reason')}): {str(payload)[:200]}"
                    )
                log(f"  {stage}: {identifier} answered ({len(content)} chars)")
                return content
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:300]
                last_error = f"{identifier} HTTP {error.code}: {detail}"
                if error.code in DEAD_KEY_STATUS_CODES:
                    # The key is dead, so no model behind this provider can answer either.
                    budget.dead_providers.add(provider)
                    warn(f"{stage}: {provider} unusable this run (HTTP {error.code}) — {detail[:120]}")
                    break
                if error.code in DEAD_MODEL_STATUS_CODES:
                    # Only this model is saturated or gone; the next candidate may be fine.
                    budget.dead_candidates.add(identifier)
                    warn(f"{stage}: {identifier} unavailable this run (HTTP {error.code})")
                    break
                time.sleep(2**attempt + random.random())
            except Exception as error:
                last_error = f"{identifier}: {error}"
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


def split_into_chunks(files):
    """Keep each chunk near MAX_CHUNK_DIFF_LINES: review quality collapses as diffs grow."""
    chunks = []
    for path, data in files.items():
        if path.startswith(EXCLUDED_PATHS):
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


def post_comment(repo, pr, token, body, marker=MARKER):
    """Update our own comment rather than stacking one per reply."""
    existing = api(repo, f"/issues/{pr}/comments?per_page=100", token)
    mine = next((comment for comment in existing if marker in comment.get("body", "")), None)
    if mine:
        return api(repo, f"/issues/comments/{mine['id']}", token, method="PATCH", body={"body": body})
    return api(repo, f"/issues/{pr}/comments", token, method="POST", body={"body": body})


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
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "").strip()
    stages = load_stage_models(args.config)
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

    diff_text = api(args.repo, f"/pulls/{args.pr}", token, accept="application/vnd.github.v3.diff")
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
    chunks = split_into_chunks(files)
    if len(chunks) > args.max_chunks:
        notice(
            f"{len(chunks)} chunks, reviewing the first {args.max_chunks}: OpenRouter's free tier "
            "allows 50 requests per day."
        )
        chunks = chunks[: args.max_chunks]
    log(f"{len(files)} files → {len(chunks)} chunks, budget {args.max_requests} requests")

    findings = []
    for index, chunk in enumerate(chunks, start=1):
        if budget.exhausted():
            warn(f"stopping after {index - 1} of {len(chunks)} chunks — budget spent")
            break
        log(f"chunk {index}/{len(chunks)}: {chunk['path']}")
        summary = None
        if "summarise" in stages:
            summary = parse_json_object(
                complete(
                    "summarise",
                    stages["summarise"],
                    SYSTEM_SUMMARISE,
                    chunk_prompt(chunk, args.root),
                    budget,
                )
            )
        extra = f"\nSummary of this change:\n{json.dumps(summary)}\n" if summary else ""
        reviewed = parse_json_object(
            complete(
                "review",
                stages["review"],
                SYSTEM_REVIEW,
                chunk_prompt(chunk, args.root, extra),
                budget,
            )
        )
        allowed = set(files[chunk["path"]]["added"])
        for finding in (reviewed or {}).get("findings", []):
            if isinstance(finding.get("line"), int) and finding["line"] in allowed:
                finding["path"] = chunk["path"]
                findings.append(finding)
    log(f"{len(findings)} candidate findings")

    if findings and "verify" in stages:
        payload = json.dumps([{k: f.get(k) for k in ("path", "line", "severity", "title", "body")} for f in findings])
        verdicts = parse_json_object(
            complete("verify", stages["verify"], SYSTEM_VERIFY, f"Candidates:\n{payload}", budget)
        )
        confirmed = []
        for verdict in (verdicts or {}).get("verdicts", []):
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
        lines.append("No high-confidence issues found in the changed lines.")
    for finding in findings:
        lines.append(
            f"- **{finding.get('severity', 'medium')}** `{finding['path']}:{finding['line']}` — "
            f"{finding.get('title', '')}"
        )
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
        reply_to_trigger(
            args.repo,
            args.pr,
            token,
            trigger,
            f"Reviewed {len(chunks)} chunk(s) and found {len(findings)} issue(s) — see the summary comment.",
        )
    log("posted")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as failure:
        # A reviewer must never decide whether a merge happens. See AGENTS.md ("How changes land").
        warn(f"review pipeline failed open: {type(failure).__name__}: {failure}")
        sys.exit(0)
