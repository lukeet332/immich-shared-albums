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

For a comment event the pull request is not in the payload, so the workflow resolves its number and
head SHA from the API in a step before `actions/checkout`. That SHA is what `file_excerpt` and
`rules_for` read, so a command reviews the tree it was issued against.

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
answer, so rotation spreads load between pull requests, not inside one. The per-run caps stay small
for that reason — the median pull request here changes 92 lines, which is one chunk, so a larger
`MAX_CHUNKS` would buy wall-clock risk and no extra coverage.

A queued free endpoint streams keep-alive whitespace, which resets `urlopen`'s per-socket timeout
indefinitely — a request was observed running past every bound. `http` therefore bounds each request
with `signal.setitimer` and `CALL_TIMEOUT_SECONDS`, because only an alarm measures wall clock.

`MAX_CHUNKS` caps work on a large pull request, and the workflow runs on `opened`, `reopened`,
`ready_for_review` and `synchronize`, so a push is reviewed without anyone asking for it;
`workflow_dispatch` re-runs on demand.

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
variable. `stage_models_for` skips a provider with no key, `complete` falls through its candidate
list on error, and a status in `DEAD_KEY_STATUS_CODES` adds the provider to `Budget.dead_providers`
so the rest of the run does not keep spending requests on it; `DEAD_MODEL_STATUS_CODES` retires only
the one model, because a 429 there says nothing about the provider's other models.

`review.yml` passes all seven key variables to the step, so adding a repository secret is the only
step needed to bring a provider into the chain.

A Cerebras key returns `payment_required` until that account has billing, which is the case this
blacklist exists for.

## Fail-open, deliberately

`main` is wrapped so any exception prints a warning and exits 0: a reviewer must never decide whether
a merge happens, and the gates stay the fast checks and the two e2e lanes (AGENTS.md, "How changes
land"). The cost is that a broken run looks like a green job, so the pipeline warns loudly and
`--dry-run` exists for local checking.

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
