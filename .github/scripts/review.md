# .github/scripts/review.md — the review pipeline. Code lives in review.py.

## What it is

A free re-implementation of the shape CodeRabbit uses, run in CI so it has no shared quota. Every
stage is a model call against a provider OpenAI-compatible endpoint; `review.py` holds no vendor SDK.

## Stages

| Stage | Function | Model slot | Purpose |
| --- | --- | --- | --- |
| chunk | `split_into_chunks` | — | keep each review request small |
| summarise | `complete("summarise", …)` | cheap, long context | what changed and where the risk sits |
| review | `complete("review", …)` | strongest available | findings as strict JSON |
| verify | `complete("verify", …)` | **different family** to review | refute anything unsupported |

CodeRabbit routes the same way: an open model summarises, frontier models reason, and verification is
a separate agentic pass.

## Why chunks, and why `MAX_CHUNK_DIFF_LINES` is 120

A 2026 evaluation of five models on 150 samples found F1 falls from **0.657 on diffs under 10 lines to
0.043 on diffs over 150**. Diff size, not model choice, is the dominant predictor of review quality.
`split_into_chunks` therefore starts a new chunk as soon as a file's added lines reach the limit, and
`changed_lines_by_file` keeps the added-line set so a finding can only be anchored where the diff
actually changed something.

## Context given to the review stage

- every `AGENTS.md` from the repository root down to the changed file's directory (`rules_for`), which
  is how Codex applies the same rules
- the changed file at head, truncated to `MAX_FILE_CHARS`
- the chunk's diff, and the summarise output when that stage ran

`SYSTEM_REVIEW` forbids reporting what CI already catches, matching `.coderabbit.yaml`'s
`path_instructions`, and keeps only `high` and `medium` severities (`SEVERITIES`).

## Providers

`PROVIDERS` maps a provider name to its OpenAI-compatible base URL and the environment variable
holding its key. The model per stage and its fallback order live in `.github/review_models.json`. A
provider without a key is skipped at load (`load_stage_models`), and a provider that errors falls
through to the next candidate, so the pipeline runs on whatever subset of keys exists.

Cerebras is called with its native model id (`gpt-oss-120b`), not LiteLLM's prefixed form.

## Fail-open, deliberately

`main` is wrapped so any exception prints a warning and exits 0. A reviewer must never decide whether
a merge happens — the gates stay the fast checks and the two e2e lanes (AGENTS.md, "How changes land").
A broken pipeline is therefore a warning in the run log, not a red check. The cost is that a silent
failure looks like a green job; `--dry-run` and the `::notice::` lines exist for that.

## Known limits

- Fork PRs are skipped: the `pull_request` token is read-only, and `pull_request_target` would hand
  repository secrets to fork code.
- The summary comment is updated in place via `MARKER`, so pushes do not stack comments.
- No linter or SAST output is fed in, unlike CodeRabbit's second context stage. CI runs those; the
  prompt tells the model not to duplicate them.
- Nothing here reads the diff as a whole: cross-file consequences are only visible through each
  chunk's own context.
