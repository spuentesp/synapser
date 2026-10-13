# 09 — A/B de coordinación: contrato, invariantes y criterio de falsación

## 1. Hipótesis

H1. Con agentes concurrentes que deben tocar archivos compartidos, un árbol compartido sin
coordinación (último en escribir gana) **pierde actualizaciones** y no lo advierte; Synapser no.
H2. El costo de evitarlo (reintentos por `STALE_VIEW`, esperas) es acotado y se mide.

## 2. Condiciones (solo difiere el `WriteGateway`)

| Brazo | Gateway | Qué conserva |
|---|---|---|
| `naive` | `src/bench/naive-gateway.ts` | contención de rutas, scope de tarea, el parche debe aplicar a lo leído |
| `synapser` | `Executor` | todo lo anterior + claims, digests, STALE_VIEW, journal, recovery |

El control no es un modo del Executor: es otra implementación del mismo puerto
(`src/executor/gateway.ts`). Mismo bucle de agente, mismas herramientas, mismos prompts, mismo modelo.
El aislamiento del experimento es la **coordinación**, no la higiene.

## 3. Invariantes (verificadores ejecutables en `src/audit/invariants.ts`)

| | Invariante | Violación = |
|---|---|---|
| I1 | linaje por ruta: cada escritura se basó en lo que dejó la anterior | `LOST_UPDATE` |
| I2 | ninguna acción llegó a EXECUTING sin CLAIMED | `WRITE_WITHOUT_GRANT` |
| I3 | no se sobrescribieron bytes que no eran ni el antes ni el después previstos | `UNPREDICTED_BYTES_OVERWRITTEN` |
| I4 | tarea DONE ⇒ validación válida y aprobada | `DONE_WITHOUT_ACCEPTANCE` |
| I5 | la cadena de hashes verifica | `CHAIN_BROKEN` |

La traza de escrituras (`WriteRecord`: ruta, base declarada, bytes en disco antes, bytes escritos) la
produce un observador independiente de quien escribe: `beforeRename` en el Executor, el propio
gateway en el control. Ambos brazos se juzgan con el mismo código.

## 4. Contrato demostrado sin modelos (`test/audit/lost-update.test.ts`)

Dos agentes leen `schema.py` a la misma base y ambos la editan, en un entrelazado fijo.
- `naive`: exactamente 1 violación I1; el cambio de A desaparece; ambos agentes reportan éxito.
- `synapser`: `STALE_VIEW` → relectura → ambos cambios presentes; I1–I5 sin violaciones.
- El verificador no es vacuo: una traza fabricada con un lost update y una sobrescritura ajena es
  detectada con código y posición exactos.

## 5. Medición en vivo (declarada antes de correr)

- Carga: misiones con **contención inherente** (varias tareas deben tocar el mismo archivo); una
  carga partida por archivo no sirve (empata en corrección y pierde en velocidad).
- N por brazo fijado de antemano (N=5), mismo modelo, misma semilla de misión.
- Métricas: violaciones I1 por corrida; ¿el oráculo pasa? (resultado funcional); tiempo; tokens y USD;
  `STALE_VIEW`/esperas (solo `synapser`).
- Se reportan también las corridas en que `naive` tuvo éxito.

## 6. Qué la falsaría

- Si `naive` no pierde actualizaciones en la carga con contención → la carga no es adecuada o H1 es
  falsa para esos modelos: se informa tal cual.
- Si `synapser` registra alguna violación I1–I5 → defecto del sistema, no del experimento.
- Si el sobrecosto de `synapser` supera ~2× en tokens sin ganancia de corrección → H2 falsa.
