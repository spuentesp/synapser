# Plan 11 — Enganche a Zoanthrope y estado vivo del enjambre

Hoy los claims los toma el broker en nombre del agente (plan 08). Falta que el agente **exista** para
Zoanthrope —identidad, intención declarada, observación— y que Synapser pueda mostrar qué hace cada
agente *ahora*, no solo después.

## 1. Niveles de enganche (cada uno aporta valor sin el siguiente)

| Nivel | Qué hace | Quién lo garantiza | Depende de |
|---|---|---|---|
| L0 | claims de escritura en rutas canónicas | broker (ya hecho) | — |
| L1 | identidad por corrida y **intención declarada** (`post_intention`) antes de escribir | el runner, en nombre del agente | API MCP de Zoanthrope |
| L2 | **observación**: volcado periódico de su anillo de auditoría y su tablón al ledger | un colector | spike S-Z |
| L3 | hooks nativos del CLI (solo Claude Code los tiene) | el propio CLI | por perfil |

**Autoridad frente a observación.** Zoanthrope arbitra; el ledger de Synapser es la fuente de verdad
de lo que se hizo. L1–L3 son *observabilidad adicional*: ninguna invariante de integridad depende de
ellos. Si Zoanthrope cae, se pierde información de coordinación, no corrección (ya cubierto: sin
concesión no hay escritura).

## 2. Spike S-Z — hallazgos (binario 0.1.3 fijado; `scripts/spike-sz.ts`)

| # | Pregunta | Hallazgo |
|---|---|---|
| 1 | ¿Secuencia monótona en los eventos? | **No.** Un evento es `{ts, agent, action, path, purpose, stamps?}`; `ts` es float en segundos con resolución de microsegundos y no decreciente. Acciones: `register`, `claim`, `release`, `post`, `post_update`, `post_remove`, `rejoin`. Un conflicto de claim no genera evento |
| 2 | ¿"Desde N"? ¿costo? | `get_audit_log(limit, since_unix)`; `since_unix` es **inclusivo** (`ts >= since`) y `limit` devuelve los N **más recientes**. El anillo completo es una sola llamada de ≤1 000 eventos |
| 3 | ¿`post_intention` consultable y con qué TTL? | Visible por `list_posts` para cualquier agente; sin TTL; estados `open/taken`; queda en el anillo como `post` |
| 4 | ¿Otro cliente publica con la identidad de la corrida? | **Sí.** La identidad es un string que aporta quien llama; no hay autenticación (coherente con §12 del diseño: el motor no entrega tokens de sesión) |
| + | ¿El anillo sobrevive a un reinicio? | Sí: está en `.zoanthrope/state.json`; el tope es 1 000 y descarta los más antiguos |

Consecuencias de diseño: (a) sin secuencia, el límite se deduplica con un **multiconjunto de huellas**
de los eventos que comparten el último `ts`; (b) un hueco se detecta, no se mide: anillo lleno y
evento más antiguo posterior a nuestra frontera ⇒ **al menos uno** sin contabilizar; (c) una
observación es un dato del servidor, no una prueba de quién escribió (Z1).

## 3. Colector (`src/zoo/collector.ts`) — contrato

```
drain(since?) → ZooObservation[]       lectura; nunca escribe en Zoanthrope
record(obs)   → evento `zoo_observation` en el ledger (encadenado como el resto)
```

- Idempotente: reintentar un volcado no duplica (clave = huella del evento).
- **Sin pérdida silenciosa**: si el anillo (tope de 1 000) dio la vuelta entre dos volcados, se emite
  `zoo_gap { missed_at_least: n }`; nunca se oculta.
- El volcado ocurre al terminar cada corrida y a intervalo fijo; la frecuencia es configuración, no
  lógica de corrección.

## 4. Estado vivo (`src/audit/state.ts`) — proyección determinista

`state(journal, atSeq?) → SwarmState`: por agente, `status` (planned | running | waiting | stale |
validating | done | failed), acción actual, archivos retenidos, a qué espera y desde cuándo, último
latido, tokens y costo acumulados con procedencia. **Es una función pura del ledger**:

- misma cadena ⇒ mismos bytes;
- `state(seq)` permite *reproducir* el enjambre en un instante pasado (base de la "línea de tiempo");
- no lee el sistema de archivos ni Zoanthrope: lo que Zoanthrope aporte llega por `zoo_observation`.

Transporte: `GET /api/runs/:id/state` (instantánea) y `GET /api/runs/:id/events?since=seq` (SSE).

## 5. Invariantes

| | Invariante | Verificador |
|---|---|---|
| Z1 | ninguna conclusión de integridad (I1–I5, W1–W5) usa `zoo_observation` como premisa | revisión estática: los verificadores no importan el colector |
| Z2 | el volcado no pierde eventos sin dejar `zoo_gap` | prueba con anillo pequeño forzado a dar la vuelta |
| Z3 | la intención de una corrida precede a su primera escritura | `checkIntentBeforeWrite` |
| Z4 | todo claim vivo en Zoanthrope corresponde a una acción no conciliada o se reporta como huérfano | `checkNoSilentOrphans` |
| L1 | `state` es determinista y reproducible por `atSeq` | doble cómputo ⇒ bytes iguales |
| L2 | la suma de tokens/costo por agente en `state` coincide con `cost` de las consultas | prueba cruzada |

## 6. Obligaciones de prueba

Con el doble `fake-zoo` y con el binario real: volcado idempotente; anillo que da la vuelta ⇒ `zoo_gap`;
Zoanthrope caído durante el volcado ⇒ evento de error, corrida intacta; proyección idéntica antes y
después de reabrir el journal; `state(atSeq)` en un entrelazado conocido (A espera a B) muestra la
espera en el instante correcto.

## 7. Falsación

Si el spike muestra que el anillo no permite detectar pérdida de forma fiable, **no se afirma
"observación completa"** en la presentación: se presenta como muestra con huecos declarados.

## 8. Estado de implementación

Implementado y cubierto por pruebas (doble con la semántica del binario y binario real):
`src/zoo/collector.ts` (volcado de solo lectura, idempotente, frontera por multiconjunto, `GAP`
y `RESET` declarados, reanuda desde el ledger), `src/zoo/intent.ts` (L1: intención declarada antes
de escribir; fallo = evento, nunca fallo de tarea), `src/audit/state.ts` (`swarmState(journal,
atSeq?)`, pura y reproducible), verificadores Z3 y Z4, y el enganche al planificador
(`collector`, `intent`). El transporte HTTP/SSE del estado se entrega con la interfaz (plan 12).
Pendiente: L3 (hooks nativos de Claude Code) y la verificación del TTL de lease (riesgo abierto del índice).

