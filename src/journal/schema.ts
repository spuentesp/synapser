import { ACTION_STATES, ACTION_TRANSITIONS } from "./transitions.ts";

export const SCHEMA_VERSION = 1;

const states = ACTION_STATES.map((s) => `'${s}'`).join(",");

export const SCHEMA_SQL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE missions(
  run_id TEXT PRIMARY KEY, objective TEXT NOT NULL, repo TEXT NOT NULL, base_sha TEXT NOT NULL,
  plan_revision INTEGER NOT NULL, limits_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','RUNNING','PAUSING','PAUSED','DONE','FAILED','CANCELLED')),
  created_at INTEGER NOT NULL) STRICT;

CREATE TABLE plan_revisions(
  run_id TEXT NOT NULL REFERENCES missions, revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL, accepted_at INTEGER, PRIMARY KEY(run_id, revision)) STRICT;

CREATE TABLE tasks(
  run_id TEXT NOT NULL REFERENCES missions, task_id TEXT NOT NULL, actor_owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','READY','RUNNING','WAITING_RESOURCE',
    'RECOVERY_REQUIRED','VALIDATING','DONE','FAILED','CANCELLED')),
  priority INTEGER NOT NULL, scope_json TEXT NOT NULL, criteria_json TEXT NOT NULL,
  plan_revision INTEGER NOT NULL, PRIMARY KEY(run_id, task_id)) STRICT;

CREATE TABLE task_deps(run_id TEXT NOT NULL, task_id TEXT NOT NULL, depends_on TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, depends_on)) STRICT;

CREATE TABLE sessions(
  run_id TEXT NOT NULL, actor_owner TEXT NOT NULL, incarnation INTEGER NOT NULL,
  generation INTEGER NOT NULL, model TEXT NOT NULL, budget_json TEXT NOT NULL,
  state TEXT NOT NULL, PRIMARY KEY(run_id, actor_owner)) STRICT;

CREATE TABLE views(
  view_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, path TEXT NOT NULL,
  digest TEXT NOT NULL,            -- sha256:… or 'absent'
  mode INTEGER, blob_ref TEXT,     -- NULL when the file did not exist
  taken_at INTEGER NOT NULL, PRIMARY KEY(view_id, path)) STRICT;

CREATE TABLE action_transitions(from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  PRIMARY KEY(from_state, to_state)) STRICT;

CREATE TABLE actions(
  run_id TEXT NOT NULL, action_id TEXT NOT NULL, task_id TEXT NOT NULL, actor_owner TEXT NOT NULL,
  incarnation INTEGER NOT NULL, plan_revision INTEGER NOT NULL, request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (${states})),
  attempt INTEGER NOT NULL DEFAULT 0, error_code TEXT, receipt_json TEXT,
  registry_cleanup TEXT CHECK(registry_cleanup IN ('CLEARED','UNVERIFIED')),
  fs_cleanup TEXT NOT NULL DEFAULT 'NOT_ATTESTED' CHECK(fs_cleanup = 'NOT_ATTESTED'),
  prepared_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, action_id)) STRICT;

CREATE TABLE action_files(
  run_id TEXT NOT NULL, action_id TEXT NOT NULL, path TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('create','replace','delete')),
  before_digest TEXT, after_digest TEXT,
  before_mode INTEGER, after_mode INTEGER,
  before_blob TEXT, after_blob TEXT,
  tmp_name TEXT,
  progress TEXT NOT NULL DEFAULT 'PENDING' CHECK(progress IN ('PENDING','APPLIED')),
  observed_digest TEXT,
  PRIMARY KEY(run_id, action_id, path),
  FOREIGN KEY(run_id, action_id) REFERENCES actions(run_id, action_id)) STRICT;

CREATE TABLE validations(
  validation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  command TEXT NOT NULL, snapshot_digest TEXT NOT NULL, scope_digest TEXT NOT NULL,
  exit_code INTEGER, output_blob TEXT, valid INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL, finished_at INTEGER) STRICT;

CREATE TABLE children(pid INTEGER PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, task_id TEXT,
  proc_start_ticks INTEGER NOT NULL, pgid INTEGER NOT NULL,
  started_at INTEGER NOT NULL, generation INTEGER NOT NULL) STRICT;

CREATE TABLE model_calls(
  call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL,
  requested_model TEXT NOT NULL, served_model TEXT, base_url TEXT NOT NULL,
  started_at INTEGER NOT NULL, latency_ms INTEGER, http_status INTEGER, retries INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
  finish_reason TEXT, fallback_used INTEGER NOT NULL DEFAULT 0, cost_usd REAL, error TEXT,
  request_blob TEXT, response_blob TEXT) STRICT;

CREATE TABLE research_calls(
  call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL,
  provider TEXT NOT NULL, query TEXT, query_sha256 TEXT NOT NULL, params_json TEXT NOT NULL,
  started_at INTEGER NOT NULL, latency_ms INTEGER, credits_used INTEGER, cached INTEGER NOT NULL DEFAULT 0,
  result_blob TEXT, error TEXT, urls_json TEXT NOT NULL DEFAULT '[]') STRICT;

CREATE TABLE agent_runs(
  agent_run_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, profile_id TEXT NOT NULL,
  role TEXT NOT NULL, adapter TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER,
  argv_json TEXT NOT NULL, base_digest TEXT NOT NULL,
  exit_code INTEGER, signal TEXT, timed_out INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','FAILED','UNKNOWN')), reason TEXT,
  session_id TEXT, models_json TEXT,
  usage_provenance TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, cost_usd REAL, turns INTEGER, api_ms INTEGER,
  network_isolated INTEGER NOT NULL DEFAULT 0, permission_denials INTEGER,
  prompt_blob TEXT, stdout_blob TEXT, stderr_blob TEXT, final_text_blob TEXT,
  tool_use_json TEXT, changes_json TEXT NOT NULL DEFAULT '[]') STRICT;

CREATE TABLE events(
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, from_state TEXT, to_state TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,   -- tamper-evident chain (src/audit/chain.ts)
  PRIMARY KEY(run_id, seq)) STRICT;

-- invariants enforced by the database itself (defense in depth; code uses CAS first)
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER actions_immutable BEFORE UPDATE OF run_id, action_id, task_id, actor_owner,
    request_digest, plan_revision, prepared_at ON actions
  BEGIN SELECT RAISE(ABORT, 'action identity is immutable'); END;
CREATE TRIGGER actions_no_delete BEFORE DELETE ON actions
  BEGIN SELECT RAISE(ABORT, 'actions are never deleted'); END;
CREATE TRIGGER actions_legal_transition BEFORE UPDATE OF state ON actions
  WHEN OLD.state <> NEW.state AND NOT EXISTS (
    SELECT 1 FROM action_transitions WHERE from_state = OLD.state AND to_state = NEW.state)
  BEGIN SELECT RAISE(ABORT, 'illegal action transition'); END;

CREATE TRIGGER action_files_immutable BEFORE UPDATE OF run_id, action_id, path, op,
    before_digest, after_digest, before_mode, after_mode, before_blob, after_blob, tmp_name
    ON action_files
  BEGIN SELECT RAISE(ABORT, 'action_files plan is immutable'); END;
CREATE TRIGGER action_files_no_delete BEFORE DELETE ON action_files
  BEGIN SELECT RAISE(ABORT, 'action_files are never deleted'); END;
`;

export const seedTransitionsSql = (): string =>
  ACTION_TRANSITIONS.map(([a, b]) => `INSERT INTO action_transitions VALUES('${a}','${b}');`).join("\n");
