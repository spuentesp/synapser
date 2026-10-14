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

Connect an agent over MCP (stdio) and drive Synapser as a command centre:

```console
$ cat > synapser.config.json <<'JSON'
{ "workspace": "/abs/path/to/repo", "stateDir": "/abs/path/to/.synapser-state",
  "startRequiresApproval": true,
  "commands": [ { "id": "tests", "argv": ["python3", "-m", "unittest", "discover"], "timeoutMs": 60000 } ] }
JSON
$ claude mcp add synapser -- node /abs/path/to/synapser/src/cli/main.ts mcp --config /abs/path/to/synapser.config.json
# the agent now has workflow_create / workflow_start / workflow_status / gate_list / gate_approve / catalog_list …
$ node src/cli/main.ts gate list            # you, in the console: what is waiting for a human
$ node src/cli/main.ts gate show <wf> start # the one-time code you may give the agent to relay an approval
$ node src/cli/main.ts gate approve <wf> start
```

Audit a finished run from the command line:

```console
$ node src/audit/cli.ts --state <stateDir> --run <runId> verify | timeline | who-changed <path> | why <actionId> | cost | waste | coordination
$ node scripts/verify-export.ts <run>.ledger.json     # verifies an export with no database and no server
```

## Configure from the console

`synapser serve` (or `scripts/sandbox.sh`) opens the console at `http://127.0.0.1:<port>/`.

- **Home** shows what is active, which gates wait for a person, which agents are enabled, and the accumulated cost of
  agent runs and the planner, as the Cost view counts it. A run without a recorded cost is counted apart, never as zero.
- **Workflows** has a form that builds a workflow. The draft is checked live by the server's own validator, which
  writes nothing, and *Save* is enabled only for a document that validator accepts. Four built-in templates fill the
  form from their parameters. The advisor's interventions and the requested effects are shown in the workflow's
  detail; decisions are taken in Approvals.
- **Library** holds providers, agents, skills and templates as versioned documents. A refused document lists every
  problem at once. *Test connection* calls a stored provider's endpoint with its key; the report names the environment
  variable the key came from and never shows the key. Limits: a library provider may use only the key names listed in
  `providerKeyEnv` in the configuration file (empty by default), and a listed key can still be sent to any https address
  that a library provider names. A local process that can read the console's session token can write such a provider.
  A page from another site cannot. This is declared in the design document (section 40) and is not yet closed.

Runs read the library. A run takes the providers and agents as they are when it starts, checks them against the
configuration file as it stands, and does not start if any of them no longer holds, with every reason. A library agent
either extends a built-in or file profile and changes a few of its fields (never its commands, its home or its
permissions), or is a native agent with its own provider and model. A workflow whose reviews name an agent the library
does not hold fails at its start, with the reason. Library skills reach an agent when the configuration file lists them under `agentSkills` (at most five per agent).
The file decides which skill each agent gets; the library only supplies the text, and the run records its digest
(decision D6, plan 15). The system roles (planner, advisor, chat, worker, repair) are still assigned in
`synapser.config.json` under `roles`, and `synapser provider test <id>` checks a configured provider from the terminal.

## Layout

- `src/zoo/` — MCP stdio transport and typed adapter; read-only collector; intent announcement.
- `src/digest/`, `src/journal/`, `src/executor/` — content identity, SQLite journal, the sole writer.
- `src/model/`, `src/agent/`, `src/agents/` — model port with role routing, the agent loop, runners and broker.
- `src/mission/`, `src/orchestration/`, `src/validation/` — planner, scheduler, router, gates, delegation, isolated validation.
- `src/research/` — research port, guard, session, citations.
- `src/audit/`, `src/api/` — ledger, queries, invariants, state projection, HTTP API.
- `web/` — the observation UI. `fixtures/` — missions with independent oracles.
- `.claude/skills/` — project skills for the UI stack (shadcn/ui, React, Tailwind), pinned by `skills-lock.json`.
