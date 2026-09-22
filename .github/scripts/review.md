# .github/scripts/review.md — the review pipeline. Code lives in review.py.

## What it is

A free re-implementation of the shape CodeRabbit uses, run in CI so it has no shared quota. Every
stage is a model call against a provider OpenAI-compatible endpoint; `review.py` holds no vendor SDK.

## Commands

`issue_comment` fires the job on every comment; `parse_command` reads only the first line, and a
comment that names no command returns `None` so an ordinary discussion costs nothing at all. The
first line decides specifically so that quoting a command inside a reply is not mistaken for one.

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

For a comment event the pull request is not in the payload, so the workflow resolves its number and
head SHA from the API in a step before `actions/checkout`. That SHA is what `file_excerpt` and
`rules_for` read, so a command reviews the tree it was issued against.

## The budget is requests, not tokens

OpenRouter's free tier allows **50 free-model requests per UTC day** (`free_model_daily_requests` on
`GET /api/v1/key`), and this repo pushes far more often than that. `Budget` therefore counts requests
as well as wall clock: `MAX_REQUESTS` per run, `DEADLINE_SECONDS` overall, and the loop stops
starting chunks once either is spent rather than being killed mid-run by the job timeout.
`DEADLINE_SECONDS` is set below the workflow's `timeout-minutes` so the pipeline always reaches the
code that posts.

A queued free endpoint streams keep-alive whitespace, which resets `urlopen`'s per-socket timeout
indefinitely — a request was observed running past every bound. `http` therefore bounds each request
with `signal.setitimer` and `CALL_TIMEOUT_SECONDS`, because only an alarm measures wall clock.

`MAX_CHUNKS` caps work on a large pull request, and the workflow runs on `opened`, `reopened` and
`ready_for_review` — deliberately not `synchronize` — with `workflow_dispatch` for a re-run on
demand. Paying the one-time $10 on OpenRouter raises the cap to 1,000 requests/day and would allow
`synchronize` back.

## Stages

| Stage | Function | Configured | Purpose |
| --- | --- | --- | --- |
| chunk | `split_into_chunks` | always | keep each review request small |
| summary | `rules_for` | always | the applicable `AGENTS.md`, no model call |
| review | `complete("review", …)` | yes | findings as strict JSON |
| summarise | `complete("summarise", …)` | **no** | dropped: it doubles the request count |
| verify | `complete("verify", …)` | yes | refute anything unsupported |

CodeRabbit routes a cheap summariser before its reasoning models; here a stage only runs when
`review_models.json` lists it, because each one costs a request from a 50/day allowance. Add
`"summarise"` back to that file to enable it.

## Why chunks, and why `MAX_CHUNK_DIFF_LINES` is 120

A 2026 evaluation of five models on 150 samples found F1 falls from **0.657 on diffs under 10 lines to
0.043 on diffs over 150**. Diff size, not model choice, is the dominant predictor of review quality.
`split_hunk` slices **inside** a hunk as well as between them — a new file is one hunk — and
`changed_lines_by_file` keeps the added-line set so a finding can only be anchored where the diff
actually changed something.

## Model choice

Review prefers `cohere/north-mini-code:free` (a code model, measured at 0.7s), then
`qwen/qwen3.8-27b:free`, then the Nemotron nano, then OpenRouter's own `openrouter/free` router.
Verification uses a different vendor from review's primary — `qwen/qwen3.8-27b:free`, then
`nex-agi/nex-n2.5-pro:free`.

The chain exists because a single free endpoint is not reliable. Observed on OpenRouter's free tier:
`ResourceExhausted: Worker local total request limit reached (16/16)` from NVIDIA,
`is temporarily rate-limited upstream` from Qwen, and repeated wall-clock deadline hits on Cohere and
`openrouter/free`. `complete` walking its candidate list turns a saturated model into a slower
review rather than a failed one, and when every candidate fails the run still posts — with no
findings, which `main` reports as such.

Going direct to a provider's own endpoint avoids OpenRouter's shared free pool: an `NVIDIA_API_KEY`
from `build.nvidia.com` reaches the same Nemotron models through `integrate.api.nvidia.com`, so put
`nvidia` first in the candidate lists and `openrouter` behind it. OpenRouter's own message points the
same way — "add your own key to accumulate your rate limits".

`chunk_priority` puts source before config before prose, so with `MAX_CHUNKS` at 2 the files
reviewed are the consequential ones rather than whichever sorted first.

`CALL_ATTEMPTS` is 1: a queued free endpoint does not answer faster on retry, and each retry is
another request against the daily allowance.

## Context given to the review stage

- every `AGENTS.md` from the repository root down to the changed file's directory (`rules_for`)
- the changed file at head, truncated to `MAX_FILE_CHARS`
- the chunk's diff, with the new file's line number in the left column (`render_chunk_lines`) so no
  model has to compute an anchor

`SYSTEM_REVIEW` forbids reporting what CI already catches, matching `.coderabbit.yaml`'s
`path_instructions`, and keeps only `high` and `medium` severities (`SEVERITIES`).

## Providers

`PROVIDERS` maps a provider name to its OpenAI-compatible base URL and the key's environment
variable. `load_stage_models` skips a provider with no key, `complete` falls through its candidate
list on error, and a status in `DEAD_STATUS_CODES` adds the provider to `Budget.dead_providers` so
the rest of the run does not keep spending requests on it.

A Cerebras key returns `payment_required` until that account has billing, which is the case this
blacklist exists for.

## Fail-open, deliberately

`main` is wrapped so any exception prints a warning and exits 0: a reviewer must never decide whether
a merge happens, and the gates stay the fast checks and the two e2e lanes (AGENTS.md, "How changes
land"). The cost is that a broken run looks like a green job, so the pipeline warns loudly and
`--dry-run` exists for local checking.

## Known limits

- Fork PRs are skipped: the `pull_request` token is read-only, and `pull_request_target` would hand
  repository secrets to fork code.
- A `workflow_dispatch` run checks out the default branch, so `file_excerpt` and `rules_for` read
  that ref while the diff still comes from the requested pull request.
- The summary comment is updated in place via `MARKER`, so re-runs do not stack comments.
- No linter or SAST output is fed in, unlike CodeRabbit's second context stage. CI runs those, and
  the prompt tells the model not to duplicate them.
- Nothing reads the diff as a whole: cross-file consequences are only visible through each chunk's
  own context.
