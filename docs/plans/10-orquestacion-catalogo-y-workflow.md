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
  costClass: "low" | "mid" | "high" | "unknown";           // desconocido ≠ barato
  observed: { runs: number; succeeded: number; medianUsd: number | null; medianMs: number } | null;
  enabled: boolean; disabledReason?: string;
}
```

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
| W4 | el gasto conocido nunca superó el tope; el desconocido consta y requirió permiso explícito | `checkBudget` |
| W5 | toda tarea con `requested_by` está en una revisión aditiva válida y dentro de profundidad/alcance | `checkDelegation` |
| W6 | el enrutador es una función: mismas entradas ⇒ misma asignación | prueba de propiedad |

## 7. Obligaciones de prueba (sin modelo)

1. Plan con perfil inexistente, deshabilitado, de tipo incompatible, asesor con alcance de escritura,
   sobre presupuesto: cada uno rechazado con su código.
2. Propiedad: planes y catálogos aleatorios; ninguna asignación aceptada viola W1.
3. Compuerta: cambiar el plan tras aprobar invalida la aprobación; la tarea queda bloqueada.
4. Delegación: petición fuera de alcance, demasiado profunda, con ciclo o sobre presupuesto ⇒ rechazada
   y el árbol intacto; petición válida ⇒ aparece en el DAG con `requested_by`.
5. Asesor "malicioso" (devuelve un parche en su texto): no cambia nada (W2).
6. Determinismo del enrutador (W6).

## 8. Hipótesis y criterio de falsación

- H-R: el enrutamiento guiado por el catálogo medido iguala o mejora costo y tasa de éxito frente a un
  perfil fijo. **Se falsa** si, con N≥20 por brazo, no mejora ninguna de las dos métricas: entonces el
  enrutador queda determinista y el modelo solo descompone.
- H-A: las aprobaciones ligadas al digest no añaden fallos de corrida (solo latencia humana).

## 9. Decisiones que requieren aprobación

| # | Decisión | Alternativa |
|---|---|---|
| D1 | El enrutador determinista manda; el modelo solo sugiere perfil | dejar elegir al modelo con validación a posteriori |
| D2 | `maxDepth` por defecto = 2 | 1 (sin subtareas de subtareas) |
| D3 | Un perfil de costo `unknown` exige permiso por perfil | tratarlo como alto y permitir |
