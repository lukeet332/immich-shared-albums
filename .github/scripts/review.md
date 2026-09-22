# .github/scripts/review.md — the review pipeline. Code lives in review.py.

## What it is

A free re-implementation of the shape CodeRabbit uses, run in CI so it has no shared quota. Every
stage is a model call against a provider OpenAI-compatible endpoint; `review.py` holds no vendor SDK.

## Commands

`issue_comment` fires the job on every comment; `parse_command` reads only the first line, and a
comment that names no command returns `None` so an ordinary discussion costs nothing at all. The
first line decides specifically so that quoting a command inside a reply is not mistaken for one.

`read_trigger` tells the two event kinds apart by emptiness: `COMMENT_KIND` is set only for an
`issue_comment`, so an empty kind is a push or a dispatch — a review to run, not a comment to parse.
`acknowledge` and `reply_to_trigger` read the kind back to choose between the review-comment and the
issue-comment endpoints.

The job's own condition admits exactly three ways in, because each carries the pull request
differently: a `pull_request` event (the number is in the payload), a `workflow_dispatch` (only the
`pr` input names it), and a comment on a pull request from a non-bot sender.

| Command | Effect |
| --- | --- |
| `/review` | the full review now, updating the summary and posting inline comments |
| `/summary` | the same review, but only the summary comment is posted |
| `/ask <question>` | one model call answering a question about the pull request |
| `/help` | `HELP_TEXT` |
| `@isa <anything>` | treated as `/ask`, so a bare mention with a question reads naturally |

`acknowledge` reacts with 👀 before the work starts, because a command that shows nothing looks
broken. `reply_to_trigger` answers a review comment **inside its own thread** — AGENTS.md requires
that, and a top-level comment cannot be resolved against a line. Replies to ordinary PR comments are
posted as new comments rather than through `post_comment`, whose marker belongs to the summary.

`DEFAULT_MENTION` is `@isa`, and there is a real GitHub account by that name — so a mention is a local
alias that GitHub renders as a link to a stranger, and `HELP_TEXT` says so rather than recommending
it. The slash commands are the interface to use; the mention stays because it reads naturally in a
question and `parse_command` treats it as `/ask`.

For a comment event the pull request is not in the payload, so the workflow resolves its number and
head SHA from the API in a step before `actions/checkout`. That SHA is what `file_excerpt` and
`rules_for` read, so a command reviews the tree it was issued against.

`review.py` and `review_models.json` are the exception, and they come from the **default branch**: a
step fetches them into `.review-tool` and the run uses those, while `--root` still points at the pull
request's tree. Two reasons, one of which cost a review of the Rust port — that branch was cut before
`fetch_diff` existed, so the dispatch that was meant to review it ran the old script and hit the same
406 the fix had already handled. The other is that a pull request editing `review.py` would otherwise
be choosing how it is reviewed, with the provider keys in scope. If the default branch cannot be read
the run falls back to the pull request's copy and warns rather than going red. The same split is why
`main` catches a rejected argument list: a flag can arrive before the script that understands it, and
a warning is the right answer to that rather than a failed job.

`concurrency` sits on the job, not the workflow, and its group carries the event name: a comment the
job's own condition skips must not take the group at all, or a bot's comment cancels the review it
was just posted against, and a comment must not cancel an in-flight push review.

## The budget is requests, not tokens

OpenRouter's free tier allows **50 free-model requests per UTC day** (`free_model_daily_requests` on
`GET /api/v1/key`), the smallest allowance in the chain, and this repo pushes far more often than
that. Every other provider here has its own daily cap, so `Budget` counts requests as well as wall
clock: `MAX_REQUESTS` per run, `DEADLINE_SECONDS` overall, and the loop stops starting chunks once
either is spent rather than being killed mid-run by the job timeout. `DEADLINE_SECONDS` is set below
the workflow's `timeout-minutes` so the pipeline always reaches the code that posts.

Rotation is what stops the caps being reached one provider at a time: `rotate` shifts each stage's
candidate list by the pull request number, so PR #137 opens on a different provider from PR #136. The
allowance added up across the chain is what buys per-push review — 500 requests a day on
`gemini-3.1-flash-lite`, 1,000 on `openai/gpt-oss-120b` through Groq, 14,400 on `gemma-3-27b-it` —
against this repo's ~10 pull requests a day averaging 4 commits, at up to two requests per push.

A run does not split one review across providers: `complete` walks its list and stops at the first
answer, so rotation spreads load between pull requests, not inside one. For the same reason
`MAX_REQUESTS` and `MAX_CHUNKS` are outer bounds rather than targets — `DEADLINE_SECONDS` is what
actually stops a large pull request — and `workflow_dispatch` takes `max_chunks`, `max_requests`,
`chunk_offset` and `deadline_seconds` overrides, because four chunks is not a review of a 225-chunk
diff and the caps should not have to move for one.

A queued free endpoint streams keep-alive whitespace, which resets `urlopen`'s per-socket timeout
indefinitely — a request was observed running past every bound. `http` therefore bounds each request
with `signal.setitimer` and `CALL_TIMEOUT_SECONDS`, because only an alarm measures wall clock.

`MAX_CHUNKS` caps work on a large pull request, and the workflow runs on `opened`, `reopened`,
`ready_for_review` and `synchronize`, so a push is reviewed without anyone asking for it;
`workflow_dispatch` re-runs on demand, and takes the slice and budget it should use.

## Stages

| Stage | Function | Configured | Purpose |
| --- | --- | --- | --- |
| chunk | `split_into_chunks` | always | keep each review request small |
| summary | `rules_for` | always | the applicable `AGENTS.md`, no model call |
| review | `complete("review", …)` | yes | findings as strict JSON |
| summarise | `complete("summarise", …)` | **no** | dropped: it doubles the request count |
| verify | `complete("verify", …)` | yes | refute anything unsupported |

CodeRabbit routes a cheap summariser before its reasoning models; here a stage only runs when
`review_models.json` lists it, because each one costs a request against a provider's daily allowance.
Add `"summarise"` back to that file to enable it.

## Why chunks, and why `MAX_CHUNK_DIFF_LINES` is 120

A 2026 evaluation of five models on 150 samples found F1 falls from **0.657 on diffs under 10 lines to
0.043 on diffs over 150**. Diff size, not model choice, is the dominant predictor of review quality.
`split_hunk` slices **inside** a hunk as well as between them — a new file is one hunk — and
`changed_lines_by_file` keeps the added-line set so a finding can only be anchored where the diff
actually changed something.

`split_into_chunks` takes its exclusions from `.coderabbit.yaml`'s `path_filters` rather than a list
of its own (`excluded_patterns`), matched with `is_excluded`. That config already encodes which files
are not worth review budget — generated bundles, the lockfile, and on the Rust port's branch
`rust/examples/**` and the two benchmark scripts — so both reviewers spend their file budget on the
same files, and the rule has one home. An include-list form of `path_filters` excludes nothing, which
is also what an unreadable config falls back to (`EXCLUDED_FALLBACK`).

## A pull request too large to have a diff

GitHub serves no unified diff over `GITHUB_DIFF_LINE_LIMIT` (20,000) lines: the request comes back
**406**, which is not a review of zero findings but no review at all. `fetch_diff` catches that one
status and rebuilds a diff from `GET /pulls/{n}/files` (`diff_via_files`), which has no line limit —
`FILES_PER_PAGE` per page, `MAX_DIFF_FILES` in total, warning about files that carry no patch at all
because they are binary or too large. The rebuilt text uses the same `+++`/`@@` shape
`changed_lines_by_file` already parses, and the two forms are equivalent: the added-line sets and hunk
headers are identical to the ones the real diff produces.

The Rust port's pull request is the case that found this — 25,629 added lines, 118 files, 248 chunks.

## Reading a diff larger than one run

Rebuilding the diff removes GitHub's ceiling but not the wall clock: 225 chunks at roughly 50 seconds
each is three hours of model calls, and the free endpoints start answering 429 long before that.
`chunk_offset` is what makes such a diff reviewable at all — a dispatch reads `max_chunks` chunks
starting there, and the summary states the slice and prints the next command to run:

```
gh workflow run review.yml -f pr=131 -f chunk_offset=4
```

`deadline_seconds` is exposed for the same reason and raises the job's ceiling to 45 minutes; the
automatic 900 seconds still governs every push, because a review that has not posted by then is worth
less than the next push starting.

Two things to know before slicing. The order is deterministic for one head SHA — `split_into_chunks`
sorts by `chunk_priority`, ties broken by the diff's own file order — but a push renumbers the
offsets, so slices are only coherent against a fixed head. And an offset past the end reviews nothing
and says so: the summary reports `0 of 12 chunks from offset 12` rather than a clean pull request.

## Workers, because the free endpoints are the slow part

A chunk spends most of its time waiting on a queued free endpoint, so `--parallel` divides the run's
chunks between child processes: `review_in_parallel` forks one child per contiguous slice, each with
its own `Budget`, and `max_requests` is **divided** between them (`max(1, max_requests // parallel)`
each). Parallelism therefore spends the same budget in less wall clock rather than spending more —
which is the only lever that matters, since the request allowances were never the binding constraint.

`PARALLEL` is 2 by default — an automatic four-chunk review is two chunks per worker, which is what
fits inside `DEADLINE_SECONDS` now that a chunk takes minutes rather than seconds. At 1 `run` calls
`review_slice` in its own process, which is exactly what it did before there was a worker path at all.

Processes rather than threads, for a specific reason: `http` bounds a request with
`signal.setitimer(SIGALRM)`, and a signal is process-global and can only be installed from a main
thread. A thread pool would either lose that bound — the bug that once let a queued endpoint run for
ten minutes — or refuse to start. `os.fork` rather than `ProcessPoolExecutor` for a second reason: a
pool's queue needs a semaphore, `sem_open` can be refused inside a container, and a review that
degrades to one process is worth more than one that fails to start.

What the parent guarantees:

- **Order.** Results are collected in slice order, so the summary lists findings by `chunk_priority`
  however the workers happened to finish.
- **Isolation.** `review_slice` catches per chunk, so one unbuildable prompt costs its own chunk and
  not the chunks either side of it — in the sequential path too, where such an error used to end the
  run before anything posted. A child that still fails warns and contributes nothing.
- **A bound.** A child that outlives `deadline_seconds + 60` is killed with `SIGKILL` and its chunks
  are reported unreviewed, rather than the job hanging until `timeout-minutes`.
- **A fallback.** No `os.fork` on the platform means a warning and one process, never a lost review.

A whole Rust port — 182 chunks of `rust/src` — is 8 workers reading ~23 chunks each, about 20 minutes:

```
gh workflow run review.yml -f pr=131 -f max_chunks=182 -f max_requests=200 -f parallel=8 -f deadline_seconds=2400
```

## Model choice

Review opens on `gemini-3.1-flash-lite` — a code model on a 500-requests-a-day free allowance — then
`openai/gpt-oss-120b` through Groq (1,000 a day), then `gemma-3-27b-it` (14,400 a day), then
OpenRouter's own `openrouter/free` router, whose 50 a day is the smallest allowance in the chain.
Verification names the same providers in the same order one entry further round, so `verify` and
`review` never open on the same provider.

`rotate(candidates, seed)` shifts a stage's list by the pull request number, so successive pull
requests start on different providers and one daily cap is not drained before the others are touched.
Both stages rotate by the same seed, which is why `review_models.json`'s `verify` list is `review`'s
list shifted by one: the shift composes with the rotation instead of being undone by it.

The lists walk the same circular provider sequence, so a candidate that is out of allowance is
skipped without stalling the run: the wrap from the last entry lands on a different provider than the
one that just failed, which is why `openrouter/free` can sit in the rotation despite its small cap.

The chain exists because a single free endpoint is not reliable. Observed on OpenRouter's free tier:
`ResourceExhausted: Worker local total request limit reached (16/16)` from NVIDIA,
`is temporarily rate-limited upstream` from Qwen, and repeated wall-clock deadline hits on Cohere and
`openrouter/free`. `complete` walking its candidate list turns a saturated model into a slower
review rather than a failed one, and when every candidate fails the run still posts — with no
findings, which `main` reports as such.

An entry is inert until its provider has a key: `stage_models_for` drops candidates whose key is
unset, so a missing secret shortens the chain rather than failing a review. `GEMINI_API_KEY` and
`GROQ_API_KEY` are the two that widen it today.

Going direct to a provider's own endpoint avoids OpenRouter's shared free pool. `PROVIDERS` also
reaches `integrate.api.nvidia.com`, `api.mistral.ai` and `api.sambanova.ai`, so a key for any of them
is added to `review_models.json` without touching the script; the order inside that file is what
decides which allowance is spent first.

`chunk_priority` puts source before config before prose, so with `MAX_CHUNKS` at 4 the files reviewed
are the consequential ones rather than whichever sorted first.

`CALL_ATTEMPTS` is 1: a queued free endpoint does not answer faster on retry, and each retry is
another request against the daily allowance. The one retry that does pay is a different shape and is
handled separately — see the token budget below.

## The token budget is a reasoning budget

`MAX_OUTPUT_TOKENS` was 3,000, which suited the fast code model the chain used to open on and fails
every reasoning model in it now. Measured on `rust/src/config.rs` of the Rust port, a 6,451-token
prompt against a reasoning model:

| `max_tokens` | `finish_reason` | completion | of which reasoning | content |
| --- | --- | --- | --- | --- |
| 3,000 | `length` | 3,000 | 3,000 | **0 chars** |
| 16,000 | `stop` | 9,516 | 9,398 | 480 chars |

`length` with empty content is not a model with nothing to say; it is a model cut off mid-thought
before it wrote a word, and it used to read as "no provider answered" and spend a request. So
`complete` doubles the room once when it sees exactly that (`MAX_OUTPUT_ROOM` caps the doubling at
32,000, and a chunk that still cannot answer stops there), and `CALL_TIMEOUT_SECONDS` is 240 because
those 9,398 reasoning tokens take minutes, not the 60 seconds a non-reasoning model needed.

The chain is affected unevenly: `gemma-3-27b-it` writes content immediately, `gemini-3.1-flash-lite`
and `openai/gpt-oss-120b` think first, and OpenRouter's free router lands on whatever reasoner is
free — observed: `inclusionai/ling-3.0-flash-vl`, `nex-agi/nex-n2.5-mini`. Groq's 8,000 tokens per
minute also means a reasoning model there will 429 on a large chunk and fall through to the next
candidate, which is the chain doing its job rather than a fault.

`usage` is in the warning for exactly this reason: `finish_reason` alone once cost an afternoon.

## Context given to the review stage

- every `AGENTS.md` from the repository root down to the changed file's directory (`rules_for`)
- the changed file at head, truncated to `MAX_FILE_CHARS`
- the chunk's diff, with the new file's line number in the left column (`render_chunk_lines`) so no
  model has to compute an anchor

`SYSTEM_REVIEW` forbids reporting what CI already catches, matching `.coderabbit.yaml`'s
`path_instructions`, and keeps only `high` and `medium` severities (`SEVERITIES`).

## Providers

`PROVIDERS` maps a provider name to its OpenAI-compatible base URL and the key's environment
variable. `stage_models_for` skips a provider with no key, `complete` falls through its candidate
list on error, and a status in `DEAD_KEY_STATUS_CODES` adds the provider to `Budget.dead_providers`
so the rest of the run does not keep spending requests on it; `DEAD_MODEL_STATUS_CODES` retires only
the one model, because a 429 there says nothing about the provider's other models.

`review.yml` passes all seven key variables to the step, so adding a repository secret is the only
step needed to bring a provider into the chain.

A Cerebras key returns `payment_required` until that account has billing, which is the case this
blacklist exists for.

## Fail-open, deliberately

`main` parses the arguments and hands them to `run`; any exception from `run` prints a warning, calls
`report_failure` and returns 0. A reviewer must never decide whether a merge happens, and the gates
stay the fast checks and the two e2e lanes (AGENTS.md, "How changes land").

Silence is the failure mode that matters here, because a run that posted nothing is indistinguishable
from a clean pull request — which is how a 406 on the Rust port's pull request produced no review at
all and nobody noticed. So `report_failure` writes the reason into the same summary comment
`post_comment` maintains, and the summary distinguishes three outcomes: findings, a clean result
(`answered`), and **no model answered, so nothing was reviewed**. When `total_chunks` exceeded
`MAX_CHUNKS` the summary also states the scope it did read, because "no findings" over four of 248
chunks is not the same claim as no findings.

`verify` is held to the same rule, one stage further in. `verdicts is None` means the verifier
answered nothing, which is not the same as refuting everything — dropping the candidates there turns
an outage into "no issues found" — so the findings are kept and the summary says they are unverified.
An answered `{"verdicts": []}` is the verifier working and finding nothing worth confirming, and that
does drop them.

## Known limits

- Fork PRs are skipped: the `pull_request` token is read-only, and `pull_request_target` would hand
  repository secrets to fork code. A `workflow_dispatch` run on one fails earlier, at
  `actions/checkout`, because the resolve step checks out the pull request's head SHA and a fork's
  commit is not in this repository.
- The summary comment is updated in place via `MARKER`, so re-runs do not stack comments.
- No linter or SAST output is fed in, unlike CodeRabbit's second context stage. CI runs those, and
  the prompt tells the model not to duplicate them.
- Nothing reads the diff as a whole: cross-file consequences are only visible through each chunk's
  own context.
