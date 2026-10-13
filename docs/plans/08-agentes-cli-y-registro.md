# Plan 08 — Agentes CLI, puerto común y registro de auditoría

Decisiones del usuario (13 oct): **worktree + broker**; el agente se invoca como CLI *one-shot*;
Synapser es herramienta de análisis (uso, costo, qué hizo cada agente y por qué) además de coordinador;
**una interfaz común con implementaciones**.

## 1. Spike: qué entrega cada CLI (13 oct 2026, corridas reales)

| CLI | Invocación one-shot | Fin / éxito | Tokens | USD | Notas |
|---|---|---|---|---|---|
| `claude` | `-p … --output-format json` | un JSON: `is_error`, `subtype`, `terminal_reason` | sí (`usage`, `modelUsage`) | **sí** (`total_cost_usd`) | un "OK" costó US$0,08 (~28 k tokens de arnés); una edición mínima, US$0,11 |
| `codex` | `exec --json --ephemeral -s …` | evento `turn.completed` | sí (`usage`) | no | `cached_input_tokens` ⊂ `input_tokens`; necesita stdin cerrado |
| `kimi` | `-p … --output-format stream-json` | sin evento de fin propio | **sólo en su bitácora de sesión** (`step.end.usage` + latencias) | no | corre `mimo-v2.6-pro`; **no admite `--auto`/`--yolo` con `-p`**; en `-p` edita y ejecuta Bash sin preguntar; el stream trae las llamadas a herramientas |
| `mimo` | `run … --format json` | evento `error` | `mimo export`/`stats` | stats | salió con **código 0** ante un 402 *Insufficient account balance* |

Consecuencias de diseño, todas con test:

1. **El código de salida no es evidencia**: éxito = evento propio de la herramienta; `exit≠0` sin
   evidencia de éxito es `FAILED` con el mensaje de la herramienta; `exit 0` + evento de error es `FAILED`.
2. **Procedencia del uso**: `reported` | `log` | `unknown`; lo ausente es `null`, nunca `0`.
3. **El arnés del CLI cuesta**: se registra el uso total de cada invocación; el análisis puede
   separar "trabajo" de "sobrecosto del arnés".
4. **Las credenciales propias no se heredan**: el entorno del CLI es una lista permitida; `NEBIUS_*`,
   `NEMOTRON_*`, `TAVILY_*` y cualquier `*KEY/TOKEN/SECRET` quedan fuera salvo que el perfil lo pida.

## 2. Puerto `AgentRunner` (`src/agents/port.ts`)

```
run(request) → AgentRunOutput          mismo formato para todo adaptador
runAndIntegrate(registry, request)     punto de entrada del workflow: ejecutar y aterrizar el trabajo
```

| Adaptador | Cómo produce el trabajo | Integración |
|---|---|---|
| `native` (`NativeLoopRunner`) | bucle Nemotron en proceso, sin FS ni shell | `direct`: cada escritura ya pasó por el ejecutor |
| `cli-oneshot` (`CliOneShotRunner`) | CLI de terceros en una copia aislada | `pending`: el conjunto de cambios pasa por el broker |
| `orca` (futuro) | workers de Orca (`orchestration worker-start …`) | mismo contrato |

**Batería de conformidad** (`test/agents/conformance.test.ts`): las mismas aserciones se ejecutan contra
cada implementación (camino feliz, uso uniforme, fallo sin efectos, alcance, "sin update perdido").
Un adaptador nuevo está terminado cuando la pasa.

## 3. Broker de parches (`src/agents/broker.ts`)

La vista del agente es la **base que se le entregó**, no el árbol vivo. El ejecutor arbitra: alcance
(el conjunto completo se rechaza si un archivo queda fuera), claims de Zoanthrope, digest
(`STALE_VIEW` si el árbol vivo cambió), aplicación atómica y journal. Un asesor nunca integra.

**Defecto encontrado por la batería de conformidad y corregido**: el runner leía el contenido base del
árbol vivo *después* de la corrida, así que una edición humana hecha durante la corrida se perdía con
estado `INTEGRATED`. Ahora la base sale de una copia prístina tomada antes de ejecutar; hay test de
regresión.

## 4. Registro (`agent_runs`)

Una fila por invocación, con el mismo formato para todo adaptador: perfil, rol, adaptador, comando
(plantilla; el prompt va como artefacto), digest base, código de salida/señal, resultado y motivo, sesión,
modelos, uso con procedencia, uso de herramientas, archivos cambiados (con digests), y blobs de prompt,
salida y texto final. Cada fila emite un evento `agent_run` por el mismo canal que el resto.

## 5. Registro auditable (`src/audit/`)

- **Cadena de hashes** (`chain.ts`): el hash de cada evento cubre el hash anterior y su texto exacto.
  Detecta edición, borrado, huecos y —contra un `head` anclado fuera del ejecutor— truncamiento de la
  cola. `export` es verificable sin conexión. Los triggers de SQLite ya impiden UPDATE/DELETE; la
  cadena detecta a quien edita el archivo sin pasar por el motor.
- **Consultas deterministas** (`queries.ts`, CLI `src/audit/cli.ts`): `verify`, `export`, `timeline`,
  `who-changed <ruta>`, `why <acción>`, `cost --by …`, `waste`, `coordination`. Mismas entradas ⇒
  mismos bytes. `why` devuelve la **cadena declarada** (misión → tarea → corrida → acción → archivos →
  validación) y, aparte, lo que el agente escribió, etiquetado `asserted`. La atribución acción→corrida
  es causal (`agent_run_integration.action_id`) y, para el bucle nativo, por su propia ventana de tiempo;
  nunca "la última corrida iniciada antes" (empata al milisegundo; defecto hallado por el test).
- **Costo**: lo desconocido es `null` y se cuenta (`usdUnknownRuns`, `tokensUnknownRuns`); nunca 0.
- **Exportador LangSmith** (`langsmith.ts`): vista opcional del registro con el contrato
  `coding-agent-v1` (identidad `ls_*`, `thread_id`, llm con `usage_metadata`, tool con `ls_tool_name`,
  subagent con id/tipo). La raíz lleva `synapser_ledger_head` para contrastar la traza con la cadena.
  **Por defecto no sale contenido** (ni prompts, ni texto final, ni bytes de archivos); ids
  deterministas ⇒ reexportar es idempotente. Hallazgo: `POST /runs/multipart` exige `Content-Length`
  en **cada parte** (422 si falta) y `FormData` de Node no lo añade, así que el cuerpo se arma a mano.
  Verificado en vivo: 14 runs exportados y leídos de vuelta.
  **No es fuente de verdad**: retención base de 14 días (180 extendida), servicio de terceros.

## 6. Pendiente

- Enganche a Zoanthrope: identidad por agente, `post_intention` por MCP y volcado de su anillo de
  auditoría (tiene tope de 1 000 eventos) al registro.
- Workflow declarativo (pasos, perfiles, aprobaciones) con Nemotron eligiendo perfil del catálogo.
- Rebase de un `STALE_VIEW` (hoy se informa; no se reintenta).
- Adaptador `orca`.
- Aislamiento de capacidades: `kimi -p` y `mimo` ejecutan shell; la copia aísla el repo, no el HOME.
