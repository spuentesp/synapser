# Plan 15 — Amenazas de la biblioteca y de las claves

Estado: **controles provisionales implementados** (14 oct, P15.2); las corridas ya leen la biblioteca (Q5). Este plan
acota qué puede decir un documento de biblioteca, porque un documento escrito por la API se convertiría en
configuración de ejecución: comandos del host, claves enviadas a destinos y permisos de agentes. Este plan documenta
las amenazas con los controles que existen hoy, propone cuatro controles provisionales que sólo restringen (y por
tanto no necesitan una decisión previa), y deja las mitigaciones definitivas como decisiones del usuario (sección 6).

Todas las referencias `archivo:línea` se comprobaron en el código del commit en el que se escribió este plan.

## 1. Qué se protege

- **Claves de proveedor**: variables de entorno del servidor, que la API nunca debe devolver ni registrar.
- **Ejecución en el host**: los `argv` de los agentes CLI y los perfiles que los eligen.
- **HOME real del operador**: `~/.ssh`, `~/.config/gh`, `~/.netrc` y similares, que un agente no debe ver.
- **Contenido del workspace y de los prompts**: se envían a proveedores de modelos y a agentes con red.
- **Token de sesión**: es la puerta de todas las escrituras de la API.
- **Ledger**: la cadena de hashes debe seguir siendo verificable, y las acciones deben atribuirse a su autor.
- **Costo declarado**: las tarifas que dan el costo conocido de una corrida.

## 2. Actores y fronteras de confianza

- **Operador local**. Es confiable: edita `synapser.config.json`, que es la única fuente de ejecución que no sale de la
  API.
- **Documento de biblioteca**. Entra por la API con token, así que es un *dato* escrito por una sesión autenticada.
  No debe ser *autoridad* de ejecución: esa es la frontera que este plan protege.
- **Proceso local del mismo usuario**. Puede llamar a `127.0.0.1` y, como la sesión no comprueba origen, puede leer
  el token (T7).
- **Página de otro sitio** en el navegador del operador. No puede leer respuestas de otro origen ni fijar la cabecera
  `Origin` a su favor.
- **Página que cambia su dominio a `127.0.0.1` (DNS rebinding)**. Su origen y el `Host` coinciden, así que supera la
  comparación actual (T7).
- **Agentes CLI lanzados por Synapser**. Tienen red si el CLI la tiene, y lo que leen puede salir por ella (T10).
- **Proveedores externos y sus redirecciones**. Reciben prompts y claves (T5, T6).

## 3. Controles actuales

| Control | Dónde | Cubre | No cubre |
|---|---|---|---|
| Guardia de escritura: origen igual al `Host` y token | `src/api/server.ts:88` (`sameOrigin`), `:164–:170` (`tokenOk`, `writeAllowed`) | Escrituras desde páginas de otro origen | Procesos locales; rebinding, porque el `Host` no se valida contra una lista |
| Token por proceso | `src/api/server.ts:99` | Adivinanza del token | Lectura del token por cualquier proceso local |
| Sesión que entrega el token | `src/api/server.ts:377` | Nada más que el origen cruzado sin token | Cualquier llamada sin cabecera `Origin` recibe el token |
| API sólo en loopback | CLI `serve` y `listen(port, "127.0.0.1")` | Acceso remoto | Acceso desde procesos locales y rebinding |
| Validación de proveedor | `src/model/config.ts:143` (https o loopback), `:146` (forma del nombre) | Destinos no https en producción | La lista de nombres de variable: cualquier variable con forma válida |
| Clave fuera de los errores | `src/model/openai-compatible-provider.ts:323` (`#scrub`) | Clave en mensajes de error | Clave enviada a un destino malicioso |
| Llamadas de modelo | `src/model/openai-compatible-provider.ts:212` (`fetch` sin `redirect`) | — | Sigue redirecciones: el cuerpo (prompts) puede llegar a otro host (T6) |
| Prueba de conexión | `src/model/connection.ts:92` (`redirect: "manual"`) | Redirecciones en la prueba | No protege las llamadas de corrida |
| Entorno de agente | `src/agents/adapter.ts:83` (`ENV_ALLOW`, incluye `PATH`), `:100–:114` (`buildAgentEnv`), `:111` (`profile.env` sin lista blanca) | Credenciales por nombre (`SECRET_NAME`, `CREDENTIAL_ENV_DENY`) | `profile.env` puede fijar `PATH` o `LD_PRELOAD` (T4) |
| HOME de agente | `src/agents/runner.ts:63` (`makeScratchHome`), `:66` (`homeOverlay`) | Rutas absolutas y `..` | Cualquier ruta relativa, por ejemplo `.ssh` (T3) |
| Validación de perfil | `src/agents/profile.ts:188–:189` (`argv[0]` sin espacios, `{prompt}` obligatorio), `:194`, `:206`, `:211` (modos de permisos) | Formas malformadas | `argv[0]="bash"` es válido; `bypassPermissions` y `yolo` son modos válidos (T1, T2) |
| Biblioteca versionada | `src/library/store.ts` (digest por versión, evento por cambio) | Cambios sin rastro | No valida lo que dice el documento |
| Ledger encadenado | `src/audit/chain.ts` | Manipulación del historial | No autentica al autor: `ui:operator` es fijo |

## 4. Amenazas

Cada amenaza indica el actor, el activo, la vía, el control actual, la brecha, y el control provisional (sección 5)
o la decisión (sección 6) que la cierra.

**T1. Ejecución de comandos del host por un agente.** Actor: proceso local o rebinding. Activo: el host.
Vía: un perfil de biblioteca con `argv: ["bash", "-c", "…{prompt}"]` convierte el prompt en código de shell.
Brecha: `validateProfile` acepta `bash` como programa (`profile.ts:188`). **Control provisional IC1.**

**T2. Elevación de permisos del agente.** Actor: el mismo que T1. Activo: el alcance del agente.
Vía: `permissions.mode` con `bypassPermissions` (`profile.ts:194`), `yolo` (`:206`, `:211`) o modos equivalentes de
otros CLI. Brecha: el perfil de biblioteca puede fijarlos. **Control provisional IC1.**

**T3. Lectura de credenciales del HOME real.** Actor: el mismo. Activo: `~/.ssh`, `~/.config/gh`, `~/.netrc`.
Vía: `homeOverlay: [".ssh"]` enlaza la ruta real dentro del HOME del agente (`runner.ts:66`). La comprobación sólo
rechaza rutas absolutas y `..`. Brecha: cualquier ruta relativa. **Control provisional IC1.**

**T4. Sobrescritura del entorno del agente.** Actor: el mismo. Activo: el proceso hijo.
Vía: `env: {"PATH": "…", "LD_PRELOAD": "…"}` pasa `buildAgentEnv` (`adapter.ts:111`) porque sólo se filtran nombres de
credenciales. Brecha: no hay lista blanca de variables del perfil. **Control provisional IC1.**

**T5. Exfiltración de variables de entorno del servidor.** Actor: el mismo, o un proceso que controle la biblioteca.
Activo: cualquier variable del servidor (claves de otros proveedores, `TAVILY_API_KEY`, tokens).
Vía: `apiKeyEnv` acepta cualquier nombre con forma válida (`config.ts:146`); la clave viaja en `Authorization` a
`baseUrl`, que es cualquier https. Brecha: falta la lista de nombres permitidos. **Control provisional IC2.**

**T6. Exfiltración de prompts por redirección.** Actor: un proveedor (o un atacante con DNS) que redirige.
Activo: el contenido del workspace, que va en los prompts. Vía: `fetch` sin `redirect` (`openai-compatible-provider.ts:212`).
Un 307 u 308 reenvía el cuerpo al nuevo destino, y la cabecera `Authorization` sí llega si el destino es del mismo
origen (la prueba del plan 14 comprobó que se quita en un origen distinto). Brecha: las llamadas de corrida siguen
redirecciones. **Control provisional IC3.**

**T7. Robo del token y rebinding.** Actor: proceso local, o página que cambia su dominio a `127.0.0.1`.
Activo: el token, que abre todas las escrituras. Vía: `GET /api/session` no comprueba origen (`server.ts:377`); la
comparación de origen con el `Host` (`server.ts:88`) no protege contra rebinding, porque tras el cambio ambos valen el
dominio del atacante. Brecha: ausencia de lista blanca de `Host`. **Control provisional IC4.** El mecanismo final del
token es la decisión D1.

**T8. SSRF desde un proveedor de biblioteca.** Actor: quien escriba un proveedor. Activo: servicios internos y metadatos
de nube. Vía: un `baseUrl` https que resuelve a una dirección privada. Brecha: no hay política de destinos. Decisión D3.

**T9. Falsificación del costo.** Actor: quien escriba tarifas en la biblioteca. Activo: el costo declarado.
Vía: `usdPer1MIn` y `usdPer1MOut` en un documento de biblioteca. Brecha: la tarifa no tiene una fuente de confianza.
Decisión D4.

**T10. Red de los agentes CLI.** Actor: el propio agente o lo que lee. Activo: lo que el agente ve (incluido lo que el
CLI tenga en su configuración). Brecha conocida y declarada desde el plan 13: no hay aislamiento de red. Decisión D5.

**T11. Inyección de prompt por skills.** Actor: quien escriba una skill. Activo: el comportamiento del agente.
Vía: el contenido de la skill se incorpora como instrucciones. Residual: no se elimina; se acota con L2 (una skill no
amplía permisos), con el tamaño máximo y con la procedencia visible. Decisión D6.

## 5. Controles provisionales

Se implementan **antes** de que las corridas lean la biblioteca. Sólo restringen: no requieren decidir la política final.

**IC1. Agentes de biblioteca restringidos.** Un agente de biblioteca es uno de dos casos:
- (a) extiende un perfil integrado o del archivo con `extends`, y sólo puede fijar `description`, `tags`, `tier`,
  `timeoutMs` (acotado a una hora), `enabled`, `model`, `provider` y `temperature`. `enabled: true` sólo se acepta si
  el archivo ya activa el perfil base: un documento puede desactivar un perfil, no activarlo. Un agente que extiende un
  perfil que el archivo no activa queda desactivado aunque no diga nada.
- (b) es un agente nativo (`adapter: native`) con `role`, `description`, `tags`, `timeoutMs`, `provider` y `model`,
  sin `argv`, `env`, `homeOverlay`, `permissions` ni `maxBudgetUsd`.

Se rechazan `argv`, `env`, `homeOverlay`, `permissions`, `maxBudgetUsd`, `parser`, `pool`, `steerable` y
`disabledReason` en los dos casos, y `adapter`, `role` y `nativeRole` en el caso (a), con el motivo en la respuesta.
Las reglas de forma son tablas en `src/library/validate.ts`. Las semánticas las decide `validateProfile` sobre el
perfil fusionado, la misma regla que el archivo. Sin dependencias: el núcleo no añade ninguna (plan 14).
*Verificación*: un test por campo rechazado y uno por cada campo permitido (`test/library/agent-rules.test.ts`).
*Falsación*: copiar `argv` de la biblioteca debe fallar el test de (a); quitar la regla de `enabled` también.

**IC2. Nombres de clave permitidos.** `synapser.config.json` gana `providerKeyEnv`: lista de nombres de variables que
los proveedores **de biblioteca** pueden usar. Vacía por defecto. Un proveedor de biblioteca cuyo `apiKeyEnv` nombre algo
fuera de la lista se rechaza al escribir (400) y, si la lista cambia después, la corrida falla al arrancar con el motivo.
Los proveedores del archivo y los integrados no cambian. *Verificación*: rechazo al escribir (400), y `doctor` al arrancar marca el documento. Que una corrida se niegue a arrancar llega con Q5.
*Falsación*: sin la comprobación, el test de `TAVILY_API_KEY` falla.

**IC3. Sin redirecciones en las llamadas de modelo.** `fetch` usa `redirect: "manual"`, y una respuesta 3xx es un
error que no se reintenta ni cambia de destino. *Verificación*: un servidor redirige a un segundo servidor, y el
segundo no recibe ni cabeceras ni cuerpo. *Falsación*: con `redirect` por defecto, el test falla.

**IC4. Lista blanca de `Host`.** La API acepta sólo `Host` iguales a `127.0.0.1:<puerto>` o `localhost:<puerto>` del
servidor en ejecución; cualquier otro responde 421 antes de tocar la sesión o una escritura. *Verificación*: una
petición con `Host` ajeno a `/api/session` y a una escritura, ambas rechazadas. *Falsación*: sin la comprobación, el
test de rebinding simulado falla.

## 6. Decisiones que toma el usuario (no se implementan aquí)

- **D1. Token.** ¿Se entrega por un archivo con permisos de solo lectura para el operador, por un canal que no sea
  JSON, o se rota por sesión? Cierra T7 junto con IC4.
- **D2. Lista de variables.** ¿`providerKeyEnv` vive en `synapser.config.json` o en un archivo aparte, y qué valores
  trae por defecto? Cierra T5 de forma definitiva.
- **D3. Política de destinos.** ¿Se rechazan direcciones privadas y de metadatos de nube tras resolver el nombre?
  ¿Se permiten puertos no estándar y loopback para proveedores locales? Cierra T8.
- **D4. Fuente de tarifas.** ¿Las tarifas sólo vienen del archivo de configuración? Cierra T9.
- **D5. Red de los agentes CLI.** ¿Aislamiento de red, o se acepta con un límite declarado? Cierra T10.
- **D6. Skills.** ¿Quién puede adjuntar una skill a un agente, y con qué límite de tamaño y de contenido? Acota T11.
- **D7. Alcance del modelo de confianza.** ¿El operador local es confiable de extremo a extremo, o hay que tratar a los
  procesos del mismo usuario como un adversario? Cambia el peso de D1 y de IC4.

## 7. Verificación

Cada control tiene un verificador en las pruebas automáticas y una falsación, como en los planes 08 a 14. Las pruebas
se escriben con el criterio de falsar el control: cada prueba debe fallar si el control se quita.

| Amenaza | Control | Verificador | Falsación |
|---|---|---|---|
| T1, T2, T3, T4 | IC1 | pruebas por campo (rechazado y permitido) | copiar `argv` o `homeOverlay` de la biblioteca |
| T5 | IC2 | rechazo al escribir y al arrancar | quitar la comprobación de nombres |
| T6 | IC3 | servidor que redirige a un segundo servidor | `redirect` por defecto |
| T7 | IC4 | `Host` ajeno en sesión y escritura | quitar la comprobación de `Host` |

## 8. Fases y tareas

- **P15.1** Este plan, con su entrada en el índice y su sección en el tracker.
- **P15.2** Controles IC1 a IC4, cada uno con su verificador y su falsación.
- **Q5** La biblioteca en las corridas (sección de tareas del tracker). Sólo después de P15.2.
- **Decisiones D1 a D7** antes de cualquier mitigación definitiva. Este plan no las toma.

## 9. Lo que se comprobó en el código

- `buildAgentEnv` añade `profile.env` sin lista blanca de variables (`adapter.ts:111`).
- `makeScratchHome` enlaza `homeOverlay` desde el HOME real con sólo dos comprobaciones (`runner.ts:66`).
- `validateProfile` acepta `argv[0]` sin espacios, y `bash` lo cumple (`profile.ts:188`).
- La sesión entrega el token sin comprobar origen (`server.ts:377`).
- El servidor MCP toma su catálogo de la configuración de tiempo de ejecución (`src/mcp/server.ts`, función
  `catalog`), así que una restricción en el resolvedor llega también a MCP.
- La prueba de conexión no sigue redirecciones (`connection.ts:92`); las llamadas de corrida sí (`openai-compatible-provider.ts:212`).
