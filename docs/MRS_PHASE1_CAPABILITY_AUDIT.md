# MRS Phase 1 — capability audit and scoped delivery (2026-10-13)

Branch: `feature/web-phase1-event-stream`, based on `feature/web-admin-notifications`; no modifications to stable `main`, the 1.0.3 image, NAS volumes, or the candidate's currently published rc.4 tags.

## Code-based observations (not assumptions)

| Question | Evidence in current tree | Phase 1 answer |
| --- | --- | --- |
| Per-search progress callback | `docker/rewards-run.sh` records task/attempt lifecycle; `admin/src/account-launch.mjs` watches LOGIN lines only; upstream pinned sources are built from patches | **Not verified.** No supported per-query progress counter in the custom wrapper. No 15/30 display until precise upstream hooks are implemented and tested. |
| Independent PC/mobile resume | `patches/0001-exit-codes-run-summary-account-filter.patch` adds account filtering (RUN_ACCOUNT_FILTER), not a step runner | **Not verified.** Only account-level retry demonstrated; no safe mobile-only replay contract. |
| Session path persistence | `compose.web.yaml` binds a sessions directory to the rewards container | **Partial.** Bind persists files; the actual Chromium/session restoration semantics require integration testing. |
| Async task lifecycle | `admin/src/agent.mjs` spawns `rewards-ctl run` asynchronously; `docker/rewards-run.sh` owns flock, timeouts and risk STOP | **Verified from code.** Start is an acceptance signal, not a task success event. |
| Durable task state | `admin/src/journal.mjs` saves real run events in SQLite; `state/status.json`, `last-summary.json` are aggregate summaries | **Partial.** Event history exists; safe per-search checkpoint/replay does not. |
| CDP and safe browser control | Docker startup enforces headless Chromium; no authenticated interaction bridge in `admin/src/agent.mjs` | **Not verified.** Do not expose a debugging port or promise manual NAS browser control. |

## Implemented scope

1. Core `GET /events/stream`: authorized SSE from the durable Core `events.sqlite` journal. Supports `Last-Event-ID`, cursor replay, heartbeats and bounded reads.
2. Existing wrapper outputs yield truthful standardized lifecycle events: `task.started`, `task.completed`, `task.failed`, `task.paused`, `task.auth.required`. Original events remain.
3. Web maintains one upstream SSE subscriber with reconnect and last persisted cursor; stores sanitized events in a new `live_events` table in its existing `admin.sqlite`, retaining the latest 2000 items.
4. Authenticated read-only Web routes `GET /api/events/history` and `GET /api/events/live`; the task page gets a real-time event timeline. Existing status/notification APIs remain intact.

**Transport variance**: The approved interface baseline specifies WebSocket for the browser-facing link. This first scoped delivery uses same-origin EventSource (SSE) for browser delivery, which reuses existing admin session authentication and avoids a new dependency or non-reviewed WebSocket upgrade path. It is an explicit Phase 1 deviation, **not** a claim that WebSocket is implemented. Converting the browser transport to authenticated WebSocket requires a separate reviewed change if the baseline is mandatory.

**Not implemented in this phase**: interactive Microsoft login / CDP relay, live per-query search counters, step-level task checkpoints, safe resume-from-search-index, confirmed current login sessions, auto-clearing of risk STOP, changes to rewards algorithm, or actual Microsoft account tests.

## Event semantics

- Each event is sourced from `Journal.add`; `id` monotonically increments in the Core SQLite journal while it remains intact.
- `task.started` means the wrapper accepted execution and recorded a task start, **not** completed login.
- `task.completed` requires the wrapper's recorded `success` outcome, **not** independently verified Rewards balance.
- `task.auth.required` reflects wrapper verification-required evidence, **not** a confirmed challenge type or an account attribution.
- Search step count and login state not individually observed must be shown as **unknown**.

## Test and release gates

- Tests: Core bearer-token guard, SSE event replay, Web durable cursor after restart, no synthetic step events, browser UI evidence status, and legacy regression suite.
- Run `npm ci && npm test` under Node 24, plus Docker/Chromium CI.
- Candidate PR only; **do not publish** on feature PR. Leave the old candidate deployment unchanged until testing is green.
- Real Microsoft authentication and points require separate controlled human validation; do not claim them from offline tests.

## Known limitations to address before full Phase 1 acceptance

- The browser link does not yet use WebSocket as in interface baseline v1.
- Core journal event retention is bounded; a client disconnected beyond retention cannot replay the missing events and must use a separate consistent snapshot or signal a gap.
- No real per-search progress until upstream search-loop instrumentation is introduced.
