# Synapser

Supervised multi-agent execution on top of [Zoanthrope](https://github.com/spuentesp/zoanthrope):
a coordinator that lets several agents — Nemotron loops and third-party CLIs — work on one repository
**without losing each other's work**, and an audit layer that can answer *what did each agent do, when,
why, and at what cost* with a hash-chained, deterministic ledger.

Design: `design/Synapser_Diseno.docx` (v0.3) and `docs/plans/` (contracts, invariants, proof obligations).

## What it does

| Capability | Where |
|---|---|
| Sole-writer **executor**: claims via Zoanthrope, content digests, atomic apply, crash recovery (roll-forward only) | `src/executor/`, `src/journal/`, `src/recovery/` |
| **Orchestration**: agent catalog with known / estimated / unknown cost, deterministic router (the model only suggests), approval gates bound to the plan digest, agent-requested subtasks as additive plan revisions | `src/orchestration/` |
| **Agents behind one port**: native Nemotron loop on Nebius Token Factory, one-shot CLIs (claude, codex, kimi) in isolated copies landed by a patch broker | `src/agents/`, `src/agent/` |
| **Research**: Tavily port with an outbound query guard and "no citation without retrieval" | `src/research/` |
| **Audit**: hash-chained ledger, deterministic queries (who changed / why / cost / waste / coordination), offline-verifiable export, optional LangSmith exporter | `src/audit/` |
| **Observation**: read-only Zoanthrope collector with declared gaps, declared intentions, live swarm state reproducible by `seq` | `src/zoo/`, `src/audit/state.ts` |
| **UI + API**: React + Tailwind + shadcn/ui over a dependency-free HTTP API (SSE) | `web/`, `src/api/` |
| **Executable invariants** (I1–I5, W1–W5, Z3–Z4, U1–U5) and a no-coordination control behind the same port | `src/audit/invariants.ts`, `src/orchestration/invariants.ts`, `src/bench/` |

## Run

Node ≥ 24 (TypeScript runs through native type stripping; the core has no runtime dependencies).

```console
$ npm install
$ export ZOANTHROPE_BIN=/abs/path/to/zoanthrope      # the real binary, not the npm wrapper
$ npm run typecheck && npm test

# the UI (React + Tailwind + shadcn/ui) is a build artifact served by the API
$ npm run web:install && npm run web:build

# offline demo: a full mission with scripted agents, a human gate and the UI
$ node scripts/demo.ts --port 4173

# live demo: Nemotron plans and works, a real CLI reviews, Tavily is available
$ cp .env.example .env   # NEBIUS_API_KEY (alias NEBIUS_TOKEN), TAVILY_API_KEY
$ node --env-file=.env scripts/demo-live.ts --mission billing
$ node --env-file=.env scripts/demo-live.ts --mission currency   # needs sources retrieved in this run
```

Audit a finished run from the command line:

```console
$ node src/audit/cli.ts --state <stateDir> --run <runId> verify | timeline | who-changed <path> | why <actionId> | cost | waste | coordination
$ node scripts/verify-export.ts <run>.ledger.json     # verifies an export with no database and no server
```

## Layout

- `src/zoo/` — MCP stdio transport and typed adapter; read-only collector; intent announcement.
- `src/digest/`, `src/journal/`, `src/executor/` — content identity, SQLite journal, the sole writer.
- `src/model/`, `src/agent/`, `src/agents/` — model port with role routing, the agent loop, runners and broker.
- `src/mission/`, `src/orchestration/`, `src/validation/` — planner, scheduler, router, gates, delegation, isolated validation.
- `src/research/` — research port, guard, session, citations.
- `src/audit/`, `src/api/` — ledger, queries, invariants, state projection, HTTP API.
- `web/` — the observation UI. `fixtures/` — missions with independent oracles.
- `.claude/skills/` — project skills for the UI stack (shadcn/ui, React, Tailwind), pinned by `skills-lock.json`.
