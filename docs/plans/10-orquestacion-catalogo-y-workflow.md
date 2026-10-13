# Plan 10 — Orquestación: catálogo de agentes, enrutamiento y workflow con aprobaciones

Cierra la brecha entre "ejecutar un plan" y la visión: Nemotron arma un workflow eligiendo del
*toolbox* de agentes perfilados, con pasos, aprobaciones y subtareas pedidas por los propios agentes.
Principio rector: **el modelo propone, el código dispone**. Toda decisión del modelo pasa por un
validador determinista antes de tener efecto; ninguna invariante depende de que el modelo acierte.

## 1. Alcance y no-alcance

- Dentro: catálogo con capacidades, enrutamiento, tipos de paso, compuertas de aprobación, subtareas
  solicitadas por agentes, tope de costo, workflow versionado y con hash.
- Fuera: ejecutar CLIs en paralelo dentro de una misma copia (cada corrida sigue aislada, plan 08),
  planificación jerárquica de profundidad arbitraria (acotada, §6).

## 2. Catálogo (`ProfileCard`)

Derivado del `ProfileRegistry` y de lo **medido** en el registro, no de lo declarado:

```ts
interface ProfileCard {
  id: string;
  kinds: ("write" | "advise" | "research" | "review")[];   // lo que puede hacer
  integration: "direct" | "pending";                       // plan 08
  strengths: string[];                                     // etiquetas del perfil
  cost: CostEstimate;                                      // ver §2.1
  observed: { runs: number; succeeded: number; medianMs: number } | null;
  enabled: boolean; disabledReason?: string;
}
```

### 2.1 Costo: conocido, estimado o desconocido (nunca confundidos)

```ts
type CostEstimate =
  | { basis: "known";     usdPerRun: number }                         // tarifa publicada o `reported`
  | { basis: "estimated"; usdPerRun: number; low: number; high: number; n: number }  // aprendido
  | { basis: "unknown" };
```

- **estimated** se aprende del propio registro: mediana y cuantiles de `agent_runs` con costo
  `reported`/`log` del mismo perfil (y, si hay pocas corridas, del mismo *tipo de tarea* y tamaño de
  prompt). Función pura del ledger: mismo registro ⇒ misma estimación. Requiere `n ≥ nMin`
  (configurable); por debajo, `unknown`.
- Una estimación **nunca** se mezcla con costo real en las sumas: los totales muestran
  `knownUsd`, `estimatedUsd` y `unknownRuns` por separado, y el tope de misión se evalúa sobre
  `known + estimated(high)`.
- Un perfil `unknown` **no bloquea**: dispara una alerta (`cost_unknown` en el ledger, visible en la
  UI) y el enrutador lo penaliza frente a uno con costo conocido o estimado. Tras sus primeras
  corridas con uso reportado pasa a `estimated` solo.
- La exactitud de las estimaciones se mide contra lo ocurrido (error relativo mediano por perfil) y
  se publica en el panel; una estimación sistemáticamente mala se degrada a `unknown`.

`observed` sale de una consulta determinista sobre `agent_runs` (mismo registro, mismas reglas de
procedencia). Un perfil sin corridas tiene `observed: null` y el supervisor lo ve así.

## 3. Plan extendido y validación

`PlanTask` gana `kind`, `profile?`, `gates?`. El supervisor recibe el catálogo y propone; el
**validador** (extiende `validatePlan`) decide:

| Regla | Falla con |
|---|---|
| el perfil existe y está habilitado | `PROFILE_UNKNOWN` / `PROFILE_DISABLED` |
| `kind` ∈ `kinds` del perfil | `PROFILE_KIND_MISMATCH` (un asesor nunca recibe `write`) |
| `kind: advise|review` no declara `scope` de escritura | `ADVISOR_WITH_WRITE_SCOPE` |
| todo `write` tiene criterio de aceptación verificable | `NO_ACCEPTANCE` |
| el costo máximo estimado cabe en el tope de la misión | `OVER_BUDGET` |

Si falta `profile` o el elegido no es utilizable, el **enrutador determinista** decide
(`route(task, catalog, history)`: filtra por `kinds`, `enabled` e integración; ordena por costo
observado conocido y luego por id). Mismas entradas ⇒ misma elección; el modelo solo sugiere.

## 4. Tipos de paso y compuertas

| Paso | Efecto en el árbol | Salida |
|---|---|---|
| `write` | vía ejecutor/broker | cambios + evidencia |
| `advise` | ninguno | veredicto estructurado `{ verdict, findings[] }` |
| `research` | ninguno | citas con fuente (plan 07) |
| `review` | ninguno | veredicto sobre un diff antes de integrar |
| `validate` | ninguno | validaciones sobre snapshot consistente |
| `approval` | ninguno | `APPROVED | REJECTED | EXPIRED` + actor |

Una compuerta de aprobación se **liga al digest del plan** que aprobó: si la revisión cambia, la
aprobación deja de valer. Aprobar es un evento del ledger con actor, momento y digest. Políticas
automáticas (`auto_approve_if`) son reglas deterministas declaradas en el workflow, no juicio del
modelo; el banco de pruebas las usa para correr sin humano.

## 5. Subtareas pedidas por agentes (llamarse entre sí)

Un agente nunca crea agentes. Dispone de `request_subtask({ objective, kind, scope, why })`; la
petición va al supervisor como **revisión de plan solo aditiva**, validada con las reglas de §3 más:
alcance ⊆ alcance del solicitante, profundidad ≤ `maxDepth`, total ≤ `maxTasks`, sin ciclos y dentro
del tope de costo. Rechazo ⇒ el agente recibe el código; no hay efecto lateral.

## 6. Invariantes

| | Invariante | Verificador |
|---|---|---|
| W1 | toda corrida usó un perfil existente, habilitado y con `kind` compatible, en el plan **y** al despachar | `checkDispatch(journal)` |
| W2 | un paso `advise|review|research` no produjo cambio en el árbol | `checkAdvisorsReadOnly` (traza de escrituras) |
| W3 | ningún paso con compuerta pasó a RUNNING sin aprobación vigente ligada al digest del plan | `checkGates` |
| W4 | el gasto *conocido* nunca superó el tope; todo costo estimado o desconocido consta como tal y el desconocido generó alerta | `checkBudget` |
| W7 | una estimación nunca se suma como costo real, y es función pura del registro | prueba de propiedad + doble cómputo |
| W5 | toda tarea con `requested_by` está en una revisión aditiva válida y dentro de profundidad/alcance | `checkDelegation` |
| W6 | el enrutador es una función: mismas entradas ⇒ misma asignación | prueba de propiedad |

## 7. Obligaciones de prueba (sin modelo)

1. Plan con perfil inexistente, deshabilitado, de tipo incompatible, asesor con alcance de escritura,
   sobre presupuesto: cada uno rechazado con su código.
2. Propiedad: planes y catálogos aleatorios; ninguna asignación aceptada viola W1.
3. Compuerta: cambiar el plan tras aprobar invalida la aprobación; la tarea queda bloqueada.
4. Delegación: petición fuera de alcance, demasiado profunda, con ciclo o sobre presupuesto ⇒ rechazada
   y el árbol intacto; petición válida ⇒ aparece en el DAG con `requested_by`.
5. Costo: sin historial ⇒ `unknown` + alerta; con `n ≥ nMin` ⇒ `estimated` y reproducible; la estimación
   no entra en `knownUsd`; un perfil con estimación mala se degrada a `unknown`.
6. Asesor "malicioso" (devuelve un parche en su texto): no cambia nada (W2).
7. Determinismo del enrutador (W6).

## 8. Hipótesis y criterio de falsación

- H-R: el enrutamiento guiado por el catálogo medido iguala o mejora costo y tasa de éxito frente a un
  perfil fijo. **Se falsa** si, con N≥20 por brazo, no mejora ninguna de las dos métricas: entonces el
  enrutador queda determinista y el modelo solo descompone.
- H-A: las aprobaciones ligadas al digest no añaden fallos de corrida (solo latencia humana).

## 9. Decisiones que requieren aprobación

| # | Decisión | Alternativa |
|---|---|---|
| D1 ✅ | El enrutador determinista manda; el modelo solo sugiere perfil | — |
| D2 ✅ | `maxDepth` configurable por workflow (default 2) | — |
| D3 ✅ | Perfil de costo desconocido: **alerta**, no bloqueo; se aprende y se estima (§2.1) | — |
