# Plan 04 — Conciliación y recuperación tras crash

Alcance del diseño §15: **crash de proceso con filesystem disponible**. No se promete
supervivencia a pérdida de energía ni transacción multiarchivo. Principio rector: *el disco es la
verdad sobre el contenido; el journal es la verdad sobre la intención; Zoanthrope es la verdad
sobre quién retiene qué.* La recuperación cruza las tres y, ante duda, se detiene y conserva evidencia.

## 1. Secuencia de arranque

| Paso | Qué hace | Si falla |
|---|---|---|
| 0 | Adquirir lock local (plan 01); `generation += 1` | otro ejecutor vivo → no arranca (S17) |
| 1 | Hijos registrados en `children` con `generation` anterior. Para cada uno, leer `/proc/<pid>/stat`: **sólo** si el pid existe **y** su `starttime` (campo 22) coincide con `proc_start_ticks` es el mismo proceso; entonces `SIGKILL` al `pgid` y esperar salida. Pid ausente o con otro `starttime` → ya no es nuestro: se ignora, nunca se mata | salida no confirmada → no se admite nada: `HALTED` |
| 2 | `quick_check`, versión de esquema, coherencia `meta.workspace_realpath` | no se muta; se muestra el motivo |
| 3 | Zoo: `verifyBinary` (G0) + handshake + `tools/list` | **modo degradado**: pasos 4–5 sí corren (sólo leen), nada que requiera Zoo (S09) |
| 4 | **Fase de sólo lectura**: clasificar disco para cada acción no terminal (§2) y `list_claims()` | — |
| 5 | **Fase de acción**: aplicar la decisión por acción (§3), en orden de `seq` | cada acción queda en un estado observable |
| 6 | Rehidratar sesiones: `incarnation += 1`; `rejoin_agent` por actor con acciones vivas | `claims_at_risk` → `RECOVERY_REQUIRED`, **no** toma el recurso |
| 7 | Emitir `RECOVERY_REPORT` (acciones, decisiones, bloqueos) | — |
| 8 | Recién ahora arranca el scheduler | — |

Los pasos 4 y 5 se separan a propósito: se decide con la foto completa, y un Zoo caído no impide
saber qué quedó a medias.

## 2. Clasificación por archivo

Para cada `action_files` de una acción en `CLAIMING, CLAIMED, EXECUTING, APPLIED, RELEASE_PENDING,
RECOVERY_REQUIRED` se hashea el disco (`absent` si no existe) y se compara con los hashes del journal.
`progress` **no** decide: sólo audita (el crash puede ocurrir entre el `rename` y su registro).

| Disco == | Clase |
|---|---|
| `after_digest` | `AFTER` (si `before == after`, es un no-op y cuenta como `AFTER`) |
| `before_digest` | `BEFORE` |
| cualquier otra cosa, o tipo distinto (dir, symlink) | `OTHER` |

## 3. Decisión por acción

| Estado en el journal | Clases | Decisión |
|---|---|---|
| `PREPARED` | — | sin efectos externos; permanece, el agente puede reenviar `apply_action` |
| `CLAIMING` | claims del actor = ∅ | → `WAITING_RESOURCE(RESTART)`; reintento normal |
| `CLAIMING` | claims = conjunto completo | → `CLAIMED` (VERIFY igualmente re-hashea) |
| `CLAIMING` | claims = subconjunto | anomalía: liberar esos claims propios (§4) → `WAITING_RESOURCE` |
| `CLAIMED` | todo `BEFORE` | sigue en `CLAIMED`; VERIFY al reanudar |
| `STALE_VIEW` | — | → `RELEASE_PENDING` → `SETTLED(error=STALE_VIEW)` por el camino normal de release; sus claims propios cuentan como "acción viva" en §4 hasta entonces |
| `EXECUTING` | todo `AFTER` | → `APPLIED` con recibo; **no** se vuelve a aplicar ni se llama al modelo (S04) |
| `EXECUTING` | todo `BEFORE` | reanudable **sólo si** lock adquirido, hijos extintos y claims re-adquiridos de nuevo en un lote; si el re-claim entra en conflicto → `RECOVERY_REQUIRED` esperando |
| `EXECUTING` | mezcla `BEFORE`/`AFTER` sin `OTHER` | completar **únicamente** los archivos `BEFORE` con sus `after_blob` registrados (roll-forward), bajo claims re-adquiridos; **tras el claim se vuelve a clasificar** y, además, `#apply` verifica `BEFORE`/`AFTER` justo antes de cada escritura (un claim no valida contenido); luego `APPLIED` (S05) |
| `EXECUTING`/`APPLIED`/`RELEASE_PENDING` | algún `OTHER` | `RECOVERY_REQUIRED`; **copiar los bytes observados a artifacts**, no escribir, no resetear; requiere revisión |
| `APPLIED` | todo `AFTER` | continuar con RELEASE |
| `RELEASE_PENDING` | — | `list_claims(actor)`: si quedan, reintentar `release` (idempotente: verificado, soltar algo no sostenido devuelve `released=[]`); luego `SETTLED` |
| `RECOVERY_REQUIRED` | reclasificar | se evalúa de nuevo con esta misma tabla en cada arranque |

Nunca existe la decisión "revertir a `BEFORE`". Un rollback es una **acción nueva y explícita** con
precondiciones sobre el contenido actual (diseño §6).

**Temporales.** Se borran por nombre exacto (`action_files.tmp_name`, decidido en PREPARE) y sólo
después de clasificar. Un `.synapser-tmp-*` no registrado se reporta, no se borra.

## 4. Conciliación con el registro de Zoanthrope

`list_claims()` completo, agrupado por agente:

| Observación | Tratamiento |
|---|---|
| claim de un actor de esta corrida, cubierto por una acción viva (cualquier estado no terminal, **incluido `STALE_VIEW`**) | esperado; `rejoin_agent` lo refresca |
| claim de un actor de esta corrida (`run:task` o `run:task#r`) **sin acción viva**, incluida una `STALE_VIEW` ya `SETTLED` (p. ej. claim `read` de un `read_files` interrumpido) | **huérfano propio**. Se libera con `claim_files(release)` *sólo* si: (a) este ejecutor tiene el lock, (b) los pasos 1–5 terminaron, (c) el actor pertenece a esta corrida. Evento `ORPHAN_CLAIM_RELEASED` |
| claim de un agente ajeno al producto | **nunca se toca** |
| acción que espera un claim que el registro no lista (estado de Zoo perdido) | re-claim; si hay conflicto, `WAITING`/`RECOVERY_REQUIRED` con el holder |
| `claims_at_risk` de `rejoin_agent` | `RECOVERY_REQUIRED`; no se roba ni se libera |

> **Decisión a aprobar:** liberar huérfanos *propios* no contradice "el MVP no elimina locks a mano"
> (§6): usa la API normal de release, tras detener al actor anterior (el proceso murió y el lock es
> prueba) y conciliar sus acciones. Sin esto, un `read_files` interrumpido bloquearía editores para
> siempre, porque un claim `stale` sigue bloqueando. La presencia stale **no** es el criterio.

## 5. Bloqueo de dependientes

```
blocked_paths = ⋃ files(a) para toda acción a en RECOVERY_REQUIRED
              ∪ ⋃ files(a) para toda acción con registry_cleanup = UNVERIFIED
```
- Los claims `run:task#r` se conciliaron junto con `run:task`: ambos pertenecen al mismo actor lógico.
- Una acción nueva cuyo conjunto intersecta `blocked_paths` → `REJECTED(BLOCKED_BY_RECOVERY, refs)`.
- Una tarea con una acción en `RECOVERY_REQUIRED` pasa a `RECOVERY_REQUIRED`; sus dependientes no
  llegan a `READY`. Una tarea sólo es `DONE` con todas sus acciones `SETTLED`.
- `PAUSED` exige cero acciones en `CLAIMING..RELEASE_PENDING` (diseño §6).

## 6. Timeout de coordinación en caliente (S13)

El adaptador ya cuarentena y exige `reconcile()`. El ejecutor completa el contrato:

| Punto | Tras `reconcile()` |
|---|---|
| durante ACQUIRE | claims del actor == conjunto → `CLAIMED`; si no → `WAITING_RESOURCE` |
| durante RELEASE | seguir en `RELEASE_PENDING`; verificar y `SETTLED` o `UNVERIFIED` |
| `reconcile()` falla / `HALTED` | misión → `PAUSING` con causa; nada más se admite |

## 7. Instrumentación de fallos (failpoints)

`failpoint(name)` está presente en el código de producción pero **inerte** salvo que
`SYNAPSER_ENABLE_FAILPOINTS=1` y `SYNAPSER_FAILPOINT=<name>[:<n>]`. Al activarse hace `SIGKILL` sobre
el propio proceso (la salida es la de un crash real: sin `finally`, sin flush). Además hay
inyectores no letales: `journal-write-fails`, `zoo-timeout`, `fs-enospc`.

| Failpoint | Estado del mundo al morir | Resultado esperado |
|---|---|---|
| `after-prepare-commit` | `PREPARED`, nada externo | reenvío normal |
| `after-claim-intent` | `CLAIMING`, registro vacío | `WAITING_RESOURCE(RESTART)` |
| `after-zoo-grant` | registro lleno, journal `CLAIMING` | `CLAIMED` |
| `after-executing-commit` | `EXECUTING`, todo `BEFORE` | reanuda y aplica |
| `after-temp-written` | temporal existe, todo `BEFORE` | borra temporal, reanuda |
| **`after-first-rename`** | primer archivo `AFTER`, `progress` desactualizado | completa el resto (**S05**) |
| `between-renames` | mezcla con `progress` al día | completa el resto |
| `after-last-rename` | todo `AFTER`, journal `EXECUTING` | `APPLIED` sin reaplicar |
| `after-applied-before-reply` | `APPLIED` | reintento del mismo `action_id` devuelve recibo (**S04**) |
| `after-release-pending` | claims aún en el registro | reintenta release → `SETTLED` |
| `after-zoo-release` | registro limpio, `RELEASE_PENDING` | verifica → `SETTLED` |
| `after-stale-view` | `STALE_VIEW` con claims propios en el registro | `RELEASE_PENDING` → `SETTLED(STALE_VIEW)`, registro limpio |
| `external-write-during-exec` (test) | un archivo con contenido ajeno | `OTHER` → `RECOVERY_REQUIRED`, bytes preservados |

El harness lanza el ejecutor como **proceso hijo** (S01/S05 exigen procesos reales), espera su muerte,
lo relanza y ejecuta la recuperación contra el *mismo* directorio de estado.

## 8. Verificador de invariantes

`checkInvariants(journal, workspace, zoo)` corre tras **cada** recuperación de **cada** test:

| ID | Invariante |
|---|---|
| I1 | Para toda acción `APPLIED/RELEASE_PENDING/SETTLED(ok)`: el disco == `after_digest`, salvo que una acción posterior ya liquidada haya reemplazado ese archivo |
| I2 | Ningún archivo con acción `RECOVERY_REQUIRED` tiene una acción posterior en `EXECUTING` o más |
| I3 | Tras recuperar, el registro no contiene claims de actores de la corrida fuera de acciones no terminales |
| I4 | Cada `action_id` produjo exactamente una transición a `APPLIED` |
| I5 | Sin acciones no terminales, no queda ningún `.synapser-tmp-*` |
| I6 | `events.seq` contiguo por corrida; cada transición del journal tiene su evento |
| I7 | **Oráculo de trabajo perdido**: cada acción añade una marca única; al final el archivo contiene exactamente las marcas de las acciones `SETTLED(ok)` y ninguna de `STALE_VIEW`/`REJECTED` |

I7 es el análogo del conteo de "lost work" del A/B de Zoanthrope y es el que sostiene la afirmación
de la demo.

## 9. Corridas aleatorias (día 21)

3 actores · 4 archivos compartidos · ~20 acciones · un agente *scripteado* (releer y reintentar tras
`STALE_VIEW`/espera) · failpoint y momento elegidos por semilla · 1–3 crashes por corrida.
CI: 50 semillas; nocturno: 500. Cada fallo guarda `seed`, journal, estado de Zoo y árbol, para
reproducir. Salida de la ventana: **20 corridas consecutivas sin violación de I1–I7**.

## 10. Qué este plan **no** cubre
- Corte de energía / pérdida de disco; fencing entre varios hosts (diseño §3, §15).
- Un administrador o proceso externo con escritura que eluda el ejecutor: se *detecta* como `OTHER`
  o `STALE_VIEW`, no se previene.
- Transferir una tarea con acciones pendientes a otro propietario (fuera del MVP).
- Reasignación automática por el supervisor.

## 11. Estado de implementación (13 oct)

- `src/executor/recovery.ts` (`recoverRun`), `src/recovery/children.ts` (`reapStaleChildren`),
  failpoints en `src/failpoints.ts`.
- `test/recovery/crash-matrix.test.ts`: 13 failpoints con `SIGKILL` real sobre un proceso ejecutor y
  recuperación en otro; S05 en detalle, contenido ajeno, TTL superado (G3), idempotencia, huérfanos,
  Zoo caído, arranque con `requireRecovery`, y una prueba de mutación del verificador de invariantes.
- Se retiraron las guardas a propósito para comprobar que sus tests fallan (lo hacen).
- **No implementado todavía**: composición del arranque completo (lock → reaper → journal →
  G0/Zoo → recover) en un único punto de entrada; I2 y I7 del verificador (necesitan scheduler y
  agente scripteado); corridas aleatorias del día 21.
