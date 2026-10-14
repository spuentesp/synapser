# Probar agente (plan 14, Q5.5): investigación

Estado: **investigación**, sin construir. Su diseño va al final del plan 14, como decidió el usuario. Q3.4 (el diseño
de «probar agente» en la interfaz) queda bloqueada hasta entonces. Este documento no contiene resultados medidos.

## Qué se pide

Que un operador pruebe un agente antes de usarlo en un workflow: un encargo corto, sobre una copia del proyecto, con los
permisos y el costo reales del perfil, y que vea qué hizo el agente. Nada de la prueba debe tocar el repositorio ni la
biblioteca.

## Lo que el código ya da

- **El runner ya trabaja en un directorio desechable.** `src/agents/runner.ts:112–114` crea `scratch`, `base` (lo que el
  agente recibió) y `work` (lo que edita). Un CLI edita `work`, nunca el repositorio.
- **Pero los cambios entran al espacio de trabajo por el ejecutor.** Los cambios se aplican con acciones del diario
  (`src/agents/adapters.ts:143`, `changedPaths`). Por eso una prueba debe pasar como `workspaceRoot` una copia
  desechable. Si pasa el repositorio real, la aplicación lo toca.
- **No hace falta un tipo de corrida nuevo.** `AgentRunRequest` (`src/agents/port.ts`) ya admite `workspaceRoot`,
  `budget` (para el bucle nativo) y `deadlineMs`. Una prueba es un agente, un encargo y una copia.

## Necesidades y huecos

### Copia desechable

- Hay que decidir qué se copia. Propuesta: el proyecto sin `.git`, `node_modules` ni el estado de Synapser.
- Hay que fijar un tamaño máximo y limpiar siempre al terminar, también si falla.
- **Hueco:** no existe una operación del servidor que haga esa copia. `takeSnapshot` copia a `base` dentro del runner,
  pero para la prueba hace falta una copia propia, con su límite.

### Costo

- **Solo `claude-code` admite tope por corrida en dólares** (`--max-budget-usd`, `src/agents/claude-code.ts:18` y `:38`).
- **`codex`, `kimi` y `mimo` no tienen bandera de presupuesto.** `validateProfile` ya rechaza `maxBudgetUsd` para ellos
  (`src/agents/profile.ts:203`, `:208`, `:213`). Para esos, el único tope real es el tiempo (`timeoutMs`).
- **El bucle nativo se limita por tokens y llamadas**, no por dólares: `BudgetManager` en `src/workflow/engine.ts`.
- Consecuencia: la prueba con un CLI sin tope en dólares solo puede acotarse por tiempo, y la interfaz debe decirlo
  antes de lanzar.

### Permisos

- La prueba usa los permisos del perfil tal cual. No eleva nada. `validateProfile` ya fija los modos válidos de cada
  adaptador (`src/agents/profile.ts:194` a `:216`).
- **Límite conocido:** los CLI tienen red si la tienen en su propio entorno. No hay aislamiento de red (decisión D5 del
  plan 15). La prueba no lo resuelve, y debe mostrarlo.

### Proveedor sin costo

- Para agentes nativos, la prueba podría usar un proveedor de biblioteca marcado como «de prueba», con tarifas en cero.
- **Hueco:** las tarifas vienen de la configuración (`usdPer1MIn`, `usdPer1MOut`) y el repositorio no declara ningún
  proveedor sin costo. Hay que decidir si la marca es un campo del proveedor o un proveedor del archivo. Es la fuente de
  tarifas, decisión D4 del plan 15.
- Un proveedor de loopback con tarifas en cero sirve para pruebas de integración, pero no para probar un modelo real.

### Registro

- La prueba no debe parecer una corrida de workflow. Propuesta: un evento `agent_trial` en el diario del servidor, con
  el agente, el digest del perfil, la copia, el tope aplicado y el resultado.

## Propuesta de diseño (para después)

1. **Entrada:** un agente, un encargo de una línea, un tope de tiempo y, si el agente es `claude-code`, un tope en dólares.
2. **Copia:** desechable y con límite de tamaño. El ejecutor aplica los cambios en la copia.
3. **Salida:** los archivos que cambió, el texto final del agente, el costo declarado y el motivo de cualquier límite
   que se alcanzó.
4. **Garantía:** ningún cambio al repositorio ni a la biblioteca.

## Preguntas que son del usuario

- ¿El tope de tiempo es obligatorio para los CLI sin tope en dólares? Propuesta: sí.
- ¿La marca de proveedor de prueba va en el proveedor o en el archivo? (D4 del plan 15.)
- ¿La copia se borra siempre, o se conserva para inspección? Propuesta: se borra, y el registro se conserva.

## Lo que esta investigación no hace

No construye la prueba, no mide costos y no ejecuta ningún agente. Q3.4 sigue bloqueada hasta que el usuario responda
las preguntas anteriores.
