# Plan 14 — Diseño desde la UI: biblioteca, adaptadores por agente y skills

Estado: **propuesta** (14 oct). Motivo: todo lo configurable hoy vive en archivos JSON y las vistas
quedan vacías sin corridas. El operador debe poder diseñar workflows y agentes, inyectar skills y elegir
cómo se usa cada agente, desde la consola.

## 1. Modos headless verificados (CLI instalados en esta máquina)

| CLI | No interactivo | Salida estructurada | Skills / contexto inyectable | Permisos |
|---|---|---|---|---|
| claude 2.1 | `-p` | `--output-format json\|stream-json`, `--json-schema` | `--append-system-prompt`, `--system-prompt`, `--agents <json>`, `--plugin-dir` (plugins con skills), `--settings`, `--setting-sources`, `--disable-slash-commands`; `.claude/skills/<n>/SKILL.md` en el proyecto | `--allowedTools`, `--disallowedTools`, `--tools`, `--permission-mode`, `--max-budget-usd`, `--strict-mcp-config` + `--mcp-config` |
| codex 0.160 | `codex exec` | `--json`, `--output-schema`, `-o` | `$CODEX_HOME/skills/<n>/SKILL.md`, `AGENTS.md` en el directorio, `-c key=value`, `--ignore-user-config`, `--ignore-rules` | `-s read-only\|workspace-write`, `--ephemeral`, `-C` |
| kimi 2.1 | `-p` | `--output-format stream-json` | `--skills-dir <dir>` (repetible), `--agent-file <md>`, `--agent` | `--yolo`, `--auto`, `--plan` |
| mimo | `mimo run` | `--format json` | `skills.paths` en `mimocode.jsonc`, `--agent <n>` (`mimo agent create`), `-f` adjuntar archivos, `--pure` | `--dangerously-skip-permissions` |

Consecuencia: la inyección de skills **no es uniforme**. Cada agente tiene su mecanismo nativo; donde no
existe, se cae a anteponer el texto de la skill al prompt (declarado como `prompt-prepend`).

## 2. Un adaptador por agente

Hoy hay un `CliOneShotRunner` genérico con parsers. Se separa en adaptadores que declaran **capacidades**
y construyen su propia invocación:

```
AgentAdapter {
  id, displayName
  capabilities: { headless, structuredOutput, skills: native|prompt-prepend|none,
                  mcp, permissionModes, budgetFlag, resume }
  build(profile, task, injected: InjectedSkills) -> { argv, env, files }   // todo lo que pone en la copia/HOME
  parse(stdout) -> ParsedRun
}
```

Adaptadores: `claude-code`, `codex`, `kimi`, `mimo`, `native` (bucle propio, cualquier endpoint),
`generic-cli` (envoltorio con parser plain). El perfil elige adaptador y sobreescribe parámetros; añadir un
agente nuevo = un archivo adaptador + pruebas contra su binario real.

### 2.1 Proveedores (el modo `native`)

`native` no es un CLI: es el bucle de Synapser conectado **directamente a un proveedor de modelos**.
Por eso el proveedor es una entidad propia, separada del agente:

```
Provider { id, protocol: openai-compatible, baseUrl, apiKeyEnv[], models[{id, usdPer1MIn, usdPer1MOut}] }
Agent(native) { provider, model, temperature, tier, role, skills[] }
```

- Un proveedor se define una vez (Nebius Token Factory, OpenAI, OpenRouter, vLLM/Ollama local…) y lo
  usan varios agentes, con modelos y precios distintos; el precio declarado alimenta el costo conocido.
- Hoy solo existe el protocolo `openai-compatible` (Nemotron va por ahí). Un proveedor con otro
  protocolo (Anthropic API, Gemini) es un adaptador de proveedor nuevo, no un agente nuevo.
- Los roles de Synapser (planificador, asesor, chat, reparación) se asignan a un **proveedor+modelo**
  desde la UI, no fijos en el código como hoy.
- Prueba de conexión por proveedor: lista modelos y hace una llamada mínima, sin registrar la clave. La prueba
  no escribe en el ledger (su `role` sería falso): devuelve su uso y el costo estimado con la tarifa declarada.

## 3. Skills

- **Biblioteca** en el directorio de estado (`library/skills/<id>/SKILL.md` + `meta.json`), no en el repo.
  Cada skill: nombre, descripción, contenido, versión (digest), etiquetas, agentes compatibles.
- **Inyección** por agente según su mecanismo: `.claude/skills` en la copia y HOME efímero (claude),
  `CODEX_HOME/skills` efímero (codex), `--skills-dir` (kimi), prompt (resto). El HOME efímero ya existe.
- **Registro**: cada corrida de agente guarda qué skills (id + digest) recibió y por qué mecanismo.
- **Elección**: por perfil (siempre), por tarea (el planificador sugiere, el validador comprueba que la
  skill exista y sea compatible), y por workflow (el operador fija).

## 4. Dos modos de uso de un agente

- **Directo** (`native`): Synapser conduce el bucle, ve cada herramienta, aplica compuertas por paso;
  skills = texto en el sistema del modelo.
- **Por CLI** (claude, codex, kimi, mimo): el CLI conduce su propio bucle dentro de la copia aislada;
  Synapser controla entradas (skills, permisos, presupuesto), recoge el cambio y lo integra.
- El perfil lo declara y la UI lo muestra: lo que se puede y no se puede controlar en cada modo.

## 5. Diseñadores (UI)

- **Diseñador de workflow**: formulario con título, descripción, metas, no-metas con guardas y
  constructor de condiciones por tipo de verificador (con validación en vivo contra el validador real);
  vista previa del JSON; **plantillas** parametrizadas (`library/templates`), con unas integradas
  (cambio acotado con pruebas, investigación con citas, revisión de PR, migración con no-metas).
Implementado (Q3.2): las cuatro plantillas integradas son presets con parámetros declarados (`workflow-templates.ts`):
rellenan el formulario y el validador del servidor decide qué se guarda. Las plantillas guardadas en la biblioteca
siguen sin esquema: es decisión abierta.
- **Comprobación en vivo** (Q3.1): el diseñador consulta el validador del servidor (`POST /api/designer/check`), que
  no escribe nada; «Guardar» solo se habilita con un documento que ese validador acepta.
- **No-metas editables** (Q3.1): cada enunciado y su compuerta opcional son una misma fila del borrador; cambiar,
  quitar o reordenar un enunciado no puede asociar su compuerta a otra fila ni descartarla silenciosamente.
- **Diseñador de agente** (Q3.3): en modo `extends` se ven los controles efectivos heredados del perfil base; en modo
  `native` se explican los controles que no aplican. Skills, permisos, presupuesto CLI y pool que fija el operador
  son visibles/read-only según corresponda y no se escriben desde el documento de biblioteca.
- **Diseñador de agente**: elegir adaptador, nivel, rol, permisos, presupuesto, pool, skills; botón
  «probar» que corre una tarea trivial en una copia desechable y muestra el resultado y el costo.
- **Biblioteca**: skills, plantillas y agentes versionados; cambios con evento en el ledger. La prueba de conexión
  de un proveedor usa el documento GUARDADO (`POST /api/library/providers/:id/test`): nunca una URL del cuerpo de la
  petición. Una página ajena no puede hacer salir la clave hacia un destino suyo; un proceso local que lea el token de
  sesión sí puede, porque un documento guardado puede nombrar cualquier endpoint https y cualquier variable de entorno
  del servidor (límite declarado, sección 40 del documento de diseño).

## 6. Pantallas sin datos

Causa: las vistas por corrida dependen de una corrida seleccionada y no explican qué falta. Se corrige
con un **inicio** (workflows activos, compuertas pendientes, agentes, costo acumulado), estados vacíos que
dicen qué hacer y enlazan al diseñador, y la corrida del workflow seleccionado como contexto por defecto.
Implementado: el inicio (`#home`) lee `GET /api/home`, que suma el costo de las corridas y del planificador, como la
vista Costo, y cuenta aparte las ejecuciones sin costo registrado; cuando no hay corridas, las vistas por corrida explican qué hacer y enlazan al diseñador
(antes mostraban esqueletos para siempre); y seleccionar un workflow fija su corrida como contexto. Las
intervenciones del asesor y los efectos solicitados se leen en el detalle del workflow (`GET …/interventions`,
`GET …/effects`), solo lectura: las decisiones se toman en Aprobaciones.

## 7. Invariantes (con verificador)

- **L1** Una skill inyectada es de la biblioteca y su digest queda en la corrida; ninguna otra entra.
- **L2** Una skill no amplía permisos: no puede cambiar `--allowedTools`, sandbox ni presupuesto.
- **L3** Editar la biblioteca no cambia un workflow en curso: se congela al iniciar.
- **L4** Toda edición desde la UI exige token y queda como evento; la configuración inválida se rechaza entera.
- **L5** Un adaptador solo emite flags que su tabla de capacidades declara (prueba contra `--help` real).
- **L6** Cada rol del sistema corre sobre el proveedor y el modelo declarados en la configuración final. Un rol
  que el archivo nombra reemplaza su asignación por defecto por completo: proveedor y modelo son obligatorios y
  no hereda fallbacks de otro proveedor. Los roles que no nombra conservan su asignación y se validan igual
  contra los proveedores finales. Un documento inválido se rechaza entero.
- **T1** Una prueba de agente solo puede modificar una copia temporal del workspace. La copia omite estado,
  VCS y dependencias instaladas; su tamaño y número de archivos tienen límites; siempre se elimina al terminar.
- **T2** Una prueba tiene límite temporal y no amplía capacidades ni presupuestos del perfil. El tope en dólares
  solo se admite para adaptadores que lo soportan y no puede superar el del perfil. La respuesta declara
  `networkIsolated: false` mientras los CLI no tengan aislamiento de red.
- **T3** Cada prueba deja un evento `agent_trial` en `_server`, ligado al digest del perfil y de la copia, los
  límites, resultado, skills y rutas cambiadas. El texto de salida se guarda como artefacto; el prompt no se copia
  al evento.
- **W1** En el diseñador, una compuerta de no-meta se guarda con el mismo enunciado que la acompaña; JSON inválido
  bloquea la comprobación y el guardado, y borrar esa fila borra también su compuerta.
- **W2** El diseñador de agente solo edita campos admitidos por el esquema de cada modo; el perfil base, controles
  de CLI y asignaciones de skills que decide el archivo se presentan como límites de solo lectura.

Verificación y falsación de la inyección:

- L1 se verifica en el límite del runner: exige procedencia `library`, recalcula el digest sobre los bytes,
  rechaza ids duplicados y rutas que escapen o atraviesen enlaces, y registra `id + digest + mecanismo` en
  `agent_runs` y su evento. Se falsa intentando inyectar procedencia ajena, contenido con digest alterado,
  duplicados, recorrido `..` o un padre enlazado.
- L2 se verifica construyendo la misma invocación con y sin skills y comparando sus flags protegidos de
  herramientas, permisos, sandbox y presupuesto. Se falsa con un adaptador deliberadamente defectuoso que
  cambia `--allowedTools` o `--max-budget-usd` al recibir una skill.
- L5 se verifica extrayendo los flags de todas las variantes construidas por cada adaptador, exigiendo
  igualdad con `capabilities.cliFlags`, y buscando cada declaración en el `--help` del binario instalado.
  Se falsa al emitir un flag no declarado o al declarar uno que el binario real no reconoce.
- W1 se verifica editando en Chromium un workflow real con una compuerta, cambiando el enunciado y comprobando
  la vista previa y el documento persistido. Se falsa cambiando el texto, borrando la fila o introduciendo JSON
  inválido: la compuerta no debe migrar a otra fila ni guardarse silenciosamente.
- W2 se verifica en Chromium alternando `native`/`extends`, leyendo los controles heredados y las skills asignadas
  en modo solo lectura. `test/api/library.test.ts` verifica que la ruta ofrece los campos efectivos seguros y que
  `test/library/agent-rules.test.ts` rechaza controles reservados en documentos. Se falsa si el diseñador permite
  editar una clave fuera del esquema o no muestra un valor que fija el archivo.
- L4 usa el journal `_server` como autoridad: cada versión de biblioteca se guarda primero como blob por
  digest y luego como evento encadenado con actor; `state/library/` es una proyección reconstruible. El
  almacén se falsa alterando `current.json` fuera del journal y verifica que al reabrir restaura los bytes
  auditados. La exigencia de token y mismo origen se verifica en `test/api/library.test.ts` (Q2.6), en el límite
  HTTP: escrituras sin token o con origen ajeno o malformado no cambian nada, y una configuración inválida se
  rechaza entera con todos sus problemas. Se falsa quitando el guardia o la validación. Los documentos admiten
  decimales (precios); la forma canónica de los digests de peticiones y journal sigue siendo solo enteros
  (`digest/canonical.ts`, opción `decimals`, aprobada por el usuario). Los lectores (`doctor`, `config show`) usan un manejador de solo
  lectura: no sincronizan la proyección ni crean el journal (`test/library/read.test.ts`).
- L6 se verifica en `test/model/system-roles.test.ts`: sin bloque `roles` la configuración equivale a la
  predeterminada; un rol movido a otro proveedor no hereda fallbacks; un documento con varios problemas los
  lista todos juntos; redefinir un proveedor que usa un rol por defecto falla al cargar; y un `chat.send` a
  través de `createRuntime` llega al proveedor configurado, con su modelo, su clave y su tarifa declarada. Se
  falsa con un runtime que ignora los roles configurados (debe fallar la prueba de extremo a extremo) y con un
  cargador que omite la validación de asignaciones por defecto (debe fallar la prueba de redefinición).
- T1 se verifica comparando el digest del workspace original antes y después, comprobando que el runner recibe
  solo el destino temporal y que el directorio se elimina tanto tras éxito como tras error; se falsa inyectando
  el workspace real al ejecutor o saltándose la limpieza.
- T2 se verifica para cada adaptador: la duración efectiva no supera el límite de la petición ni el del perfil,
  los topes en dólares rechazados no inician el proceso y la respuesta advierte que la red de CLI no está aislada.
  Se falsa quitando la cota, elevando el presupuesto o afirmando aislamiento.
- T3 se verifica con el ledger `_server`: cada invocación tiene evento con los digests y límites, la salida se
  resuelve desde artefacto y no contiene prompt ni valores de credenciales. Se falsa quitando el evento, cambiando
  el digest de perfil/copia o guardando el prompt en el evento.
- L3 se verifica en `test/library/freeze.test.ts` y `test/workflow/library-freeze.test.ts`: la instantánea se
  copia a los artefactos de la corrida y se lee por digest, así que sobrevive sin los artefactos de `_server`;
  la primera instantánea de una corrida gana; y un motor que edita la biblioteca en mitad de la corrida sigue
  leyendo la versión de arranque. Se falsa con lecturas en vivo, que hacen fallar la prueba del motor. Desde Q5.1 las corridas leen su instantánea (`src/library/resolve.ts`): ningún otro camino lee la biblioteca viva durante una corrida.

## 8. Fases

| Fase | Entrega | Verificación |
|---|---|---|
| Q1 | Adaptadores por agente + capacidades + inyección de skills por mecanismo nativo | pruebas por adaptador; L2, L5; corrida real por CLI |
| Q2 | Biblioteca (proveedores, skills, plantillas, agentes) + API + eventos; roles del sistema asignables a proveedor+modelo | L1, L3, L4, L6 |
| Q3 | Diseñadores de workflow y agente, plantillas integradas, «probar agente» | prueba en navegador real |
| Q4 | Inicio y estados vacíos | capturas |
