# Plan 06 — Cómo usamos Nebius y NVIDIA (con puertos intercambiables)

Objetivo: cumplir lo que piden las bases (plan 05) **sin** acoplar el núcleo al proveedor. Lo
exigido por la hackathon queda en configuración y en adaptadores; el ejecutor, el journal y el
protocolo no saben qué modelo ni qué nube hay detrás.

## 1. Hechos verificados (fuente) y hechos por verificar

Verificado leyendo la documentación oficial y el CLI instalado el 13 oct 2026. Lo que se marca
"spike S-A" se ejecutó contra la cuenta (§14).

| Tema | Hecho | Fuente |
|---|---|---|
| API | Compatible con OpenAI. Base `https://api.tokenfactory.nebius.com/v1/`; auth `Authorization: Bearer $NEBIUS_API_KEY`; `POST /chat/completions`, `GET /models` | [quickstart](https://docs.tokenfactory.nebius.com/quickstart.md), [intro](https://docs.tokenfactory.nebius.com/api-reference/introduction.md) |
| Región | Los endpoints públicos son *Global*: la región puede cambiar sin aviso; una URL regional puede dejar de funcionar | [public-serverless](https://docs.tokenfactory.nebius.com/public-serverless.md) |
| Tool calling | Formato OpenAI (`tools`, `tool_choice` = `auto` o función explícita, mensajes `role: tool`). El modelo **no ejecuta**; lo hace el backend | [function-calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling.md) |
| JSON | `response_format` con `json_schema` o `json_object`; "different models have different structured output capabilities" | [json](https://docs.tokenfactory.nebius.com/ai-models-inference/json.md) |
| Límites | HTTP 429 con `Retry-After`; cabeceras `x-ratelimit-remaining-requests/-tokens`, `x-ratelimit-over-limit`; el techo se ajusta dinámicamente (ejemplo de la doc: base 60 RPM / 400 000 TPM) | [rate-limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md) |
| Modelo ≠ pedido | La respuesta de ejemplo reporta un `model` distinto del solicitado (variante `-cheap`) | [intro](https://docs.tokenfactory.nebius.com/api-reference/introduction.md) |
| Nemotron disponibles | `nvidia/Nemotron-3_5-Lightning` (30B/3B activos, 1 M ctx, "execution layer for always-on, long-running agents"), `nvidia/nemotron-3-super-120b-a12b` (256 K), `nvidia/Nemotron-3-Ultra-550b-a55b` (1 M; razonamiento + tool calling; US$1,00 / 3,00 por M tokens) | [cookbook Nemotron](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/README.md) |
| Nano 30B A3B | No figura entre los modelos *destacados* del cookbook, **pero sigue disponible** en la cuenta (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, comprobado con `GET /models`, spike S-A). Otros modelos migran a Lightning en la nota de deprecación de agosto 2026 | cookbook, [deprecaciones](https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice.md), spike S-A |
| URL regional | Las fichas de Super y Ultra usan `https://api.tokenfactory.us-central1.nebius.com/v1/` | cookbook |
| Sandboxes | Entornos aislados (VM) para ejecutar código de agentes; **Beta, requiere solicitar acceso**; `networking.enabled=false` quita la interfaz de red; 50 operaciones simultáneas; REST `https://api.tokenfactory.nebius.com/sandboxes` con cabeceras `Authorization` y `Project` | [overview](https://docs.tokenfactory.nebius.com/sandboxes/overview.md), [networking](https://docs.tokenfactory.nebius.com/sandboxes/guides/configure-networking-and-secrets.md), [límites](https://docs.tokenfactory.nebius.com/sandboxes/operate/limits-retention-and-usage.md) |
| Serverless en AI Cloud | `nebius ai endpoint create` (imagen de contenedor, `--container-port`, `--auth none|token`, `--env`, `--env-secret`, `--disk-size`) y `nebius ai job create`; los puertos HTTP salen por URL `https://` gestionada | `nebius ai endpoint create --help` |

**Resuelto por el spike S-A** (§14) salvo lo marcado ⚠: IDs exactos que devuelve `GET /models`;
si Lightning soporta tool calling fiable y tool calls paralelos; formato del razonamiento
(¿`reasoning_content`, etiquetas en `content`?); soporte de `response_format`; límites reales de
RPM/TPM; si hay plataforma de CPU para el endpoint (el valor por defecto del CLI es GPU H100/H200);
acceso a Sandboxes.

> **Ajuste al diseño v0.2.** §11 y §17 proponen *Nemotron 3 Nano 30B A3B*. Sigue disponible y
> funciona (ver §14), pero ya no es el modelo destacado. Quedan **Lightning** y **Nano** como
> candidatos de ejecución (mismo precio), **Super** para supervisión y Ultra opcional; la elección
> final se hace con el A/B sobre el fixture, no con la ficha.

## 2. Qué es fijo y qué es intercambiable

| Fijo para la hackathon (no se abstrae) | Intercambiable (puerto + adaptador) |
|---|---|
| Al menos una llamada en runtime a Token Factory con un modelo NVIDIA en el camino principal | **Proveedor de modelos** (otro endpoint OpenAI-compatible, NIM, vLLM, endpoint dedicado) |
| Alojar la demo en Nebius AI Cloud | **Ejecutor de validaciones** (proceso local ↔ Sandboxes ↔ otro) |
| Materiales de entrega en inglés | **Coordinación** (Zoanthrope ya detrás de `ZooPort`) |
| Zoanthrope como autoridad de claims | **Hosting** (la app es una imagen de contenedor; corre en cualquier lado) |
| | **Investigación web** (`ResearchPort`: Tavily hoy; ver [plan 07](07-tavily-investigacion-web.md)) |

Regla: *un cambio de proveedor es un cambio de configuración; un cambio de protocolo es un adaptador
nuevo; ninguno toca el ejecutor, el journal ni la máquina de estados.*

## 3. Vista de componentes

```
                    ┌────────────── Interfaz (React) ──────────────┐
                    │  plan · agentes · esperas · diff · llamadas  │
                    └───────────────▲──────────────────────────────┘
                                    │ eventos del journal (SSE)
┌───────────────┐   propone   ┌─────┴───────┐  acciones   ┌──────────────────┐
│ Supervisor    │────────────▶│  Control    │────────────▶│ Ejecutor (único  │
│ (rol: planner)│             │ plan·DAG·   │             │ con escritura)   │
└──────▲────────┘             │ scheduler   │             └───┬───────┬──────┘
       │                      └─────▲───────┘                 │       │
┌──────┴────────┐  tool calls       │ presupuesto             │ ZooPort│ ValidationPort
│ Bucle de      │───────────────────┘                         ▼       ▼
│ agente        │                                      Zoanthrope   LocalRunner
│ (rol: worker) │                                      (binario)    SandboxRunner
└──────▲────────┘
       │ ModelPort  ──────────────────────────────────────────────┐
┌──────┴─────────────────────────────┐                            │
│ OpenAICompatibleProvider           │──▶ Nebius Token Factory ◀──┘
│  baseUrl · key · model por rol     │    (Nemotron)
└────────────────────────────────────┘
```

Las dos flechas hacia el modelo pasan por el mismo `ModelPort`, que es el único lugar donde se
mide, se limita y se registra cada llamada.

## 4. `ModelPort`

```ts
interface ModelPort {
  complete(req: ModelRequest, ctx: CallContext): Promise<ModelResponse>;   // lanza ModelError
  listModels(): Promise<ModelInfo[]>;                                      // GET /models
}
interface ModelRequest {
  role: "supervisor" | "worker" | "repair";   // el puerto elige modelo y parámetros por rol
  messages: ChatMessage[];
  tools?: ToolSpec[];                         // JSON Schema
  toolChoice?: "auto" | "none" | { name: string };
  responseSchema?: object;                    // json_schema (supervisor)
  maxTokens: number;
}
interface ModelResponse {
  message: { content: string | null; toolCalls: ToolCall[] };   // arguments ya parseados o `invalid`
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number };
  requestedModel: string; servedModel: string;                  // pueden diferir
  latencyMs: number; retries: number;
  rateLimit?: { remainingRequests?: number; remainingTokens?: number; overLimit?: boolean };
}
type ModelError =
  | "RATE_LIMITED"       // 429; lleva retryAfterMs
  | "UNAVAILABLE"        // 5xx / red
  | "TIMEOUT"
  | "CONTEXT_EXCEEDED"
  | "BAD_REQUEST"        // 4xx: no se reintenta
  | "AUTH"               // key inválida: se detiene la misión
  | "INVALID_OUTPUT";    // JSON roto o tool call imposible tras N reparaciones
```

- **Un solo adaptador hoy**: `OpenAICompatibleProvider` con `fetch` nativo (sin SDK; mantiene el
  repo sin dependencias de runtime). Token Factory es *configuración* de ese adaptador.
- Configuración por rol (archivo + variables de entorno; la key nunca en el archivo):

```jsonc
{
  "providers": {
    "tokenfactory": { "baseUrl": "https://api.tokenfactory.nebius.com/v1/", "apiKeyEnv": "NEBIUS_API_KEY" }
  },
  "roles": {
    "supervisor": { "provider": "tokenfactory", "model": "nvidia/nemotron-3-super-120b-a12b", "temperature": 0.2 },
    "worker":     { "provider": "tokenfactory", "model": "nvidia/Nemotron-3_5-Lightning",      "temperature": 0.0 },
    "repair":     { "provider": "tokenfactory", "model": "nvidia/nemotron-3-super-120b-a12b", "temperature": 0.0 }
  },
  "fallbacks": { "worker": ["nvidia/nemotron-3-super-120b-a12b"] }
}
```

- **La URL base es por proveedor/modelo**, no global: Ultra y Super recomiendan la regional.
- **Reproducibilidad**: el modelo pedido, el servido y los parámetros se guardan por corrida y por
  llamada. Un *fallback* nunca ocurre en silencio: se registra como evento y la corrida deja de
  contar como "comparable" en el A/B.

## 5. Roles y por qué

| Rol | Hace | Modelo propuesto | Razón |
|---|---|---|---|
| `supervisor` | Descompone la misión en tareas con dependencias y alcance; propone reordenar o recuperar | **Super 120B-A12B** (Ultra sólo para la planificación inicial, si el costo lo permite) | Pocas llamadas, razonamiento y salida estructurada |
| `worker` | Bucle por tarea: lee, razona, propone parche | **Lightning** (alterno: Nano, mismo precio) | Muchas llamadas cortas; "execution layer" de agentes de larga duración, 1 M de contexto |
| `repair` | Corrige tras una validación fallida | Super | Pocas llamadas, más difíciles |

Es el reparto que sugiere la propia pista ("Ultra for serious reasoning, Nano/Super for fast,
everyday calls"). No es una afirmación de calidad: **se decide con el spike S-A**, no con la ficha.

## 6. Bucle de agente (contrato)

1. Mensaje de sistema fijo + tarea (objetivo, alcance, criterios) + herramientas.
2. **Herramientas** = la superficie del ejecutor (plan 02): `read_files`, `propose_patch`,
   `apply_action`, `run_validation`, `get_task`, `get_run_events`. Ninguna recibe `task_id`,
   `actor_owner` ni `incarnation` del modelo: el backend los inyecta.
3. Cada tool call se **valida contra su JSON Schema** antes de ejecutarse. Argumentos inválidos →
   hasta 2 reintentos de reparación con el error como mensaje `tool`; luego `INVALID_OUTPUT` y la
   tarea pide replanificación.
4. Ejecución **secuencial** de tool calls (una acción no conciliada por actor).
5. Fin de tarea = la tarea pide validación y el **resultado** decide (plan 02 §7). El texto del
   modelo nunca marca `DONE`.
6. Límites por tarea (diseño §8): 30 pasos, presupuesto de tokens, 3 reintentos sin progreso →
   replanificar.
7. El contenido de los archivos es **dato no confiable**: se entrega al modelo como mensaje `tool`,
   nunca como instrucción de sistema. Un archivo con "ignora tus instrucciones" no gana permisos:
   las rutas y el alcance los decide el ejecutor, no el modelo.

## 7. Medición y presupuesto

Tabla nueva en el journal (el esquema v1 aún no se ha liberado):

```sql
CREATE TABLE model_calls(
  call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL,
  requested_model TEXT NOT NULL, served_model TEXT, base_url TEXT NOT NULL,
  started_at INTEGER NOT NULL, latency_ms INTEGER, http_status INTEGER, retries INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER, completion_tokens INTEGER, finish_reason TEXT, error TEXT,
  request_blob TEXT, response_blob TEXT) STRICT;
```

- Cada llamada escribe además un evento (`entity='model_call'`) → la UI las ve por el mismo canal
  que todo lo demás (panel "Llamadas a Nemotron": modelo, latencia, tokens, costo estimado).
- Cuerpos de petición y respuesta como artefactos direccionados por contenido: permiten
  **repetir** una corrida sin llamar al modelo y auditar costos.
- Costo estimado = tokens × precio de `GET /models` (campo `pricing`). Es estimación; la
  facturación es la fuente.
- `BudgetManager`: tokens, pasos y tiempo por misión (diseño §8). Se consulta **antes** de cada
  llamada; al agotarse → no se admiten más pasos de modelo, se concilia lo activo y se informa.
- **Clave y datos**: la key sólo vive en el proceso del backend; ni el workspace, ni Sandboxes, ni
  los logs la ven. Los logs registran `run_id/task_id/action_id` y modelo, no cabeceras.

## 8. Resiliencia

| Situación | Respuesta |
|---|---|
| 429 | Esperar `Retry-After`; retroceso exponencial con jitter; **limitador de concurrencia global** (3 agentes + supervisor) y un cubo de tokens alimentado por `x-ratelimit-remaining-*` |
| `x-ratelimit-over-limit: yes` | Aviso temprano: bajar el ritmo antes de recibir 429 |
| 5xx / red / timeout (60 s por llamada, configurable) | Hasta 2 reintentos; luego `UNAVAILABLE` |
| Proveedor caído | No se admiten nuevos pasos de modelo; el estado y las acciones se conservan; reintento dentro del presupuesto o pausa con causa (diseño §8) |
| Una llamada **nunca retiene claims** | Principio del diseño: esperar al modelo no bloquea archivos |
| Modelo retirado/renombrado | `listModels()` al arrancar; si un rol no resuelve, la misión no inicia y la UI lo dice |

## 9. `ValidationPort`: pruebas en copia aislada

```ts
interface ValidationPort {
  run(snapshot: SnapshotRef, command: AllowedCommand, limits: Limits): Promise<ValidationResult>;
}
// ValidationResult: { exitCode, stdoutBlob, stderrBlob, durationMs, runner, evidence: {...} }
```

| Adaptador | Qué hace | Cuándo |
|---|---|---|
| `LocalRunner` | Copia el snapshot a un directorio temporal y ejecuta el comando permitido en un subproceso con entorno mínimo, sin el estado del coordinador | **Por defecto**; funciona sin red, en CI y en la demo si Sandboxes no está disponible |
| `SandboxRunner` | Sube el snapshot a un sandbox de Token Factory, ejecuta con `networking.enabled=false` y devuelve salida, código y `operation_id`/`image_uuid` | Cuando haya acceso (Beta); es exactamente el "copia sin secretos y sin red" del diseño §3 y la frase de la pista "agents that write, run, and test code in Token Factory" |

- La evidencia de validación (plan 03 §5) registra **qué runner** la produjo.
- `SandboxRunner` es opcional: si el acceso a la Beta no llega antes del 30 oct, la entrega no
  depende de él. Su valor es de **Technological Implementation** y de encaje con la pista.
- Riesgo propio: 50 operaciones simultáneas y estado Beta; tratarlo como mejora, no como ruta crítica.

## 10. Despliegue en Nebius AI Cloud

```
Imagen única (Dockerfile): node 24 + zoanthrope 0.1.3 compilado + synapser + UI estática
  └─ proceso principal (supervisor de procesos)
       ├─ API + ejecutor + scheduler        ← único con escritura al workspace
       ├─ zoanthrope mcp (hijo del ejecutor)
       └─ UI estática servida por la API
Estado: SQLite + artefactos + workspace en disco del contenedor (uno nuevo por sesión)
```

| Pieza | Decisión |
|---|---|
| Demo pública | `nebius ai endpoint create --image … --container-port 8080 --auth none --env-secret NEBIUS_API_KEY=…` → URL `https://` gestionada. `--auth none` porque las bases exigen acceso sin restricción |
| Evaluación A/B (3 condiciones × 5) | `nebius ai job create` (Serverless Jobs) o local; produce los datos que cita el README |
| Plataforma | El valor por defecto del CLI es **GPU H100/H200**; para una app sin GPU hay que confirmar una plataforma de CPU (`--dry-run`) y la cuota. Si no existe, es un costo a presupuestar |
| Persistencia | Disco efímero es suficiente: el diseño ya pide un workspace nuevo por sesión. El "kill del ejecutor" de la demo es un proceso, no el contenedor |
| Superficie de ataque | La misión alojada es **fija** (fixture); no se sube código de usuario. Tope de gasto global y por sesión, y un interruptor para cortar llamadas al modelo |
| Secretos | `--env-secret`; nunca en la imagen ni en el repo |

## 11. Qué cambia en lo ya escrito

| Documento | Cambio |
|---|---|
| Diseño v0.2 §11/§17 | Nano 30B → Lightning (worker) / Super (supervisor); modelo por rol |
| Plan 01 | Añadir tabla `model_calls` |
| Plan 02 §7 | `run_validation` pasa por `ValidationPort` |
| Plan 04 | Sin cambio: ninguna llamada a modelo ocurre con claims retenidos |
| Plan 05 G8/G9 | Resueltos por las secciones 5 y 7 |
| `zoanthrope.lock.json` | Hash opcional (G4 del plan 05) |

## 12. Estrategia de pruebas y spike S-A

| Capa | Prueba |
|---|---|
| Bucle de agente | `FakeModel` con tool calls guionizados: sin red, determinista; cubre reparación de argumentos, límites y presupuesto |
| Reproducción | Cassettes (petición→respuesta) grabados de la API real; permiten la demo y la CI sin créditos |
| Provider | Pruebas contra un servidor HTTP local que emula 429/5xx/timeouts/respuestas con `model` distinto |
| En vivo | Una prueba humo etiquetada, sólo con `NEBIUS_API_KEY` |
| **Spike S-A** (`scripts/probe-models.ts`) | `GET /models`; por cada modelo configurado: tool call forzado, `auto`, dos tool calls paralelos, JSON con esquema, latencia y tokens. Produce `evidence/models.json` y decide los roles de la sección 5 |

## 13. Qué necesito

1. `NEBIUS_API_KEY` de Token Factory y el ID de proyecto (para correr S-A y, luego, Sandboxes).
2. **Solicitar acceso a Sandboxes** desde <https://tokenfactory.nebius.com/sandboxes/about>
   (Beta): es por proyecto y no depende de mí; conviene pedirlo ya.
3. Confirmar el formato de despliegue: endpoint serverless con imagen propia (lo propuesto), o una
   VM/Devlab si prefieres controlar el host.
4. Las cuatro decisiones pendientes del plan 05 (pista, licencia, Tavily, idioma).

## 14. Resultados del spike S-A (13 oct 2026)

`scripts/probe-models.ts` contra `https://api.tokenfactory.nebius.com/v1/` con la key de `.env`
(variable `NEMOTRON_TOKEN`; el código acepta también `NEBIUS_API_KEY`). Evidencia cruda en
`evidence/models.json` (ignorada por git). **n = 1 por prueba**: confirma que funciona, no mide
fiabilidad.

| Modelo | Tool call forzado | `auto` (lee primero) | Paralelos | JSON schema | Límite RPM / TPM | USD / M tokens (in / out) |
|---|---|---|---|---|---|---|
| `nvidia/Nemotron-3_5-Lightning` | ok | ok | no | ok | 600 / 400 000 | 0,06 / 0,24 |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | ok | ok | no | ok | 100 / 800 000 | 0,06 / 0,24 |
| `nvidia/nemotron-3-super-120b-a12b` | ok | ok | no | ok | 300 / 200 000 | 0,30 / 0,90 |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | ok | ok | no | ok | 300 / 200 000 | 1,00 / 3,00 |

Hallazgos que cambian el diseño:

1. **El razonamiento viaja en un campo aparte** (`reasoning` y/o `reasoning_content` en el mensaje),
   no en etiquetas `<think>` dentro de `content`. El adaptador debe **no** reinyectarlo al historial
   y guardarlo sólo como traza.
2. **Los tokens de razonamiento se cobran y cuentan**: "Reply with exactly: OK" costó 158 tokens de
   salida en Lightning (21 de entrada). El presupuesto y `max_tokens` deben considerarlo; un
   `max_tokens` bajo puede truncar antes de emitir la llamada.
3. **El modelo servido coincide con el pedido** en los cuatro; igualmente se registran ambos.
4. **Ningún modelo emitió llamadas paralelas** en esta prueba, lo que concuerda con la ejecución
   secuencial del plan 02 (⚠ una muestra no lo garantiza: el ejecutor debe tolerar varias).
5. **Los límites de la cuenta sobran** para 3 agentes + supervisor (≥ 100 RPM por modelo). El
   limitador de concurrencia se queda como protección, no como cuello de botella.
6. Latencias de 0,5–1,6 s por llamada corta; un JSON con esquema en Lightning tardó 2,4 s por
   razonamiento largo (550 tokens de salida para 102 de entrada).
7. ⚠ **Pendiente**: fiabilidad en bucles largos (n grande), si el razonamiento puede desactivarse
   para el `worker`, y el comportamiento con 3 agentes concurrentes.

Siguiente paso técnico de este plan: implementar `ModelPort` y `OpenAICompatibleProvider` con
estas tres reglas (razonamiento aparte, presupuesto con tokens ocultos, registro de modelo
pedido/servido) y repetir S-A con n = 20 por modelo en el fixture real.

## 15. Estado de implementación (13 oct)

- `src/model/`: `ModelPort` (tipos), `OpenAICompatibleProvider` (enrutado por rol, reintentos que
  respetan `Retry-After` sin acortarlo, fallback explícito sólo ante `UNAVAILABLE`/modelo inexistente,
  tope de concurrencia, presupuesto que recorta `max_tokens` y se consulta antes de enviar),
  `BudgetManager`, `config`, `pricing`, `journalRecorder` (tabla `model_calls` + eventos + cuerpos
  como artefactos sin credenciales).
- `src/startup.ts`: lock → journal → reaper → Zoo (G0) → recovery; arranque degradado si Zoanthrope
  no está.
- Tests: `test/model/provider.test.ts` (17, servidor HTTP local que emula 429/5xx/timeouts/echo de
  la key), `test/live/token-factory.test.ts` (`npm run test:live`, contra la API real).
- Hallazgo durante las pruebas: un 4xx que devolvía la credencial en su cuerpo la filtraba al
  mensaje de error y al registro; ahora se redacta (`#scrub`) y hay prueba que lo cubre.
- `src/agent/` (bucle de agente): herramientas **planas** `read_files` / `write_file` /
  `replace_in_file` / `delete_file` / `apply_changes` / `finish` (los cambios se *preparan* y se
  confirman con un único `apply_changes` = una acción atómica); argumentos validados antes del
  ejecutor, con normalización de variantes inequívocas y un ejemplo copiable en cada error; identidad
  inyectada por el backend (el modelo nunca ve `task_id`, actor, incarnation, digests ni view ids);
  contenido de archivos sólo como mensaje `tool`; límites de pasos / reparaciones / sin-progreso /
  presupuesto / plazo de la misión.
- `src/mission/` (supervisor, plan validado como DAG, scheduler con concurrencia acotada, tareas
  `VALIDATING → DONE` sólo por evidencia de aceptación, rondas de reparación acotadas) y
  `src/validation/` (runner local: copia consistente, allowlist, sin red vía `unshare -rn`, hijos
  registrados para el reaper, resultado válido sólo para el digest probado).
- **Qué mostraron las corridas reales** (`scripts/mission-bench.ts`, misión de descuentos con tres
  agentes concurrentes y un archivo compartido, aceptación = tests unitarios + oracle independiente):

  | Diseño de herramientas / prompt | Lightning | Super 120B |
  |---|---|---|
  | `edits` anidados, contrato dentro de los criterios | 0/3 | 3/3 (1 sin reparación) |
  | herramientas planas, contrato dentro de los criterios | 0/3 | 3/3 (1 sin reparación) |
  | planas + contrato como `context` separado | 2/3 | 2/3 |
  | ídem + `apply_changes` repetido inocuo (n = 5) | **1/5** | **4/5** (3 sin reparación) |

  Medido con `fallbacks: []` (sin respaldo), así que cada fila es el modelo solo. Super: ≈ US$0,035 y
  ≈ 30 s por misión; Lightning ≈ US$0,012. **Re-medición tras hacer atómico `apply_changes`
  (commit `5a3fbdd`)**: Super 3/3 (2 sin reparación), 27,6 s y US$0,031 de media. Las filas
  anteriores se midieron sobre el árbol de trabajo previo a ese commit. Con un plan fijo y Super como
  `worker` por defecto, la misión completa terminó `DONE` en 22,7 s (≈ US$0,025, una `STALE_VIEW`
  resuelta). Con el supervisor planificando: `DONE` en 49,7 s (≈ US$0,028, sin llamadas rechazadas;
  el plan salió como cadena, así que no hubo colisión). **Muestras pequeñas (n = 3–5)**: indican
  tendencia, no una tasa.
- **Decisión**: `worker`, `repair` y `supervisor` usan Super por defecto; Lightning queda como
  respaldo. Lightning funciona bien solo (5/5 en una tarea de tres archivos) pero con tres agentes
  concurrentes insiste en editar archivos de otros y cita texto desactualizado.
- **Defectos propios que las corridas en vivo destaparon** (los tests con modelo guionizado no los
  veían): contrato completo en los criterios de cada tarea (el agente intentaba implementarlo todo);
  `OUT_OF_SCOPE` sin pista accionable; `edits` anidados mal formados por el modelo; límite de 600
  caracteres que rechazaba un contexto legítimo; `apply_changes` repetido tras un éxito contado como
  fallo. Todos corregidos y con test.
- **Fallo de aceptación observado (1 de 5 con Super)**: los tests escritos por el agente `tests`
  esperaban `TypeError` donde la implementación lanzaba `ValueError`; la ronda de reparación no lo
  corrigió. Es una falla real de coordinación entre agentes, no del oracle.
- **Pendiente**: `ValidationPort` sobre Sandboxes, `ResearchPort`/Tavily, interfaz, diff/trazas
  exportables, A/B (serial / concurrente sin coordinación / con Synapser), n mayor.
