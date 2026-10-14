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
- Prueba de conexión por proveedor: lista modelos y hace una llamada mínima, sin registrar la clave.

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
- **Diseñador de agente**: elegir adaptador, nivel, rol, permisos, presupuesto, pool, skills; botón
  «probar» que corre una tarea trivial en una copia desechable y muestra el resultado y el costo.
- **Biblioteca**: skills, plantillas y agentes versionados; cambios con evento en el ledger.

## 6. Pantallas sin datos

Causa: las vistas por corrida dependen de una corrida seleccionada y no explican qué falta. Se corrige
con un **inicio** (workflows activos, compuertas pendientes, agentes, costo acumulado), estados vacíos que
dicen qué hacer y enlazan al diseñador, y la corrida del workflow seleccionado como contexto por defecto.

## 7. Invariantes (con verificador)

- **L1** Una skill inyectada es de la biblioteca y su digest queda en la corrida; ninguna otra entra.
- **L2** Una skill no amplía permisos: no puede cambiar `--allowedTools`, sandbox ni presupuesto.
- **L3** Editar la biblioteca no cambia un workflow en curso: se congela al iniciar.
- **L4** Toda edición desde la UI exige token y queda como evento; la configuración inválida se rechaza entera.
- **L5** Un adaptador solo emite flags que su tabla de capacidades declara (prueba contra `--help` real).

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
- L4 usa el journal `_server` como autoridad: cada versión de biblioteca se guarda primero como blob por
  digest y luego como evento encadenado con actor; `state/library/` es una proyección reconstruible. El
  almacén se falsa alterando `current.json` fuera del journal y verifica que al reabrir restaura los bytes
  auditados. La exigencia de token y mismo origen se verifica en Q2.6, en el límite HTTP.

## 8. Fases

| Fase | Entrega | Verificación |
|---|---|---|
| Q1 | Adaptadores por agente + capacidades + inyección de skills por mecanismo nativo | pruebas por adaptador; L2, L5; corrida real por CLI |
| Q2 | Biblioteca (proveedores, skills, plantillas, agentes) + API + eventos; roles del sistema asignables a proveedor+modelo | L1, L3, L4 |
| Q3 | Diseñadores de workflow y agente, plantillas integradas, «probar agente» | prueba en navegador real |
| Q4 | Inicio y estados vacíos | capturas |
