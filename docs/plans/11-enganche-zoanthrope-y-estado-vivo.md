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

## 2. Spike S-Z (antes de diseñar el colector)

Preguntas con salida verificable, contra el binario fijado por el pin:

1. ¿El anillo de eventos expone un número de secuencia monótono o solo contenido? (decide cómo
   detectar huecos).
2. ¿El volcado ofrece "desde el evento N"? ¿Cuál es el coste de leerlo completo?
3. ¿`post_intention` queda consultable por otros agentes y con qué TTL?
4. ¿Un cliente MCP distinto del agente puede publicar con la identidad de la corrida?

Salida: tabla de hallazgos en este plan y, si (1) es "no", el colector declara su propia secuencia con
huella de cada evento y reporta `zoo_gap` ante una discontinuidad aparente.

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
