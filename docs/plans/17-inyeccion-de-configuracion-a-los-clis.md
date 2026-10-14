# Plan 17 — Inyección de configuración a los CLIs

Estado: **propuesto** (14 oct 2026). Sin código. P17.1 es este documento. Cada tarea siguiente se reclama en el [seguimiento](14-seguimiento.md) antes de empezar, y ninguna necesita una llamada a un modelo ni una sesión nueva en un CLI sin aprobación explícita.

El usuario propone que Synapser sea el centro de mando de los CLIs. El operador guarda sus proveedores (endpoint y nombre de variable de clave) en una sola lista; elige agentes; y les inyecta el proveedor y el modelo que necesitan. Un mismo CLI puede correr con distintos modelos. El orquestador (rol `supervisor`) ya corre con Nemotron por defecto, y el plan permite cambiarlo. La configuración se haría desde la UI, desde la CLI o desde MCP; la decisión 5 impide que MCP escriba configuración.

Todas las referencias `archivo:línea` se comprobaron en el código del commit en el que se escribió este plan. Los resultados de las pruebas con cada CLI están en evidencia local, sin versionar; este documento solo recoge mecanismos, invariantes y lo que falta por confirmar.

## 1. Lo que existe

- **Modelo por agente.** claude-code pasa `--model` (`src/agents/claude-code.ts:34`). codex pasa `-m` (`src/agents/codex.ts:33`). mimo pasa `--model` (`src/agents/mimo.ts:32`). generic-cli sustituye `{model}`. Kimi no: su adaptador no menciona ningún modelo, y su argumento base se construye en `src/agents/kimi.ts:29`.
- **Roles del sistema.** `supervisor`, `worker`, `repair`, `advisor` y `chat` (`src/model/config.ts:29`), cada uno con proveedor, modelo y temperatura (`RoleConfig`, `src/model/config.ts:13`). El orquestador es el `supervisor` (plan 10: «el supervisor recibe el catálogo y propone»), y ya usa Nemotron Super por defecto, con el proveedor `tokenfactory` (`src/model/config.ts:51`).
- **Claves.** Los proveedores guardan nombres de variables (`apiKeyEnv`), nunca valores. Por defecto, `tokenfactory` declara `NEBIUS_API_KEY`, `NEBIUS_TOKEN` y `NEMOTRON_TOKEN` (`src/model/config.ts:37`). La lista de nombres permitidos viene de D2 del plan 15 e IC2.
- **Validación de proveedores.** `validateProviderConfig` (`src/model/config.ts:135`).
- **Aislamiento por corrida.** `makeScratchHome` (`src/agents/runner.ts:63`) y las variables XDG del CLI (`src/agents/adapter.ts:106`). Las skills ya se inyectan así, por mecanismo (Q1.7).
- **MCP.** 18 herramientas: workflows, compuertas, efectos, intervenciones, política, asesor y catálogo. Ninguna escribe configuración de proveedores, roles ni claves. Dieciséis son solo de `initiator`; `effect_request` y `effect_status` también son de `worker` (`src/mcp/server.ts:257`). Las dos que leen configuración están marcadas `readOnly` (`src/mcp/server.ts:294` y `:337`).
- **ACP.** El protocolo de kimi (2.1.1) y el de mimo (0.1.15) anuncian soporte de MCP por HTTP y SSE en `initialize`, y `session/new` admite `mcpServers`.

## 2. Lo que no existe

- Ningún adaptador inyecta endpoint ni clave a un CLI.
- No hay pantalla de la UI ni ruta de la API que escriba los roles del sistema (`supervisor` no aparece en `web/src`). Tampoco hay un subcomando de `src/cli/main.ts` que escriba configuración: hoy solo se edita el archivo.
- Kimi no recibe modelo desde el perfil.
- Cambiar proveedor o modelo de un agente o de un rol desde la UI o la CLI.

## 3. Principios

- **K1. Claves fuera de Synapser.** La configuración guarda solo nombres de variables. Los valores llegan al proceso del CLI por su entorno. Solo si un CLI no acepta la clave por entorno, se escribe en la configuración temporal de la corrida, con permisos restrictivos y borrado al terminar. Nunca aparecen en la configuración persistente, en el ledger, en una respuesta de la API ni en un log.
- **K2. Inyección solo por el operador.** Desde el archivo de configuración, o desde la UI con sesión y mismo origen. Nunca desde un documento de biblioteca ni desde un agente: un documento es un dato, no una autoridad (plan 15, sección 2).
- **K3. Ninguna herramienta MCP escribe configuración.** Hoy las 18 herramientas no tocan proveedores, roles ni claves. Un CLI al que Synapser inyecta su servidor MCP entra como `initiator` (valor por defecto, `src/mcp/server.ts:106`). Si ese rol pudiera escribir configuración, el CLI podría cambiar proveedores o claves. Escribir configuración es solo del operador, desde la UI o la CLI. Ver decisión 5.
- **K4. Trazabilidad.** Cada corrida registra proveedor, modelo y endpoint usados, sin valores de clave.
- **K5. Coste.** Las tarifas salen solo del archivo del operador (D4 del plan 15). Sin tarifa, el coste sigue la decisión D3 del plan 10: alerta, no bloqueo; se aprende y se estima.

## 4. Mecanismo por CLI

| CLI | Endpoint y clave | Modelo | Vía de inyección | Pendiente en P17.2 |
|---|---|---|---|---|
| claude-code | variables de entorno del CLI | `--model` (`src/agents/claude-code.ts:34`) | argumentos y `--mcp-config` | la vía de endpoint y de clave |
| codex | sección de proveedor en `config.toml` dentro de `CODEX_HOME` (`src/agents/codex.ts:39`) | `-m` (`src/agents/codex.ts:33`) | `CODEX_HOME` efímero (Q1.3) | la forma de la sección de proveedor |
| kimi | `config.toml` con `base_url`, `type` y `api_key` por proveedor; ruta bajo `KIMI_CODE_HOME` | ninguno hoy (`src/agents/kimi.ts` no menciona modelo); la CLI acepta `-m`, que toma un alias de `config.toml`; ACP ofrece `setSessionModel` | `KIMI_CODE_HOME` efímero, o ACP | si `-m` funciona con `-p`; si `KIMI_CODE_HOME` mueve `config.toml`; si `setSessionModel` cambia el modelo |
| mimo | `mimocode.jsonc` bajo `XDG_CONFIG_HOME` (`src/agents/mimo.ts:43`); credenciales en `auth.json` bajo `XDG_DATA_HOME`, que no se leen | `--model` (`src/agents/mimo.ts:32`) | `XDG_CONFIG_HOME` efímero (Q1.7), o `mimo acp` | la forma de la clave dentro de `mimocode.jsonc` |

Lo que la tabla no cita como código del repositorio es por confirmar en P17.2.

## 5. Decisiones

1. **Claves por variables de entorno (K1).** Propuesta aceptada provisionalmente con «ok» el 14 oct, tras la recomendación; pendiente de confirmación. El almacén cifrado queda fuera: exigiría gestionar una clave maestra. Si esta decisión cambia, se revisan P17.4 y P17.5.
2. **Quién inyecta: el operador (K2).** Desde el archivo o desde la UI con sesión. Propuesta.
3. **Vía preferida: ACP cuando el CLI lo ofrece** (kimi y mimo). En el resto, HOME o `XDG_CONFIG_HOME` efímero con la configuración escrita para la corrida. Propuesta; P17.2 la confirma CLI por CLI.
4. **Endpoints de terceros y sandbox de red (D5 del plan 15, P15.9).** Un endpoint en un CLI amplía su red, y el sandbox de red sigue bloqueado. Propuesta A: hasta resolver P15.9, un CLI solo recibe endpoints de loopback, lo mismo que D3 del plan 15 permite a los proveedores locales. Consecuencia: MiniMax, Xiaomi y Nebius no se pueden inyectar hasta entonces, y eso bloquea el caso que describiste. Alternativa B: aceptar el límite declarado de D5 del plan 15 y permitir terceros ya. Decide el operador.
5. **MCP no escribe configuración (K3).** Propusiste configurar también por MCP. La propuesta es que ninguna herramienta MCP escriba proveedores, roles ni claves, para ningún rol. Hoy es así (ver §1). La razón está en K3: un CLI que usa el servidor MCP de Synapser entra como `initiator`, y si ese rol pudiera escribir configuración, el CLI podría cambiar proveedores o claves. Escribir por MCP exigiría un token de operador distinto del de iniciador, y eso se decide antes de P17.7. Propuesta, y es uno de los puntos que se apartan de tu propuesta.
6. **Orquestador con Nemotron.** Ya es el valor por defecto (`src/model/config.ts:51`). Lo que añade el plan es poder cambiar proveedor o modelo de cualquier rol o agente desde la UI o la CLI. P17.6 lo prueba.

## 6. Tareas

- **P17.1 Plan y registro.** Este documento y su entrada en el índice.
- **P17.2 Inventario por CLI.** Para claude-code, codex, kimi y mimo: mecanismo de endpoint, de clave y de modelo, con el comando que lo demuestra. Sin llamadas a modelos ni sesiones nuevas sin aprobación. Entregable: la tabla de la sección 4 completa, sin las celdas marcadas como pendientes.
- **P17.3 Modelo en el adaptador de kimi.** `profile.model` pasa a `-m` (`--model`, por invocación, según `kimi --help`). El valor es un alias definido en el `config.toml` del CLI, así que un modelo nuevo exige su alias en la configuración temporal (P17.5). *Verificación:* argv con y sin modelo; en `-p`, que el CLI use el alias pedido (por confirmar en P17.2). *Falsación:* quitar `-m` y la prueba falla.
- **P17.4 Proveedores del operador con endpoint y variable de clave.** Reutiliza `validateProviderConfig` (`src/model/config.ts:135`). *Invariante:* K1. *Verificación:* una clave de prueba no aparece en la configuración, la API, el ledger ni los logs. *Falsación:* imprimir la clave en un error y la prueba falla.
- **P17.5 Inyección por CLI.** Configuración temporal de la corrida, o sesión ACP con `mcpServers` y `setSessionModel`. *Invariantes:* K1, K2 y K4. *Verificación:* un servidor local falso recibe el modelo y la clave correctos; la clave no queda en disco fuera de la corrida; un documento de biblioteca no puede inyectar un endpoint. *Falsación:* escribir la clave en la configuración persistente y la prueba falla.
- **P17.6 Proveedor y modelo por agente y por rol.** Asignación en el archivo y en la biblioteca, con validación: un modelo que el proveedor no declara se rechaza. *Verificación:* `roles.supervisor` apunta a un modelo distinto del por defecto y de los demás roles; un servidor local recibe la petición de la corrida del orquestador con ese modelo. *Falsación:* ignorar el rol, o enviar el modelo por defecto, y la prueba falla.
- **P17.7 Superficie de escritura.** UI y CLI del operador, con token y mismo origen como las escrituras actuales. Ninguna herramienta MCP escribe configuración (K3, decisión 5). *Verificación:* con cada rol MCP (`initiator` y `worker`), ninguna herramienta cambia proveedores, roles ni claves. *Falsación:* añadir una herramienta de escritura de configuración y la prueba falla.

## 7. Riesgos y límites

- Un CLI con endpoint y clave es un agente con acceso a una red que el operador eligió. El sandbox de red (P15.9) decide cuánto más puede hacer.
- Sin tarifa, el coste sigue el plan 10, D3: alerta, no bloqueo.
- No se incluye almacén de claves cifrado ni gestión de claves maestras.
- Un CLI que no acepte clave por entorno obliga a la escritura temporal (K1). Es el caso más delicado, y el plan lo limita a la duración de la corrida.

## 8. Preguntas abiertas

- ¿Confirmas la decisión 1 (claves por variables de entorno)?
- ¿Decisión 4: propuesta A (solo loopback hasta P15.9) o B (límite declarado y terceros ya)?
- ¿Decisión 5: MCP sin escritura de configuración, o un token de operador para escribir por MCP?
- ¿Ejecutamos P17.2 en cuanto se apruebe el plan? Consume tiempo, y para comprobar la clave de algún CLI puede requerir una llamada aprobada aparte.
