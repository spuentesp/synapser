# Plan 17 — Inyección de configuración a los CLIs

Estado: **aprobado en lo esencial** (14 oct 2026). Las decisiones 1, 4 y 5 las aprobó el operador ese día; la 2, la 3 y la 6 siguen como propuesta. P17.1 y P17.2 están hechas. Cada tarea siguiente se reclama en el [seguimiento](14-seguimiento.md) antes de empezar, y ninguna necesita una llamada a un modelo real sin aprobación explícita.

El usuario propone que Synapser sea el centro de mando de los CLIs. El operador guarda sus proveedores (endpoint y nombre de variable de clave) en una sola lista; elige agentes; y les inyecta el proveedor y el modelo que necesitan. Un mismo CLI puede correr con distintos modelos. El orquestador (rol `supervisor`) ya corre con Nemotron por defecto, y el plan permite cambiarlo. La configuración se hace desde la UI, desde la CLI del operador o desde un conector MCP propio de configuración, separado del conector de tareas (decisión 5).

Todas las referencias `archivo:línea` se comprobaron en el código del commit en el que se escribió este plan. Los mecanismos de §4 se comprobaron con servidores falsos locales (P17.2); los detalles de esas pruebas están en evidencia local, sin versionar.

## 1. Lo que existe

- **Modelo por agente.** claude-code pasa `--model` (`src/agents/claude-code.ts:34`). codex pasa `-m` (`src/agents/codex.ts:33`). mimo pasa `--model` (`src/agents/mimo.ts:32`). generic-cli sustituye `{model}`. Kimi no: su adaptador no menciona ningún modelo, y su argumento base se construye en `src/agents/kimi.ts:29`.
- **Roles del sistema.** `supervisor`, `worker`, `repair`, `advisor` y `chat` (`src/model/config.ts:29`), cada uno con proveedor, modelo y temperatura (`RoleConfig`, `src/model/config.ts:13`). El orquestador es el `supervisor` (plan 10: «el supervisor recibe el catálogo y propone»), y ya usa Nemotron Super por defecto, con el proveedor `tokenfactory` (`src/model/config.ts:51`).
- **Claves.** Los proveedores guardan nombres de variables (`apiKeyEnv`), nunca valores. Por defecto, `tokenfactory` declara `NEBIUS_API_KEY`, `NEBIUS_TOKEN` y `NEMOTRON_TOKEN` (`src/model/config.ts:37`). La lista de nombres permitidos viene de D2 del plan 15 e IC2.
- **Validación de proveedores.** `validateProviderConfig` (`src/model/config.ts:135`).
- **Aislamiento por corrida.** `makeScratchHome` (`src/agents/runner.ts:63`) y las variables XDG del CLI (`src/agents/adapter.ts:106`). Las skills ya se inyectan así, por mecanismo (Q1.7).
- **MCP.** 18 herramientas: workflows, compuertas, efectos, intervenciones, política, asesor y catálogo. Ninguna escribe configuración de proveedores, roles ni claves. Dieciséis son solo de `initiator`; `effect_request` y `effect_status` también son de `worker` (`src/mcp/server.ts:257`). Las dos que leen configuración están marcadas `readOnly` (`src/mcp/server.ts:294` y `:337`).
- **ACP.** El protocolo de kimi (2.1.1) y el de mimo (0.1.15) anuncian soporte de MCP por HTTP y SSE en `initialize`, y `session/new` admite `mcpServers`.
- **Token de la API.** `opts.token` si se da; si no, se genera al azar en cada arranque (`src/api/server.ts:145`). Las peticiones se comprueban con `tokenOk` (`src/api/server.ts:519`).

## 2. Lo que no existe

- Ningún adaptador pasa endpoint ni clave a su CLI. `ENV_ALLOW` (`src/agents/adapter.ts:83`) no incluye ninguna variable de proveedor.
- No hay pantalla de la UI ni ruta de la API que escriba los roles del sistema (`supervisor` no aparece en `web/src`). Tampoco hay un subcomando de `src/cli/main.ts` que escriba configuración: hoy solo se edita el archivo.
- Kimi no recibe modelo desde el perfil.
- Un token de operador fijo. Hoy el de la API cambia en cada arranque si no se configura.

## 3. Principios

- **K1. Claves en variables de entorno, nunca en archivos.** La configuración guarda solo nombres de variables: `apiKeyEnv` en Synapser, `env_key` en codex, `api_key_env` en kimi y `{env:VAR}` en mimo. Los valores llegan al proceso del CLI por su entorno. Los cuatro CLIs lo admiten (§4), así que no hay excepción: un CLI que no lea su clave de una variable queda fuera del plan hasta una decisión nueva. Ni la configuración persistente, ni la temporal de la corrida, ni el ledger, ni una respuesta de la API, ni un log contienen un valor de clave.
- **K2. Inyección solo por el operador.** Desde el archivo de configuración, desde la CLI del operador, o desde la UI con sesión y mismo origen. Nunca desde un documento de biblioteca ni desde un agente: un documento es un dato, no una autoridad (plan 15, sección 2).
- **K3. Dos conectores MCP separados.** El conector de tareas (el MCP actual, con roles `initiator` y `worker`) no tiene herramientas de configuración, y es lo único que se inyecta a los CLIs. El conector de configuración exige un token de operador y es el único canal MCP que escribe configuración (decisión 5).
- **K4. Trazabilidad.** Cada corrida registra proveedor, modelo y endpoint usados, sin valores de clave.
- **K5. Coste.** Las tarifas salen solo del archivo del operador (D4 del plan 15). Sin tarifa, el coste sigue la decisión D3 del plan 10: alerta, no bloqueo; se aprende y se estima.
- **K6. Ningún CLI recibe el conector de configuración.** Ni su URL, ni su nombre, ni su token, ni en la configuración inyectada, ni en el entorno que hereda (`ENV_ALLOW`), ni en un log.
- **K7. Red de los CLIs sin aislar, con límite declarado.** Decisión 4 (B). Los endpoints de terceros se permiten. Dos controles mínimos: un endpoint no puede apuntar a direcciones de metadatos de nube ni a direcciones privadas, según la regla de D3 del plan 15, y el loopback sigue permitido para proveedores locales; y cada corrida registra el endpoint usado (K4).

## 4. Mecanismo por CLI

Confirmado en P17.2 con un servidor falso local. El valor de la clave nunca aparece en la tabla; solo el nombre de la variable.

| CLI | Endpoint | Clave | Modelo | Dónde se escribe |
|---|---|---|---|---|
| claude-code | `ANTHROPIC_BASE_URL`, por entorno | `ANTHROPIC_API_KEY`, por entorno (cabecera `x-api-key`) | `--model` (`src/agents/claude-code.ts:34`) | solo entorno |
| codex | `-c model_provider=<id>` y `-c model_providers.<id>.base_url=…` | `-c model_providers.<id>.env_key=<VAR>`, por entorno (`Authorization: Bearer`) | `-m` (`src/agents/codex.ts:33`) | solo argumentos y entorno; `config.toml` no se lee, por `--ignore-user-config` (`src/agents/codex.ts:30`) |
| kimi | `[providers.<id>] base_url` | `api_key_env = "<VAR>"`, por entorno | `-m <id>/<modelo>`, con `default_model` en el mismo archivo; hoy el adaptador no pasa `-m` (`src/agents/kimi.ts:29`) | `$KIMI_CODE_HOME/config.toml`, temporal de la corrida; sin valores de clave |
| mimo | `provider.<id>.options.baseURL` | `options.apiKey = "{env:<VAR>}"`, por entorno | `--model <id>/<modelo>` (`src/agents/mimo.ts:32`) | `$XDG_CONFIG_HOME/mimocode/mimocode.jsonc`, temporal de la corrida; sin valores de clave |

Hechos que obligan a diseñar así:
- En kimi, el proveedor y el modelo se declaran en su `config.toml`, y `default_model` es obligatorio al usar `-m`. Por eso P17.3 se entrega junto con P17.5 para kimi.
- En kimi, `-m` prevalece sobre `default_model`.
- codex no lee su `config.toml` con el adaptador actual, así que su proveedor va siempre por `-c`.

## 5. Decisiones

1. **Claves por variables de entorno (K1).** Aprobada por el operador el 14 oct. Sin excepción: los cuatro CLIs leen la clave de una variable (§4).
2. **Quién inyecta: el operador (K2).** Propuesta.
3. **Vía: entorno o `-c` donde el CLI lo permite (claude-code, codex); archivo temporal con nombres de variables donde hace falta (kimi, mimo).** Sustituye a la propuesta de usar ACP: el inventario mostró que no hace falta. Propuesta.
4. **Endpoints de terceros con el límite declarado (alternativa B).** Aprobada por el operador el 14 oct. La red de los CLIs no está aislada (D5 del plan 15). El sandbox de red (P15.9) sigue como investigación y no bloquea P17.5. Controles mínimos de K7.
5. **Dos conectores MCP (alternativa C).** Aprobada por el operador el 14 oct: un conector para iniciar tareas y otro para configurar. El de tareas es el MCP actual, sin herramientas de configuración; es lo que reciben los CLIs. El de configuración es nuevo: usa un token de operador fijo, leído de una variable de entorno del operador y no de un archivo (K1), y reenvía sus llamadas a la API, que es quien autoriza. Así hay una sola frontera de escritura para la UI, la CLI y el conector. Recomendado: transporte `stdio`, como el conector de tareas, para no abrir otro puerto. P17.8 lo confirma.
6. **Orquestador con Nemotron.** Ya es el valor por defecto (`src/model/config.ts:51`). Lo que añade el plan es poder cambiar proveedor o modelo de cualquier rol o agente desde la UI o la CLI. Propuesta.

## 6. Tareas

- **P17.1 Plan y registro.** Hecha (`907e046`).
- **P17.2 Inventario por CLI.** Hecha. Resultado en §4; detalles en evidencia local.
- **P17.3 Modelo en el adaptador de kimi.** `profile.model` pasa a `-m`. *Dependencia:* `-m` exige que el modelo esté declarado en `config.toml` con `default_model`; se entrega junto con P17.5 para kimi. *Verificación:* argv con y sin modelo; con `default_model` distinto, `-m` gana. *Falsación:* quitar `-m` y la prueba falla.
- **P17.4 Proveedores del operador con endpoint y nombre de variable de clave.** Reutiliza `validateProviderConfig` (`src/model/config.ts:135`) y añade la regla de K7 para los endpoints de los CLIs. *Invariante:* K1. *Verificación:* una clave de prueba no aparece en la configuración, la API, el ledger ni los logs; un endpoint de metadatos o privado se rechaza al escribir y al arrancar. *Falsación:* imprimir la clave en un error, o aceptar un endpoint de metadatos, y la prueba falla.
- **P17.5 Inyección por CLI.** Entorno o `-c` para claude-code y codex; archivo temporal con nombres de variables para kimi y mimo, según §4. *Invariantes:* K1, K2, K4 y K6. *Verificación:* el servidor falso de P17.2, convertido en prueba, recibe el modelo y la clave correctos en cada CLI; ningún archivo de la corrida contiene un valor de clave; un documento de biblioteca no puede inyectar un endpoint; ningún CLI recibe el conector de configuración. *Falsación:* escribir un valor de clave en un archivo, o inyectar el conector de configuración, y la prueba falla.
- **P17.6 Proveedor y modelo por agente y por rol.** Validación: un modelo que el proveedor no declara se rechaza. *Verificación:* `roles.supervisor` en un modelo distinto del por defecto y de los demás roles; un servidor local recibe ese modelo. *Falsación:* ignorar el rol o enviar el modelo por defecto, y la prueba falla.
- **P17.7 Conector de tareas.** El MCP actual, sin herramientas de configuración (K3). *Verificación:* el inventario de herramientas del conector de tareas no contiene ninguna de configuración, con cada rol (`initiator` y `worker`). *Falsación:* añadir una herramienta de configuración a ese conector, y la prueba falla.
- **P17.8 Conector de configuración.** Token de operador fijo, leído de una variable de entorno; transporte `stdio` que reenvía a la API; herramientas para leer y escribir proveedores, roles, agentes e inyección, solo con nombres de variables (K1). *Invariantes:* K1, K3 y K6. *Verificación:* sin token, o con el token de otro rol, rechazo; con el token de operador, el cambio se aplica y queda en el registro; el conector no aparece en ninguna configuración inyectada (P17.5). *Falsación:* aceptar el token de iniciador para escribir, y la prueba falla.
- **P17.9 Escritura desde la UI y la CLI del operador.** Con token y mismo origen, como las escrituras actuales; pasa por la misma ruta de la API que P17.8. *Verificación:* sin sesión, 401 `BAD_TOKEN` como hoy; con sesión, el cambio se aplica. *Falsación:* quitar la comprobación de sesión, y la prueba falla.

## 7. Riesgos y límites

- Un CLI con endpoint y clave es un agente con acceso a una red sin aislar (K7, decisión 4). El sandbox (P15.9) decidirá cuánto más se puede limitar.
- El conector de configuración con token es el activo de mayor valor: quien lo tenga cambia proveedores y redirige claves. Mitigación: el token vive en el cliente del operador, fuera de `ENV_ALLOW` y de cualquier configuración inyectada (K6).
- Sin tarifa, el coste sigue el plan 10, D3: alerta, no bloqueo.
- No se incluye almacén de claves cifrado ni gestión de claves maestras.
- Un CLI nuevo que no lea su clave de una variable queda fuera del plan (K1).
- kimi y mimo necesitan un archivo temporal en la corrida. Contiene nombres de variables y el endpoint, no claves. Se crea con permisos restrictivos y se borra al terminar.

## 8. Preguntas abiertas

- Las decisiones 2, 3 y 6 siguen como propuesta. ¿Alguna objeción?
- P15.9 (investigación del sandbox) sigue abierta. No bloquea P17.5.
