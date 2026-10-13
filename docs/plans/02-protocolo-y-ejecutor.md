# Plan 02 — Protocolo de acción y ejecutor

El ejecutor es el único proceso con escritura al workspace (diseño §3, §7). Cada acción es una
unidad acotada: conjunto de archivos conocido, claims tomados sólo durante la acción, sin retenerlos
mientras se espera al modelo.

## Superficie hacia los agentes
```ts
read_files(task, paths)  → { view_id, files:[{path, digest|"absent", mode, content}] }
propose_patch(task, view_id, edits[], declared_outputs[]) → { action_id, request_digest, files:[…] }
apply_action(action_id, request_digest, incarnation)      → ActionReceipt | { status:"in_progress" }
get_action(action_id)                                     → ActionReceipt
```
- `actor_owner` lo deriva el backend de `run_id:task_id`; el modelo no lo envía ni elige.
- **Identidad de Zoo para escrituras vs. lecturas.** Las acciones de escritura usan `actor_owner`
  (`run:task`); `read_files` usa **otra identidad**, `run:task#r`. Verificado contra el binario 0.1.3:
  con el mismo agente, `claim edit` → `claim read` → `release` deja el registro **vacío** (el read se
  concede como `edit` por "intención más fuerte" y el release suelta la ruta entera) y un competidor
  obtiene el archivo en plena escritura. Con identidades distintas, la lectura entra en conflicto con
  la edición propia pendiente y espera, que es el comportamiento correcto. El backend, no el modelo,
  elige la identidad; `#r` es parte del conjunto de actores de la corrida a efectos de la
  conciliación (plan 04 §4).
- `propose_patch` ejecuta **PREPARE** (§1 abajo). `apply_action` ejecuta el resto. Sin `shell`.
- `ActionReceipt = { action_id, state, observed_files, applied_files, error_code, cleanup:
  { registry: CLEARED|UNVERIFIED, fs: "NOT_ATTESTED" } }`.

## Estados y efectos persistentes (orden estricto)

| # | Paso | Antes del efecto, en el journal | Efecto externo | Después, en el journal |
|---|---|---|---|---|
| 1 | PREPARE | blobs before/after a artifacts (fsync) | — | `PREPARED` + `action_files` (hashes, op, tmp_name) |
| 2 | ACQUIRE | `CLAIMING` (**intención**, decisión 3) | `claim_files(edit, set completo, 1 llamada)` | `CLAIMED` · o `WAITING_RESOURCE` con holder |
| 3 | VERIFY | — | leer bytes del disco y hashear todo | ok → sigue · distinto → `STALE_VIEW` |
| 4 | APPLY | `EXECUTING` commit **antes del primer rename** | por archivo (orden de ruta): temporal en el mismo dir → fsync → `rename` → fsync dir → re-hash | `action_files.progress=APPLIED` por archivo |
| 5 | CONFIRM | — | — | `APPLIED` + recibo (si todo `== after`) · si no, `RECOVERY_REQUIRED` |
| 6 | RELEASE | `RELEASE_PENDING` | `claim_files(release)` + `list_claims(actor)` | `SETTLED` con `registry_cleanup`; `fs_cleanup=NOT_ATTESTED` |
| 7 | VALIDATE | (plan 03 §5) | tests sobre copia | `validations` |

Reglas transversales:
- **Un conflicto no escribe nada** (S01, S02): el lote se pide completo; `ok=false` → `WAITING_RESOURCE`
  con `holder/path/purpose/holder_stale` en el evento. Reintento con backoff acotado; entre intentos
  no se retiene ningún claim propio.
- **`STALE_VIEW`** (S03): `CLAIMED → STALE_VIEW → RELEASE_PENDING → SETTLED(error=STALE_VIEW)`. Se
  liberan *sólo* claims propios y por el mismo camino de RELEASE (con su recuperación, plan 04 §3).
  El agente debe releer y proponer una acción **nueva** (otro `action_id`). Nunca se reaplica el
  parche a bytes nuevos.
- **`read_files` sobre una ruta con acción no conciliada del mismo actor se rechaza**
  (`BUSY_OWN_ACTION`), además de la espera natural por conflicto: la regla vale aunque cambie la
  identidad de lectura. Evita leer una vista a mitad de una escritura propia.
- **Una acción no conciliada por `actor_owner`**. Zoanthrope no distingue dos acciones del mismo
  agente (un re-claim propio no entra en conflicto) y `release` suelta la ruta entera, así que la
  exclusión intra-actor la impone el ejecutor.
- **Un solo escritor lógico por llamada a Zoo** (el adaptador ya serializa). Acciones con conjuntos
  disjuntos sí avanzan a la vez: la espera de E/S de una no bloquea a otra; el journal es síncrono y
  corto.
- **Reconciliación antes de reportar**: ningún camino devuelve `APPLIED` sin haber re-hasheado el
  disco después del último rename.
- **Fallo de `release` o de `list_claims`**: se registra `registry_cleanup=UNVERIFIED`; las acciones
  que dependen de esos archivos quedan bloqueadas; no se declara limpieza total (S16).
- **Zoo no disponible** en cualquier punto antes del paso 4: `ZooError` → la acción no escribe;
  si quedó en `CLAIMING`, la recuperación la trata como "posible claim" (plan 04).

## Idempotencia y respuesta perdida (S04)
`apply_action` es una consulta+avance sobre `(run_id, action_id)`:

| Estado encontrado | Respuesta |
|---|---|
| no existe / digest distinto | `REJECTED(ACTION_ID_UNKNOWN | ACTION_ID_REUSED)` |
| `PREPARED..EXECUTING` | continúa si es la sesión dueña y la misma incarnation; si ya hay un avance en vuelo → `in_progress` |
| `APPLIED`/`RELEASE_PENDING`/`SETTLED` | devuelve el recibo **sin tocar el disco ni Zoo** |
| `RECOVERY_REQUIRED` | devuelve el estado y la causa; no reintenta |

## Incarnation y rechazo de peticiones antiguas (S07)
`sessions.incarnation` se incrementa al rehidratar la sesión tras un reinicio (y nunca decrece).
Cada petición lleva `incarnation`; distinta de la vigente → `STALE_INCARNATION` antes de cualquier
efecto. La identidad propietaria (`actor_owner`) se conserva para `rejoin_agent`.

## Estructura de código
```
src/executor/
  executor.ts         orquesta pasos 2–6; recibe Journal, ZooAdapter, FsApplier, Clock, Failpoints
  prepare.ts          valida actor/incarnation/plan/rutas/alcance, resuelve edits a bytes
  fs-applier.ts       temp+fsync+rename+fsync dir+re-hash; sin conocimiento de Zoo ni del journal
  api.ts              read_files / propose_patch / apply_action / get_action
src/failpoints.ts     ver plan 04
```
`FsApplier` es el único módulo que escribe el workspace; recibe `WorkspacePath` ya validados.

## Tests (días 18–20)
| ID | Cómo |
|---|---|
| S01 | dos acciones sobre el mismo archivo con procesos reales: una `EXECUTING`, otra `WAITING_RESOURCE` con holder; ni un byte de la segunda en disco |
| S02 | A pide {x,y}, B ya tiene y: A no escribe x; `list_claims(A)` vacío |
| S03 | se modifica el archivo tras `read_files`: `STALE_VIEW`, claims propios liberados, ajenos intactos |
| S04b | tras perder la respuesta, el agente llama `read_files` sobre las mismas rutas: `BUSY_OWN_ACTION` o espera; el claim `edit` de la acción sigue en el registro durante `EXECUTING` |
| S04 | `apply_action` aplica y se descarta la respuesta; reintento con mismo `action_id` → mismo recibo y `mtime` del archivo sin cambios |
| S07 | reinicio + petición con incarnation anterior → `STALE_INCARNATION`; `rejoin` del mismo propietario funciona |
| S09 | binario Zoo ausente/`kill`: ninguna escritura mediada; lecturas del journal siguen respondiendo |
| S10/S15 | ruta externa, symlink, `.git`, `.zoanthrope`: rechazo antes de `CLAIMING` (no hay evento de claim) |
| S14 | respuesta `isError=false/ok=false` → ninguna escritura aunque el transporte esté sano |
| S16 | `release` falla / `list_claims` falla → `UNVERIFIED`; no hay marca de limpieza |

**Propiedad de seguridad INV1 en un test**: instrumentar `FsApplier` para exigir, en cada `rename`,
que existe en Zoo un claim `edit` vigente del actor sobre esa ruta y que el journal está en
`EXECUTING`; el test falla si algún camino llega al `rename` sin eso.
