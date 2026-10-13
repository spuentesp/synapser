# Plan 01 — Journal SQLite

## Qué debe garantizar
- **Estado y evento en la misma transacción** (diseño §4). Un evento sin transición, o al revés, es un bug.
- **Transiciones con compare-and-swap**: `UPDATE … WHERE state = :esperado` y `changes === 1`, o falla.
- **Append-only** para eventos; **inmutabilidad** de `request_digest` y de los hashes previstos.
- Un journal que no se puede escribir **detiene la siguiente mutación** (diseño §8).

## Ubicación y apertura
```
$SYNAPSER_STATE_DIR/            default: <workspace>/../.synapser-state
  lock.db                       lock exclusivo del EJECUTOR, uno por workspace (ver abajo)
  <run_id>/
    journal.db  (+ -wal, -shm)
    artifacts/sha256/ab/cdef…   blobs direccionados por contenido
```
Pragmas al abrir: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`,
`trusted_schema=OFF`. Transacciones de escritura con `BEGIN IMMEDIATE`. `PRAGMA quick_check` al arrancar.
`DatabaseSync` es síncrono: un único escritor, sin interleaving dentro de una transacción.

## Bloqueo local (S17)
**El lock pertenece al workspace, no a la corrida** (diseño §3: un ejecutor por workspace). Vive en la
raíz del directorio de estado, por encima de los directorios `<run_id>/`; si colgara de `<run_id>/`,
dos misiones con `run_id` distintos sobre el mismo workspace tendrían cada una su lock y podrían
ejecutarse a la vez. `meta.workspace_realpath` se compara al abrir para detectar un directorio de
estado reutilizado con otro workspace.

`lock.db` con `locking_mode=EXCLUSIVE`, `journal_mode=DELETE` y una transacción `BEGIN EXCLUSIVE`
mantenida abierta durante toda la vida del proceso. El kernel libera el lock al morir el proceso,
incluso con `kill -9`. Un segundo ejecutor recibe BUSY y **no arranca**.
Al adquirirlo se incrementa `meta.generation` (ver plan 04, paso 0).

## Esquema (v1)
```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version, generation, zoo_version, zoo_sha256, workspace_realpath

CREATE TABLE missions(
  run_id TEXT PRIMARY KEY, objective TEXT NOT NULL, repo TEXT NOT NULL, base_sha TEXT NOT NULL,
  plan_revision INTEGER NOT NULL, limits_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('DRAFT','RUNNING','PAUSING','PAUSED','DONE','FAILED','CANCELLED')),
  created_at INTEGER NOT NULL) STRICT;

CREATE TABLE plan_revisions(
  run_id TEXT NOT NULL REFERENCES missions, revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL, accepted_at INTEGER, PRIMARY KEY(run_id, revision)) STRICT;

CREATE TABLE tasks(
  run_id TEXT NOT NULL REFERENCES missions, task_id TEXT NOT NULL,
  actor_owner TEXT NOT NULL,                        -- run_id:task_id, estable entre reinicios
  state TEXT NOT NULL CHECK(state IN ('PENDING','READY','RUNNING','WAITING_RESOURCE',
    'RECOVERY_REQUIRED','VALIDATING','DONE','FAILED','CANCELLED')),
  priority INTEGER NOT NULL, scope_json TEXT NOT NULL, criteria_json TEXT NOT NULL,
  plan_revision INTEGER NOT NULL, PRIMARY KEY(run_id, task_id)) STRICT;

CREATE TABLE task_deps(run_id TEXT, task_id TEXT, depends_on TEXT,
  PRIMARY KEY(run_id, task_id, depends_on)) STRICT;       -- el DAG se valida al insertar el plan

CREATE TABLE sessions(
  run_id TEXT NOT NULL, actor_owner TEXT NOT NULL, incarnation INTEGER NOT NULL,
  generation INTEGER NOT NULL, model TEXT NOT NULL, budget_json TEXT NOT NULL,
  state TEXT NOT NULL, PRIMARY KEY(run_id, actor_owner)) STRICT;

CREATE TABLE views(                                   -- lo que el agente leyó
  view_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, path TEXT NOT NULL,
  digest TEXT NOT NULL, mode INTEGER NOT NULL, blob_ref TEXT NOT NULL, taken_at INTEGER NOT NULL) STRICT;

CREATE TABLE actions(
  run_id TEXT NOT NULL, action_id TEXT NOT NULL, task_id TEXT NOT NULL, actor_owner TEXT NOT NULL,
  incarnation INTEGER NOT NULL, plan_revision INTEGER NOT NULL, request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','CLAIMING','WAITING_RESOURCE','CLAIMED',
    'STALE_VIEW','EXECUTING','APPLIED','RELEASE_PENDING','SETTLED','RECOVERY_REQUIRED','REJECTED')),
  attempt INTEGER NOT NULL DEFAULT 0, error_code TEXT, receipt_json TEXT,
  registry_cleanup TEXT, fs_cleanup TEXT NOT NULL DEFAULT 'NOT_ATTESTED',
  prepared_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, action_id)) STRICT;

CREATE TABLE action_files(
  run_id TEXT NOT NULL, action_id TEXT NOT NULL, path TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('create','replace','delete')),
  before_digest TEXT,                  -- NULL = el archivo no existía
  after_digest  TEXT,                  -- NULL = el archivo queda borrado
  before_mode INTEGER, after_mode INTEGER,
  before_blob TEXT, after_blob TEXT,   -- referencias a artifacts/
  tmp_name TEXT,                       -- nombre exacto del temporal, para limpiarlo sin adivinar
  progress TEXT NOT NULL DEFAULT 'PENDING' CHECK(progress IN ('PENDING','APPLIED')),
  observed_digest TEXT,                -- último hash visto en disco (auditoría; la verdad es el disco)
  PRIMARY KEY(run_id, action_id, path),
  FOREIGN KEY(run_id, action_id) REFERENCES actions) STRICT;

CREATE TABLE validations(
  validation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  command TEXT NOT NULL, snapshot_digest TEXT NOT NULL, scope_digest TEXT NOT NULL,
  exit_code INTEGER, output_blob TEXT, valid INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL, finished_at INTEGER) STRICT;

CREATE TABLE children(pid INTEGER PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, task_id TEXT,
  proc_start_ticks INTEGER NOT NULL,      -- /proc/<pid>/stat campo 22: anti reutilización de pid
  pgid INTEGER NOT NULL,                  -- grupo de procesos propio (setsid) para matar el árbol
  started_at INTEGER NOT NULL, generation INTEGER NOT NULL) STRICT;   -- para plan 04, paso 1

CREATE TABLE events(
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, from_state TEXT, to_state TEXT,
  data_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(run_id, seq)) STRICT;
```
`seq` se asigna dentro de la transacción: `COALESCE(MAX(seq),0)+1`; seguro porque hay un solo escritor.

## Invariantes aplicados en la propia base (triggers)
- `events`: `BEFORE UPDATE/DELETE → RAISE(ABORT)`.
- `actions`: `request_digest`, `task_id`, `actor_owner` inmutables; las transiciones válidas son una
  tabla `(from,to)` y un trigger rechaza el resto (defensa en profundidad: el CAS del código es la
  primera línea).
- `action_files`: `before_*`, `after_*`, `op`, `path` inmutables tras insertar.

Transiciones válidas de acción (única fuente: `src/journal/transitions.ts`, generada al trigger):
```
PREPARED → CLAIMING | REJECTED
CLAIMING → CLAIMED | WAITING_RESOURCE | RECOVERY_REQUIRED
WAITING_RESOURCE → CLAIMING | REJECTED
CLAIMED → EXECUTING | STALE_VIEW | WAITING_RESOURCE | RECOVERY_REQUIRED   (WAITING_RESOURCE: el claim se perdió tras un reinicio y se reintenta)
STALE_VIEW → RELEASE_PENDING          (siempre: STALE_VIEW sólo se alcanza desde CLAIMED, con claims propios)
EXECUTING → APPLIED | RECOVERY_REQUIRED
APPLIED → RELEASE_PENDING | RECOVERY_REQUIRED   (el disco ya no coincide con lo aplicado)
RELEASE_PENDING → SETTLED | RECOVERY_REQUIRED   (SETTLED conserva error_code, p. ej. STALE_VIEW)
RECOVERY_REQUIRED → APPLIED | EXECUTING(resume) | REJECTED(terminal con evidencia)
```

## API del módulo (`src/journal/`)
```ts
interface Journal {
  tx<T>(fn: (t: Tx) => T): T;                          // BEGIN IMMEDIATE … COMMIT, rollback si lanza
}
interface Tx {
  insertAction(a: NewAction, files: NewActionFile[]): InsertOutcome;   // idempotente por (run_id, action_id)
  transition(run: string, action: string, from: ActionState, to: ActionState, data?: object): void; // CAS + evento
  markFileApplied(run, action, path, observedDigest): void;
  event(run, entity, id, from, to, data): void;
}
type InsertOutcome =
  | { kind: "created" }
  | { kind: "duplicate"; state: ActionState; receipt?: Receipt }   // mismo digest
  | { kind: "digest_conflict"; existingDigest: string };           // otro cuerpo, misma clave
```
Los artefactos van por `ArtifactStore.put(bytes) → blob_ref` (temporal en el mismo FS, fsync, rename,
fsync de directorio) **antes** de la transacción que los referencia. Un blob huérfano es inocuo; una
referencia a un blob inexistente no puede ocurrir.

## Tests (día 17)
- CAS: dos transiciones concurrentes desde el mismo estado → una gana, la otra recibe error tipado.
- Rollback: una excepción dentro de `tx` no deja evento ni estado.
- Trigger: `UPDATE events`, cambiar `request_digest`, salto `PREPARED→APPLIED` → rechazados.
- `insertAction` con mismo digest → `duplicate`; con otro cuerpo → `digest_conflict`.
- **S17**: proceso A mantiene el lock; proceso B falla con BUSY y no abre el journal; `kill -9` de A y
  B adquiere con `generation + 1`.
- **S17b**: mismo workspace, dos `run_id` distintos: el segundo ejecutor falla con BUSY aunque su
  directorio `<run_id>/` sea otro. (Con el lock bajo `<run_id>/` este test fallaría; es el que lo
  protege.)
- Disco lleno (cuota simulada en tmpfs pequeño): la transacción falla y el ejecutor entra en
  "no mutar" (diseño §8, "Disco lleno o escritura del journal fallida").
