# synapser

Supervised multi-agent execution on top of [Zoanthrope](https://github.com/spuentesp/zoanthrope).
Design: `design/Synapser_Diseno.docx` (v0.2).

## Status (day 17: digests + journal done; plans in `docs/plans/`)

| Piece | State |
|---|---|
| G0 pinned binary (0.1.3 @ 37ecffa, SHA-256) | `npm run gate:g0` |
| G1 adapter vs. real binary | `test/zoo/g1-adapter.test.ts` |
| S13 timeout → quarantine → reconcile | `test/zoo/s13-timeout.test.ts` |
| S15 path containment (before any claim) | `test/workspace/paths.test.ts` |
| Mission fixture + independent oracle | `fixtures/billing`, `test/fixture-oracle.test.ts` |
| Digests (file, request, state, edits) | `src/digest/`, `test/digest/` |
| Journal SQLite, transitions, artifacts, workspace lock (S17, S17b) | `src/journal/`, `test/journal/` |
| Action protocol + executor, crash recovery, startup sequence | `src/executor/`, `src/recovery/`, `src/startup.ts` |
| Model port (Token Factory / Nemotron), budget, call journal | `src/model/`, `test/live` |
| Agent loop (tools ↔ executor, bounded, injection-safe) | `src/agent/`, `test/agent`, `test/live` |
| Supervisor/planner, scheduler, local validation runner (no network) | `src/mission/`, `src/validation/` |
| Tavily research port, Sandboxes runner, UI, A/B evaluation | not started |

## Run

```console
$ npm install
$ export ZOANTHROPE_BIN=/abs/path/to/zoanthrope   # real binary, not the npm wrapper
$ npm run typecheck && npm test
```

Node ≥ 24 (TypeScript runs via native type stripping; no build step, no runtime deps).

## Live results (13 Oct 2026, small n)

Discount mission, 3 concurrent agents sharing one file, accepted only by unit tests + an independent oracle:
Super 120B as worker completed 4/5 runs (~$0.035, ~30 s); a supervisor-planned run completed in 49.7 s (~$0.028).
Details and failure modes: `docs/plans/06-integracion-nebius-nvidia.md` §15. Reproduce: `node --env-file=.env scripts/mission-bench.ts --runs 5`.

## Layout

- `src/zoo/` — MCP stdio transport (one call in flight, kill-and-confirm on timeout) and typed adapter.
- `src/digest/` — one module for every content hash, canonical JSON, edit resolution.
- `src/journal/` — SQLite journal (CAS transitions, append-only events, DB-enforced invariants), blob store, workspace lock.
- `src/workspace/paths.ts` — `WorkspacePath` brand; the adapter only accepts values from `resolveInWorkspace`.
- `fixtures/billing/` — baseline repo, acceptance oracle, reference solution (proves the oracle is satisfiable).
