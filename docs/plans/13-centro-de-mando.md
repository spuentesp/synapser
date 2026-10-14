# Plan 13 — Synapser como centro de mando de multiagentes

Caso de uso objetivo (13 oct): Synapser es un **centro de mando** al que un agente se conecta por
**MCP**; desde ahí se **configuran, ejecutan y orquestan enjambres** de CLIs o agentes configurables, se
imponen **compuertas duras** sobre acciones con efectos (p. ej. `git push`), y **Nemotron** actúa como
capa asesora y orquestadora: descompone, asigna por capacidad, aconseja, corrige (inyectar, revertir,
replantear) y hace *pushback* con evidencia (Tavily). Un usuario entrega un **workflow** (descripción,
objetivos, no-objetivos, condiciones de aceptación) que termina cuando **todas** sus condiciones se
cumplen. Nemotron también es la **interfaz de chat** en la UI para pedir y adaptar workflows.

Este plan mide la distancia a ese caso y lo diseña con la misma disciplina del resto: contrato,
invariantes, obligaciones de prueba y criterio de falsación.

## 1. Qué tan lejos estamos

| # | Capacidad pedida | Estado | Lo que ya existe | Lo que falta |
|---|---|---|---|---|
| 1 | Conectarse a Synapser **por MCP** desde un agente | ❌ | Solo somos *cliente* MCP de Zoanthrope (`src/zoo/`) | Servidor MCP (stdio y HTTP local), identidad y rol de sesión, catálogo de herramientas (§3) |
| 2a | Configurar y ejecutar **enjambres** de CLIs/agentes | ◐ | Puerto `AgentRunner`, perfiles de claude/codex/kimi, broker, DAG, concurrencia, delegación, reintentos | Perfiles editables en runtime, **pools y niveles**, descubrimiento de CLIs instalados, adaptador de agente HTTP/OpenAI-compatible (§7) |
| 2b | **Compuertas duras** sobre acciones (push, deploy…) | ◐ | Compuertas de *paso* ligadas al digest del plan (`gates.ts`), aprobación por UI | Compuertas sobre **efectos**: broker de efectos, política, canales (UI/CLI/MCP), aprobación ligada al efecto exacto, endurecer el entorno del CLI (§5) |
| 3a | Nemotron **asesor**: inyectar contenido, replantear | ◐ | Supervisor que planifica al inicio; ronda de reparación tras fallo | Observador continuo, intervenciones tipadas, inyección por adaptador (§6) |
| 3b | **Revertir** una tarea de un agente | ❌ | Recuperación solo hacia adelante (por diseño) | Acciones compensatorias a través del ejecutor (§6.3) |
| 3c | **Pushback** con Tavily | ◐ | Puerto de investigación, guarda, citas verificadas | Crítica previa al despacho: supuestos → búsqueda → hallazgos con fuente → retención (§6.4) |
| 4 | **Workflow** = descripción + objetivos + no-objetivos + condiciones atómicas | ◐ | Misión con objetivo, plan, aceptación por comandos y comprobación de citas | Entidad `Workflow`, condiciones de primera clase con *checker*, no-objetivos exigibles, ciclo de vida (§4) |
| 5 | **Descomponer y asignar por capacidad** (barato/medio/avanzado) | ◐ | Catálogo con costo conocido/estimado/desconocido, enrutador determinista, escalado a otro perfil | Niveles (`tier`), complejidad requerida por tarea, escalera de escalado por fallo, límites por pool (§7) |
| 6 | **Chat** con Nemotron en la UI para pedir workflows | ❌ | UI con API y SSE; modelo por rol | Rol `advisor`/`chat`, conversación persistida, herramientas del chat con borradores y confirmación humana, componentes de chat (§8) |
| 7 | El usuario **adapta** perfiles, políticas, condiciones | ◐ | Plan revisable (aditivo), aprobaciones | Configuración versionada y auditada, edición por UI/CLI/MCP (§9) |

Lectura: el **núcleo difícil** (ejecutor de un solo escritor, ledger encadenado, router, compuertas
de paso, delegación, investigación con procedencia, UI) está hecho. Falta **la cara hacia afuera**
(MCP, chat, configuración), **el modelo de producto** (workflow/condiciones) y **dos capacidades
nuevas de fondo**: compuertas sobre efectos y revertir. Ninguna contradice lo construido; todas se
apoyan en él.

## 2. Actores y objetos

| Actor | Quién es | Puede |
|---|---|---|
| **Operador** | la persona | todo, por UI/CLI; es la única fuente de aprobación |
| **Iniciador** | el agente (p. ej. Claude Code) que lanzó el workflow por MCP | crear/consultar/cancelar sus workflows; relayar un OK del operador solo con *desafío* (§5.4) |
| **Trabajador** | un agente de un enjambre | leer contexto, pedir subtareas y **efectos**; jamás aprobar |
| **Asesor** | Nemotron en rol `advisor` | observar, proponer **intervenciones**; nunca ejecutar por sí mismo |

Objetos nuevos: `Workflow`, `Condition`, `EffectRequest`, `Policy`, `Intervention`, `Pool`,
`Conversation`. Todos son eventos del ledger encadenado (no una base paralela).

## 3. Synapser como servidor MCP

Transportes: **stdio** (un agente local lo lanza como subproceso) y **HTTP local** `127.0.0.1` con
token de sesión (varios agentes). El servidor **no** usa Zoanthrope para esto: es otra superficie.

Identidad: cada sesión MCP declara `client` y recibe un `session_id`; su **rol** lo fija Synapser
(no el cliente): `initiator` por defecto; `worker` solo para procesos que Synapser mismo lanzó y a los
que entregó un token de tarea. Cada llamada queda en el ledger con sesión y rol.

| Herramienta | Rol | Efecto |
|---|---|---|
| `workflow_create` | initiator | borrador (no ejecuta) con descripción, objetivos, no-objetivos, condiciones |
| `workflow_start` | initiator | arranca si la política lo permite; si exige OK, queda `AWAITING_START` |
| `workflow_status`, `workflow_events` | initiator | estado y ledger (con `since_seq`) |
| `workflow_cancel` | initiator | cancela sus workflows |
| `gate_list` | initiator, operator | compuertas pendientes de **sus** workflows |
| `gate_approve`, `gate_reject` | initiator | solo con **código de desafío** entregado por el canal humano (§5.4) |
| `advise` | initiator | pregunta consultiva a Nemotron con el estado del workflow (solo lectura) |
| `effect_request` | worker | pide un efecto (§5); devuelve `PENDING` y un id |
| `effect_status` | worker | resultado del efecto, con evidencia |
| `request_subtask` | worker | ya existe (W5) |
| `catalog_list` | initiator | perfiles, niveles, costo, disponibilidad |

Invariantes: **M1** un `worker` no tiene herramientas de aprobación; **M2** el rol no lo elige el
cliente; **M3** toda llamada queda registrada con identidad; **M4** una herramienta de solo lectura no
cambia el estado del ledger salvo su propio registro de llamada.

## 4. Workflow y condiciones

```ts
interface Workflow {
  id: string; title: string;
  description: string;
  goals: string[];            // lo que se quiere lograr
  nonGoals: string[];         // lo que NO debe pasar (se hace cumplir, §4.3)
  conditions: Condition[];    // se cumplen TODAS → DONE
  policy: PolicyRef;          // compuertas y límites en vigor (hash)
  budget: { usd?: number; minutes?: number };
}
interface Condition {
  id: string; statement: string;                 // "las pruebas de facturación pasan"
  checker: Checker;                               // cómo se comprueba
  required: boolean;                              // false = informativa
  waivedBy?: { actor: string; reason: string };  // exención auditada
}
type Checker =
  | { kind: "command"; commandId: string }                 // allowlist + snapshot consistente
  | { kind: "citations"; file: string; min: number }       // procedencia verificada
  | { kind: "diff"; require?: string[]; forbid?: string[] }// rutas que deben/no deben cambiar
  | { kind: "file"; path: string; assert: "exists" | "absent" | { contains: string } }
  | { kind: "approval"; prompt: string }                   // decisión humana explícita
  | { kind: "review"; profile: string; rubric: string }    // juicio de un agente: evidencia SECUNDARIA
```

### 4.1 Ciclo de vida

`DRAFT → AWAITING_START → PLANNING → RUNNING → VERIFYING → DONE | FAILED | CANCELLED`, con
`PAUSED` transversal. `VERIFYING` evalúa condiciones sobre **un snapshot consistente**; si alguna
falla, vuelve a `RUNNING` dentro de los límites (rondas de reparación ya existentes).

### 4.2 Condiciones ↔ tareas

Nemotron **descompone** cada condición en tareas atómicas (cada tarea declara la condición a la que
sirve). Una condición está `SATISFIED` solo con **evidencia**: salida de un *checker* determinista
sobre el snapshot, o una decisión humana. Un `review` (juicio de un agente) **no basta por sí solo**
para una condición `required` salvo exención explícita: el sistema no certifica con la palabra de un
modelo (ya es S INV 4).

### 4.3 No-objetivos exigibles

Cada no-objetivo se traduce a un **guardián** comprobable: rutas prohibidas (`diff.forbid`), dependencias
nuevas, tamaño máximo del cambio, o un efecto vetado por política. Una violación detectada **no marca
la condición como cumplida** y abre una intervención (§6). Si un no-objetivo no se puede mecanizar,
Nemotron lo dice al crear el borrador y el operador decide si lo acepta como solo informativo.

### 4.4 Invariantes

**C1** un workflow es `DONE` solo si toda condición `required` está `SATISFIED` o exenta, con evidencia
en el ledger. **C2** un cambio a las condiciones es una revisión del workflow y invalida el `DONE`
previo. **C3** una exención tiene actor y motivo. **C4** un guardián de no-objetivo se evalúa sobre el
mismo snapshot que las condiciones.

## 5. Compuertas duras sobre efectos

### 5.1 Principio: capacidad, no cortesía

Un agente puede obedecer o no; una compuerta que dependa de que obedezca no es dura. La compuerta es
**dura** cuando el agente **no tiene la capacidad**: la credencial y el acto viven en Synapser, y el
agente solo puede *pedir*. Por eso el efecto lo **ejecuta Synapser** tras la aprobación, nunca el agente.

### 5.2 Modelo de amenaza (qué se cubre y qué no)

| Vía de evasión | Control |
|---|---|
| El agente ejecuta `git push` en su shell | su copia aislada **no tiene remoto**; `HOME` sustituido por un directorio temporal con solo la configuración propia de la herramienta; `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, `GIT_ASKPASS=/bin/false`, `GIT_TERMINAL_PROMPT=0`; sin `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`. **Hoy el CLI hereda `HOME`** (límite declarado en el plan 08): se corrige aquí |
| Usa un token que encuentra en el entorno/archivos | lista de entorno permitida (existe) + escaneo de la copia y del entorno antes de lanzar |
| Pide el efecto con parámetros distintos a los aprobados | la aprobación se liga al **digest del efecto exacto** (§5.3) |
| Reutiliza una aprobación vieja | un solo uso, con caducidad, ligada a HEAD y rama |
| Se aprueba a sí mismo | el solicitante no puede aprobar; el canal MCP exige desafío fuera de banda (§5.4) |
| Inyección de prompt le hace pedir un efecto peligroso | llega a la compuerta; el humano ve **qué** va a ocurrir, no lo que el agente dice |
| Un agente con red exfiltra datos que ya tiene | **no se cubre** (necesita red para su propia API): se reduce quitando secretos, no la red. Se declara |

### 5.3 Efectos, política y ejecución

```ts
interface EffectRequest {
  id: string; workflowId: string; taskId: string; requestedBy: string;   // sesión de worker
  kind: "git.push" | "git.commit" | "gh.pr" | "http.request" | "shell.network" | "deploy" | string;
  params: Record<string, unknown>;       // {remote, branch, head_sha, …}
  digest: string;                        // sha256 de kind + params canónicos + base del árbol
  summary: string;                       // lo que verá el humano, generado por Synapser, no por el agente
}
```

- **Política** (JSON versionado, hash en cada evento): reglas `match → decision` donde `decision` ∈
  `allow | ask | deny`, con `approvers`, `channels`, `ttl` y `scope` (`once` | `workflow`). **Por defecto
  `deny`** para todo `kind` desconocido.
- Resumen **calculado por Synapser** (para `git.push`: rama, remoto, `HEAD`, commits y archivos que
  suben). El texto del agente no entra en la decisión.
- Ejecución: Synapser verifica que el estado actual coincide con `digest` (HEAD, rama); si no,
  `STALE_EFFECT`, la aprobación no vale. Ejecuta con **sus** credenciales y registra stdout/exit y la
  postcondición (`git ls-remote` devuelve el SHA aprobado).

### 5.4 Canales de aprobación

| Canal | Cómo | Notas |
|---|---|---|
| **UI** | botón con token de sesión y origen verificado | existe para pasos; se extiende a efectos |
| **CLI** | `synapser gate approve <id>` en la consola del operador | lee el ledger local; identidad = usuario del SO |
| **MCP + desafío** | el agente iniciador llama `gate_approve(id, code)` | `code` es un valor de un solo uso que Synapser muestra **solo** en UI/consola; el humano se lo da al agente cuando decide. Un agente inyectado no puede conocerlo |

**G1** ningún efecto con política `ask` se ejecuta sin una decisión `APPROVED` vigente. **G2** la
aprobación está ligada a `digest`; un parámetro distinto la invalida. **G3** el solicitante nunca
aprueba su propio efecto. **G4** el efecto lo ejecuta el broker, no el agente. **G5** un efecto
`deny` no tiene canal de aprobación. **G6** la política en vigor consta en cada decisión.

### 5.5 Obligaciones de prueba

1. Un CLI doble intenta `git push` desde su copia: falla por falta de remoto y de credenciales.
2. Con política `ask`: `effect_request` queda `PENDING`; nada llega al remoto; aprobar por cada canal
   lo ejecuta una vez.
3. Mismo `kind` con otra rama o SHA bajo una aprobación previa → rechazado (`STALE_EFFECT`/`DIGEST`).
4. El solicitante llama `gate_approve` sin código o con código ajeno → rechazado y registrado.
5. Política ausente → `deny`. Cambio de política a mitad → decisiones posteriores citan el hash nuevo.
6. Propiedad: ningún camino de código que ejecuta un efecto es alcanzable sin pasar por `decide()`.

## 6. Nemotron como asesor y corrector

### 6.1 Observación y disparadores

El asesor lee `swarmState` y el ledger (solo lectura). Se activa por **eventos**, no por reloj:
tarea sin progreso, vistas rancias repetidas, costo fuera de rango, fallo de condición, plan nuevo,
pushback pendiente, petición del operador. Cada activación tiene presupuesto (tokens, llamadas,
intervenciones por tarea).

### 6.2 Intervenciones (tipadas y validadas)

El asesor **propone**; el control **valida y aplica**. Nunca ejecuta cambios por sí mismo.

| Intervención | Efecto | Compuerta por defecto |
|---|---|---|
| `inject_note(task, text)` | añade guía al contexto de la tarea | permitido |
| `escalate(task, tier)` | reintenta en un nivel superior | permitido (dentro de presupuesto) |
| `replan(task, split[])` | revisión aditiva (W5) con subtareas; la original queda `SUPERSEDED` | permitido |
| `hold(task, reason)` | pausa la tarea para decisión humana | permitido |
| `rollback(task)` | acciones compensatorias (§6.3) | **ask** (destructiva) |
| `pushback(task, findings)` | retiene el despacho (§6.4) | según severidad |

**Inyección por adaptador**: nativo → mensaje en el siguiente turno; CLI de un disparo → entra al
**próximo intento** (no se puede hablar a un proceso en vuelo); adaptadores interactivos → futuro.
Se declara en el perfil (`steerable: "turn" | "attempt"`), nunca se simula.

**A1** toda intervención nombra al asesor, el disparador y su evidencia. **A2** una intervención
inválida (esquema, alcance, presupuesto) se rechaza sin efecto. **A3** el asesor no puede aprobar
compuertas. **A4** las intervenciones por tarea y por misión están acotadas. **A5** lo que el asesor
inyecta es **texto marcado como guía del sistema**, no sale de contenido del repositorio ni de la web.

### 6.3 Revertir

Se mantiene "solo hacia adelante": **revertir es una acción nueva**, no deshacer historia.

1. Para cada acción `SETTLED` de la tarea, en orden inverso, se prepara una acción compensatoria cuyo
   *after* es el *before* original **solo si** el archivo está hoy en el *after* de esa acción.
2. Pasa por el ejecutor completo (claims, digest, `STALE_VIEW`, journal). I1 se mantiene por
   construcción: se basa en lo que hay en disco.
3. Si otro agente ya cambió el archivo, no se revierte esa parte: queda `REVERT_CONFLICT` con el
   detalle, y la tarea no vuelve a `PENDING` hasta que el operador decida.
4. La tarea revertida vuelve a `PENDING` con la nota inyectada y un contador de intentos.

**R1** revertir nunca sobrescribe bytes que no sean el *after* esperado. **R2** el resultado
(revertido / conflicto) consta archivo por archivo. **R3** los efectos externos ya ejecutados (un push)
**no son reversibles** por este camino: se declara y la política los trata como irreversibles.

### 6.4 Pushback con Tavily

Antes de despachar una tarea de riesgo (o por petición), el asesor extrae sus **supuestos**
verificables (versiones, APIs, deprecaciones), busca con el puerto de investigación (con guarda) y
produce `findings[]` con `severity`, `claim` y `sources[]` verificadas (`verifyCitations`). Severidad
alta ⇒ la tarea queda retenida en una compuerta **con las fuentes a la vista**.

**P1** un hallazgo sin fuente recuperada no se emite. **P2** el pushback no cambia el plan: propone
(el operador o la política deciden). **P3** la consulta pasa por la guarda de salida.

## 7. Pools, niveles y configuración de agentes

```ts
interface AgentProfile { /* existente */ tier: "cheap" | "standard" | "advanced";
  steerable: "turn" | "attempt"; homeOverlay?: string[]; pool?: string; }
interface Pool { id: string; members: string[]; maxConcurrent: number; budgetUsdPerDay?: number; }
```

- **Nivel requerido**: Nemotron etiqueta cada tarea atómica con `needs: {kind, minTier}` (investigar y
  revisar ⇒ `advanced`; construir ⇒ `standard`; un disparo ⇒ `cheap`).
- **Enrutador**: entre los candidatos de `tier ≥ minTier`, el de menor nivel y costo; **escalera**
  ante fallo (`cheap → standard → advanced`), acotada por reintentos y presupuesto.
- **Capacidad**: `maxConcurrent` y presupuesto por pool; una tarea espera cupo, no falla.
- **Descubrimiento**: `synapser doctor` detecta CLIs instalados (`claude`, `codex`, `kimi`, …),
  sondea versión y capacidades y propone perfiles; nada se habilita sin confirmación.
- **Agentes configurables**: además del CLI de un disparo, adaptador **HTTP compatible con OpenAI**
  (cualquier modelo detrás de un endpoint) bajo el mismo `AgentRunner`.

**T1** el enrutador respeta `minTier` y es una función. **T2** la escalera es finita y deja
`task_retry`. **T3** un pool nunca excede `maxConcurrent`.

## 8. Chat con Nemotron en la UI

- **Rol de modelo** `advisor` (mismo proveedor, configurable) y conversación persistida como eventos
  `chat_message` (hash encadenado como el resto; el contenido del usuario se marca como tal).
- **Herramientas del chat** (validadas, no libres): `draft_workflow`, `edit_draft`, `list_workflows`,
  `explain_run`, `show_gates`, `propose_intervention`. **No** tiene `approve` ni `start` automático:
  iniciar un workflow y aprobar compuertas son botones del humano.
- **Borradores**: el chat produce un `Workflow` en `DRAFT` visible y editable; el humano lo confirma.
- **Seguridad**: el contenido de repos, web y agentes que el chat cita es **dato**; las acciones del
  chat pasan por los mismos validadores que las de la API.
- **UI**: componentes de chat de shadcn (según el skill del proyecto), streaming por SSE, enlaces de
  evidencia (los mismos `seq`) en cada afirmación sobre una corrida.

**H1** el chat no puede aprobar ni iniciar. **H2** toda acción propuesta por el chat es un borrador o
una intervención validada, con su evento. **H3** toda cifra que el chat afirme sobre una corrida cita
`seq` (misma regla U2).

## 9. Configuración y adaptación

Un único almacén versionado (`synapser.config.json` + revisiones en el ledger) con perfiles, pools,
políticas y plantillas de workflow. Cada cambio es una **revisión** con actor, hash y motivo; los
eventos que dependen de ella (compuertas, despachos) citan el hash en vigor. Edición por UI, CLI
(`synapser config …`) y MCP (rol operador). **K1** ningún cambio de política se aplica retroactivamente
a una decisión ya tomada. **K2** una configuración inválida se rechaza entera.

## 10. Invariantes consolidados

M1–M4 (MCP) · C1–C4 (workflow) · G1–G6 (efectos) · A1–A5 (asesor) · R1–R3 (revertir) · P1–P3
(pushback) · T1–T3 (pools) · H1–H3 (chat) · K1–K2 (configuración). Cada uno con verificador en
`src/**/invariants.ts` y una prueba que lo viola a propósito (como W1–W5).

## 11. Falsación

- Si un agente real, en su copia endurecida, puede completar un `git push` por cualquier vía sin pasar
  por el broker, **G4 es falso** y el diseño de compuertas debe cambiar (no se parcha con política).
- Si la escalera de niveles no mejora éxito o costo frente a un perfil fijo (misma medición privada
  del A/B), se deja el enrutador por costo y los niveles solo como etiqueta.
- Si las intervenciones del asesor empeoran la tasa de éxito frente a no intervenir, quedan apagadas
  por defecto y solo se ofrece `advise`.

## 12. Plan por tramos (hasta el 30 oct, 10:00 PT)

| Tramo | Entrega | Salida verificable |
|---|---|---|
| P1 (3–4 d) | Modelo `Workflow`/`Condition` + checkers; **servidor MCP** stdio con roles; `synapser` CLI (`workflow`, `gate`) | C1–C4, M1–M4; un agente real crea y consulta un workflow por MCP |
| P2 (3 d) | **Broker de efectos** y política; endurecer el entorno del CLI; canales UI/CLI/MCP+desafío; `git.push` | G1–G6 con CLI doble y con `git` real contra un remoto local |
| P3 (3–4 d) | **Asesor**: observador, intervenciones tipadas, `inject`/`escalate`/`replan`/`hold`; pushback; revertir con conflictos | A1–A5, R1–R3, P1–P3 |
| P4 (2 d) | Niveles, pools, escalera, `synapser doctor`, adaptador HTTP | T1–T3 |
| P5 (2–3 d) | Chat en la UI, borradores, configuración desde la UI | H1–H3, K1–K2 |
| P6 (2 d) | Demo integrada, traducción, vídeo, formulario | lista de entrega |

Total ≈ 15–18 días con 17 disponibles: **no hay holgura**. Recorte en este orden: adaptador HTTP →
plantillas → revertir parcial (solo informar conflictos) → `escalate` automático. **No se recortan**:
MCP, workflow/condiciones, compuertas de efectos, `inject`, chat con borradores.

## 13. Decisiones que requieren tu aprobación

| # | Decisión | Recomendación |
|---|---|---|
| E1 | El efecto lo **ejecuta Synapser** con sus credenciales (el agente nunca las tiene) | sí: es lo que hace la compuerta dura |
| E2 | Aprobación por MCP solo con **desafío fuera de banda** | sí; sin él un agente inyectado se aprueba solo |
| E3 | `review` (juicio de agente) como evidencia **secundaria**, no suficiente para `required` | sí |
| E4 | Revertir = acciones compensatorias; los efectos externos son irreversibles | sí |
| E5 | MCP por **stdio primero**, HTTP local después | sí |
| E6 | Nemotron en el chat **no puede** iniciar ni aprobar | sí |
