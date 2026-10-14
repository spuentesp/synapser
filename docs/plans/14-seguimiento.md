# Plan 14 — Seguimiento y traspaso

Fuente única de qué está hecho y qué falta del [plan 14](14-diseno-en-la-ui.md). Cualquier agente que
continúe **actualiza este archivo en el mismo commit** que cambia el código. `node scripts/plan-status.ts`
resume el estado y falla si una tarea marcada hecha no cita un commit.

Estados: `[ ]` pendiente · `[~]` en curso (anotar quién y desde cuándo) · `[x]` hecha (con `commit:` corto
y la prueba que la cubre) · `[!]` bloqueada (con motivo).

## Cómo trabajar aquí (leer antes de tocar nada)

- Repo `/data/agents/orca/synapser`, rama `main`. Node 24, baja superficie de dependencias: cada dependencia de ejecución la justifica el plan que la añade (decisión del usuario, 14 oct). La UI es React + Tailwind + shadcn/ui en `web/` (`npm run web:build`).
- Pruebas: `env -u NEBIUS_TOKEN env -u TAVILY_TOKEN npm test` (las pruebas vivas se omiten sin claves).
  Estado al traspaso: 466 pasan, 0 fallan, 9 omitidas (475 pruebas). Una tarea no está hecha si baja ese número.
- Pruebas vivas: `node --env-file=.env --test test/live/<archivo>.test.ts`. Las claves están en `.env`
  (gitignored); **nunca** imprimirlas ni commitearlas; revisar el diff antes de cada commit.
- Commits: mensaje claro, cuerpo con el porqué, y cerrar con `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
  No commitear `pnpm-lock.yaml` ni `design/` salvo el docx cuando se pide.
- **Resultados medidos y análisis de fallos NO van a archivos versionados** (memoria del usuario). Datos
  crudos en `evidence/` (gitignored); se informan en el chat. Los documentos dicen contratos, invariantes
  y criterios de falsación, no cifras.
- No usar `pkill -f` ni `kill` por patrón: mata el propio shell. Ubicar el PID con `ps ... | grep "[x]"`.
- Cada diseño nuevo trae sus invariantes, su verificador y su falsación, como en los planes 08–13.
- Idioma de la documentación: español. Código y mensajes de commit: inglés.
- Para ver la app: `scripts/sandbox.sh [puerto]` y abrir `http://127.0.0.1:<puerto>/`. **La UI nueva
  nunca se ha visto en un navegador real**: toda tarea de UI se verifica ahí antes de marcarla.

## Contexto que no está en el código

- `native` = el bucle de Synapser conectado a un proveedor de modelos (hoy solo OpenAI-compatible).
- Los CLI (claude, codex, kimi, mimo) conducen su propio bucle en la copia aislada; Synapser controla
  entradas, permisos y presupuesto y recoge el cambio. No tienen canal de vuelta (subtareas, efectos, MCP).
- El runner de CLI corre con HOME efímero, sin credenciales y con git apuntando a la nada
  (`src/agents/runner.ts`); la inyección de skills debe usar ese HOME, no el del usuario.
- Los modos headless están verificados en el plan 14 §1. `mimo` lee skills nativas desde
  `skills.paths` en `mimocode.jsonc`; la inyección usa el XDG config efímero, nunca el del usuario.

## Estado heredado (plan 13): hecho

P1 workflow/condiciones/MCP · P2 compuertas de efectos · P3 asesor · P4 niveles, escalera, pools,
`doctor` · P5 chat, API de workflows y vistas Chat/Workflows/Agentes. Docx de diseño en v0.4.

## Tareas

### Q1 — Adaptadores por agente y skills

- [x] Q1.1 Interfaz `AgentAdapter` con `capabilities` y `build/parse` (`src/agents/adapter.ts`); el
  `CliOneShotRunner` actual delega en ella sin cambiar el comportamiento. *Prueba:* toda la suite actual verde.
  commit: fb0b10a. Prueba: suite completa y regresión
  directa de delegación `build/parse` verdes.
- [x] Q1.2 `claude-code`: invocación, parser, permisos y presupuesto como parámetros del perfil.
  commit: f8a043b. Prueba: construcción exacta de argv,
  validación de permisos/presupuesto, parser sobre salida capturada y suite completa verdes.
- [x] Q1.3 `codex`: ídem; HOME efímero con `CODEX_HOME`.
  commit: b794c1b. Prueba: argv y parser capturados,
  sandbox validado, `CODEX_HOME` descartable y suite completa verdes.
- [x] Q1.4 `kimi`: ídem; `--skills-dir`.
  commit: 0a30408. Prueba: argv y parser sobre sesión
  capturada, HOME descartable, mecanismo `skills-dir-flag` y suite completa verdes.
- [x] Q1.5 `mimo`: ídem; averiguar el mecanismo de skills o declarar `prompt-prepend`. Hoy está
  deshabilitado por saldo (402): la prueba real puede quedar como omitida con motivo.
  commit: a836569. Prueba: `--help` y esquema del binario
  instalado, argv determinista, parser del 402 capturado y suite completa verdes; llamada pagada omitida por saldo.
- [x] Q1.6 `generic-cli`: envoltorio con parser `plain` (ya existe el parser).
  commit: 6386db6. Prueba: sustitución argv sin shell,
  parser `plain`, validación de perfil y suite completa verdes.
- [x] Q1.7 Inyección de skills por mecanismo (`native-dir`, `skills-dir-flag`, `prompt-prepend`) y registro
  en `agent_runs` de id + digest + mecanismo. *Invariantes:* L1, L2. commit: 41a06a2 · prueba:
  suite completa; falsación de procedencia/digest/rutas y de ampliación de permisos; corrida del runner
  con archivo de skill en HOME efímero y auditoría en fila + evento.
- [x] Q1.8 Prueba L5: cada flag que emite un adaptador está en su tabla de capacidades y existe en el
  `--help` del binario real (omitida si el binario no está). commit: 3966715 · prueba: igualdad entre
  flags construidos y `capabilities.cliFlags`; contraste con `--help` real de Claude, Codex, Kimi y MiMo;
  suite completa.
- [x] Q1.9 Una corrida real por CLI instalado con una skill inyectada, verificando que la skill llegó.
  commit: 27e89c4 · prueba: Claude Code instalado creó en la copia aislada el único archivo ordenado por
  una skill cuyo marcador no estaba en el prompt ni en el workspace; id, digest y mecanismo coincidieron
  en el resultado y `agent_runs`; suite completa.

### Q2 — Biblioteca, proveedores y API

- [x] Q2.1 Almacén `library/` en el estado: proveedores, skills, plantillas, agentes; versión por digest;
  cada cambio es un evento en el ledger del servidor. *Invariante:* L4. commit: f65802a · prueba: cuatro
  colecciones versionadas por digest, cambios y borrados encadenados con actor en `_server`, idempotencia,
  rechazo de identidades inseguras y reparación de una proyección adulterada; suite completa.
- [x] Q2.2 `Provider` (protocolo, baseUrl, apiKeyEnv, modelos con precio) y agentes `native` que lo
  referencian; migrar `endpoint` de perfiles a proveedor; precio declarado → costo conocido.
  commit: ebee726 · prueba: validación acumulada de proveedores, modelos y precios; migración
  determinista de `endpoint`; corrida del bucle `native` contra un servidor OpenAI-compatible local;
  costo conocido por tarifa declarada y costo desconocido ante tarifa ausente o ambigua; suite completa.
- [x] Q2.3 Roles del sistema (supervisor, worker, repair, advisor, chat) asignables a proveedor+modelo;
  hoy fijos en `defaultModelConfig()`. *Invariante:* L6. commit: 74c8046 · prueba:
  `test/model/system-roles.test.ts` (sin bloque `roles` = predeterminados; un rol movido no hereda fallbacks;
  documento inválido con todos sus problemas; redefinir un proveedor usado por un rol por defecto falla al cargar;
  extremo a extremo por `createRuntime` y `chat.send` contra servidor local: petición, modelo, clave y tarifa;
  `doctor` revisa la clave de cada proveedor de roles). Falsada con un runtime que ignora los roles y con un
  cargador sin validación de asignaciones por defecto. Suite completa.
  nota: en producción `worker` y `repair` no llegan a ninguna llamada. `runMission` siempre recibe
  `orchestration` y los perfiles nativos llevan proveedor propio (`modelFor`); solo la ruta sin orquestación
  (scripts y pruebas) usa el modelo del sistema para ellos. Decisión abierta: si el repair del plan 14 §2.1 debe
  gobernar también los perfiles nativos.
- [x] Q2.4 Prueba de conexión de proveedor (lista modelos + llamada mínima; la clave nunca sale).
  commit: 37562e2 · prueba: `test/model/connection.test.ts` (ocho casos: éxito con cabecera y tarifa declarada;
  sin clave no sale ninguna petición; 401 sin eco de la clave; redirección rechazada sin entregar la clave al
  destino; endpoint sin listado; 2xx sin `choices`; error de red solo por nombre; tiempo límite). CLI
  `provider test <id>` probado contra un servidor local: código 0, clave ausente de la salida. No escribe en el
  ledger; devuelve uso y costo estimado. Suite completa.
- [x] Q2.5 Congelar la biblioteca al iniciar un workflow. *Invariante:* L3. commit: 2e0fb44 · prueba:
  `test/library/freeze.test.ts` y `test/workflow/library-freeze.test.ts` (la instantánea se copia a los artefactos
  de la corrida y sobrevive sin los de `_server`; la primera instantánea gana; un motor que edita la biblioteca en
  mitad de la corrida sigue leyendo la versión de arranque). Falsada con lecturas en vivo. Suite completa.
  nota: ningún consumidor lee aún la biblioteca durante una corrida (proveedores nativos, skills y agentes siguen
  en el archivo); el manejador congelado queda como única vía cuando lo haga.
- [x] Q2.6 Endpoints CRUD (`/api/library/*`) con token y mismo origen; configuración inválida rechazada
  entera con todos los problemas. commit: ab89118 · prueba: `test/api/library.test.ts` (lecturas abiertas;
  escrituras sin token, con origen ajeno o malformado rechazadas; escritura repetida sin cambio; documento inválido
  con todos sus problemas y sin efecto; borrado con token; skills y agentes por sus reglas; plantillas solo objeto,
  sin esquema hasta Q3.2; id que no encaja con la ruta). Falsada quitando el guardia y la validación. Un solo
  guardia (`writeAllowed`) sustituye las tres copias. Precios decimales: `test/library/decimals.test.ts`, con la
  opción `decimals` de la forma canónica solo para la biblioteca (ver decisiones abiertas). Suite completa.
- [x] Q2.7 `synapser doctor` y `config show` leen la biblioteca además del archivo. commit: 70da347 · prueba:
  `test/library/read.test.ts` (sin biblioteca no se crea journal; leer no materializa la proyección; doctor muestra
  el índice, informa la clave de cada proveedor de biblioteca sin que sea fatal y falla un documento que ya no cumple
  sus reglas; `config show` lista el índice sin documentos; un manejador de solo lectura rechaza escrituras). Falsada
  con una lectura que sincroniza. Suite completa.
  nota: ninguna corrida usa aún proveedores ni agentes de la biblioteca; el archivo sigue siendo la fuente de
  ejecución. Cuando un consumidor los lea, pasa por el manejador congelado de Q2.5.

### Q3 — Diseñadores y plantillas (UI)

- [x] Q3.1 Diseñador de workflow: formulario, constructor de condiciones por verificador, validación en
  vivo contra el validador real, vista previa JSON. commit: 1c55261 · prueba: `test/api/designer.test.ts`
  (borrador válido sin escritura; borrador inválido con todos sus problemas y la redacción del validador; token
  y origen) y navegador real con Chromium headless (capturas en `evidence/`): un borrador válido se guarda; uno
  inválido lista sus problemas y deja Guardar deshabilitado; un borrador se edita y guarda con PUT. Suite completa.
  nota: esta tarea se empezó sin commit de reclamo previo (ver bitácora).
- [x] Q3.2 Plantillas parametrizadas e integradas: cambio acotado con pruebas, investigación con citas,
  revisión, migración con no-metas. commit: 1a118df · prueba: navegador real: cada plantilla, con parámetros, rellena
  el diseñador y el validador del servidor la acepta (Guardar habilitado); un alcance vacío muestra el problema del
  validador y deja Guardar deshabilitado. Las plantillas guardadas en la biblioteca siguen sin esquema (decisión
  abierta). Suite completa.
- [x] Q3.3 Diseñador de agente: adaptador, nivel, rol, permisos, presupuesto, pool, skills; muestra qué se
  puede y no controlar en cada modo.
  motivo: el usuario respondió «sí, ahora» (14 oct). Las skills se conectan con Q5.4 cuando esté, porque el archivo las asigna (D6).
  commit: 30eddf8 · prueba: `test/api/library.test.ts` (`GET /api/library/bases`: perfiles base con su estado en el archivo y los campos que decide el archivo; falsación: sin la ruta falla la prueba). Verificado en navegador, en el sandbox, con capturas en `evidence/` (no versionadas): crear un agente, etiquetas con comas, un guardado rechazado con su motivo, y el cambio entre «extiende un perfil» y «agente nativo propio» con la lista de perfiles y sus estados. Build de la web con `tsc -b`. Falta el campo de skills, que llega con Q5.4.
- [!] Q3.4 «Probar agente»: tarea trivial en una copia desechable; muestra resultado, costo y skills recibidas.
  motivo: respondidas las tres preguntas (14 oct): tope de tiempo obligatorio en los CLI sin tope en dólares; proveedor de prueba en el archivo; copia borrada al terminar, con el registro. Diseño al final, como decidió el usuario (decisión 2).
- [x] Q3.5 Editor de skills y de proveedores con prueba de conexión. commit: 129cadc · prueba:
  `test/api/library.test.ts` (la prueba usa el endpoint y la clave GUARDADOS; la clave no aparece en la respuesta;
  sin token no sale ninguna petición; destinos desconocidos o que no son proveedores se rechazan; una clave ausente
  se informa sin llamar a nadie) y navegador real con Chromium headless: crear y guardar un proveedor, probarlo
  contra un servidor local falso (la clave solo aparece como nombre de variable) y ver los problemas de un documento
  inválido (capturas `library-test.png` y `library-invalid.png` en `evidence/`). Suite completa.
- [!] Q3.6 Verificación en navegador real de todo lo anterior (capturas en `evidence/`, no versionadas).
  motivo: lo construido (Q3.1, Q3.2 y Q3.5) ya está verificado en navegador con capturas en `evidence/`; "todo lo
  anterior" incluye Q3.4, bloqueada por decisiones abiertas, y Q3.3 ya está hecha y verificada en el sandbox, así que solo falta Q3.4.

### Q4 — Inicio y pantallas sin datos

- [x] Q4.1 Pantalla de inicio: workflows activos, compuertas pendientes, agentes, costo acumulado.
  commit: f5cc434 · prueba: `test/api/home.test.ts` (instalación nueva sin actividad; un borrador cuenta como activo;
  una ejecución de agente con costo registrado suma en USD y una sin costo se cuenta aparte, nunca como cero; el planificador suma y el chat no) y navegador real: captura
  `home.png` en `evidence/`. Suite completa.
- [x] Q4.2 Estados vacíos que dicen qué hacer y enlazan al diseñador (Enjambre, Línea de tiempo, Por qué,
  Costo, Coordinación, Aprobaciones, Integridad). commit: f5cc434 · prueba: navegador real en un directorio de estado
  vacío: las vistas por corrida dicen qué hacer y ofrecen el diseñador (`empty-swarm.png` en `evidence/`). Al probar
  se encontró que sin corridas las vistas quedaban en esqueletos para siempre; corregido en el estado de carga del
  hook. Suite completa.
- [x] Q4.3 La corrida del workflow seleccionado es el contexto por defecto de las vistas por corrida.
  commit: f5cc434 · prueba: navegador real: al elegir un borrador en Workflows, el selector de corrida pasa a la corrida
  de ese workflow (verificado con dos borradores). Suite completa.
- [x] Q4.4 Vista de intervenciones del asesor y de efectos (hoy solo existen en CLI y MCP). commit: e9c8fb9 ·
  prueba: `test/api/workflow-notes.test.ts` (las intervenciones propuestas se listan con su estado y su razón; un
  workflow sin efectos lista ninguno; un workflow desconocido se rechaza) y navegador real: el detalle muestra ambas
  secciones con sus estados vacíos y la nota de solo lectura (`workflow-notes.png` en `evidence/`). Suite completa.

### P15 — Amenazas de la biblioteca y de las claves (plan)

- [x] P15.1 Plan y modelo de amenazas: `docs/plans/15-amenazas-de-la-biblioteca.md`, con su entrada en el índice. commit: 638b43e · prueba: cada `archivo:línea` citado se comprobó en el código; amenazas T1 a T11 con control, brecha y verificador; decisiones D1 a D7 para el usuario.
  nota: el plan se escribió antes de reclamar la tarea (proceso incumplido, como en Q3.1; ver bitácora).
- [x] P15.2 Controles provisionales IC1 a IC4 (sección 5 del plan), cada uno con su verificador y su falsación. commit: c736293 · prueba: IC1 `test/library/agent-rules.test.ts` (49 pruebas, una por campo rechazado y una por campo permitido); IC2 `test/config/provider-key-allowlist.test.ts`, `test/api/library.test.ts` y `test/library/read.test.ts`; IC3 `test/model/redirects.test.ts`; IC4 `test/api/host.test.ts`. Falsación hecha en los cuatro: IC1 con `argv` copiado y sin la regla de `enabled`, IC2 sin la lista de claves, IC3 con `redirect` por defecto, IC4 sin la comprobación de `Host`. Suite completa: 533 pruebas, 524 pasan, 9 omitidas, 0 fallan. Era prerrequisito de Q5.
- [x] P15.3 Decisiones D1 a D7 del usuario, tomadas el 14 oct (plan 15, sección 6). Lo que falta son sus implementaciones: P15.4 a P15.7. commit: 48bff9a · prueba: decisiones registradas en el plan 15 y en este tracker.
- [x] P15.4 D1 implementación: el token sale de la cookie HttpOnly y no del JSON de `/api/session`. En modo de procesos adversarios (P15.7), además, código de un solo uso impreso por `serve`. Verificación: `/api/session` no devuelve el token; falsación: volver al JSON.
  commit: 6e43ad1 · prueba: `test/api/session.test.ts` (7 pruebas: el cuerpo no trae el token; la cookie es HttpOnly y SameSite=Strict; una escritura vale con cookie o con cabecera, nunca sin ninguna ni desde otro origen; en modo adversario, sin código no hay cookie ni escritura, el código sirve una sola vez, cinco fallos cierran la puerta, y un canje desde otro sitio se rechaza), y `test/api/host.test.ts`. Falsación hecha: token de vuelta en el JSON (falla), cookie sin HttpOnly (fallan 2), cookie sin código en modo adversario (falla). Verificado en navegador en los dos modos, en el sandbox, con capturas en `evidence/` (no versionadas). Suite completa: 566 pruebas, 557 pasan, 9 omitidas, 0 fallan.
- [x] P15.5 D3 implementación: direcciones privadas y de metadatos de nube rechazadas tras resolver el nombre; el loopback sigue para proveedores locales. Verificación: un nombre que resuelve a una privada se rechaza; falsación: quitar la comprobación.
  commit: c9c1e9e · prueba: `test/model/destinations.test.ts` (11 pruebas: direcciones bloqueadas y permitidas; la búsqueda rechaza un nombre con una respuesta privada aunque otra sea pública; un nombre que resuelve a loopback sí llega al modelo local; una dirección privada escrita literal no sale de la máquina; la validación al escribir rechaza una dirección de metadatos). Falsación hecha en tres sitios: búsqueda sin comprobar (fallan 2), literal sin comprobar (falla 1), validación sin comprobar (falla 1). Dependencia nueva aprobada por el usuario: `undici` 8.11.2, exacto, con baja superficie. Suite completa: 580 pruebas, 571 pasan, 9 omitidas, 0 fallan.
- [x] P15.6 D4 implementación: las tarifas que suman al costo vienen solo del archivo; una tarifa de biblioteca se muestra y no suma. Verificación: el costo no cambia con una tarifa de biblioteca; falsación: sumarla.
  commit: 127cd40 · prueba: `test/library/run-e2e.test.ts`: el proveedor de biblioteca declara tarifas, y sus llamadas quedan sin costo (`costUsd` nulo). Falsación hecha: con la ruta anterior, la prueba falla («una tarifa de biblioteca llegó al costo»). La tabla de prueba de conexión sigue mostrando el costo estimado con la tarifa del documento: se muestra, no suma. Suite completa: 559 pruebas, 550 pasan, 9 omitidas, 0 fallan.
- [x] P15.7 D7 implementación: modo de confianza configurable en `synapser.config.json`, por defecto operador confiable. Verificación: cada modo tiene su prueba; falsación: ignorar el modo.
  commit: 6e43ad1 · prueba: `test/config/trust-mode.test.ts` (operator por defecto; adversarial aceptado; cualquier otro valor refuta el archivo entero) y `test/api/session.test.ts` (cada modo tiene sus pruebas). Falsación hecha: ignorar el modo (la prueba de modo adversario falla).
- [x] P15.8 D5 investigación de la red de los CLI: documentación de los Sandboxes, host y opciones A, B y C en el plan 15, sección 10. commit: 043b0ad · prueba: investigación sin código; la prueba de concepto de salida por proxy (B) queda pendiente de decisión.
- [!] P15.9 Prueba de concepto de D5 con `pasta`: un agente dentro de un espacio de red sin salida, salvo a un proxy del host que solo reenvía al host del modelo. Verificación: el host permitido responde, y cualquier otro destino falla (también el DNS y la IP directa).
  motivo: `pasta` no separa un puerto del loopback del host (verificado; ver plan 15, sección 10). `bwrap --unshare-net` con un proxy en socket Unix sí aísla para HTTP. Falta verificar `CONNECT` para HTTPS y un CLI real. Cambiar el mecanismo aprobado es decisión del usuario.

### Q5 — La biblioteca en las corridas

- [x] Q5.1 Resolvedor de configuración efectiva: proveedores y perfiles de cada corrida desde su instantánea (`r.library`); sin instantánea, sólo el archivo. Precedencia sólo-añadir: un documento de biblioteca con un id del archivo o integrado se rechaza al escribir. *Invariante:* L3. Lo usan el motor, el gestor (validación de ids dinámica), el runtime, la API y MCP.
  commit: 73931d4 · prueba: `test/library/resolve.test.ts` (10 pruebas: sin instantánea; biblioteca y agente nativo propios; extends con base desactivada; ids del archivo no tomables; clave no permitida al arrancar, IC2; ids integrados reservados; pool; proveedor y modelo declarados; vista tolerante; el motor para la corrida antes del lock). Falsación hecha en dos sitios: la reserva de ids (2 pruebas fallan) y el motor que deja pasar una biblioteca rota (1 falla). Suite completa: 543 pruebas, 534 pasan, 9 omitidas, 0 fallan.
- [x] Q5.2 Agentes de biblioteca en el catálogo, el planificador y los revisores, bajo IC1. Proveedor y modelo validados al escribir; borrar un proveedor o un agente referenciado da 409 con las referencias; un agente de biblioteca no puede usar un `pool` del archivo. Al arrancar, una referencia rota falla la corrida con su motivo.
  commit: 2dc2107 · prueba: `test/library/references.test.ts` (3 pruebas: proveedor en uso no se borra, una edición que quita un modelo en uso da 409 con el agente, un revisor de un workflow que aún puede arrancar da 409 y deja de contar al cancelarlo); `test/library/resolve.test.ts` (un revisor que la biblioteca no tiene hace fallar la corrida al arrancar; el pool se rechaza); `test/library/run-e2e.test.ts` (el planificador ve el agente de biblioteca en su catálogo y el revisor corre por el proveedor de biblioteca). Falsación hecha en cuatro sitios: sin 409 al borrar (2 pruebas fallan), sin 409 al editar (1 falla), sin revisión al arrancar (1 falla), y el pool sin rechazo (1 falla).
- [x] Q5.3 Prueba de extremo a extremo por `ProductionEngine`: un agente y un proveedor de biblioteca hablan con un servidor local, y un revisor de biblioteca evalúa. Falsación en el punto de consumo: cambiar el `baseUrl` del proveedor a mitad de corrida y comprobar que la llamada sigue yendo a la URL original.
  commit: 04a58ad · prueba: `test/library/run-e2e.test.ts`: una corrida real con `ProductionEngine` (diario, Zoanthrope, ejecutor), con un servidor local que hace de endpoint. El revisor de biblioteca corre por el proveedor de biblioteca y el planificador ve al agente en su catálogo. Una edición posterior a la instantánea, y otra hecha mientras se planifica, no llegan a la corrida. Falsación: un `FrozenLibrary` que lee la biblioteca viva manda la revisión al endpoint posterior y la prueba falla.
- [x] Q5.4 Skills de biblioteca inyectadas desde la instantánea (L1): `injectedSkills` en `AgentRunRequest`; agentes CLI con su mecanismo y nativos por `prompt-prepend`; id, digest y mecanismo registrados en la corrida. Sin cambio de permisos (L2).
  motivo: desbloqueada por D6 (14 oct): el archivo decide qué skill recibe cada agente; la biblioteca aporta el contenido; límites de 64 KiB por skill y 5 por agente.
  commit: e0c9e2b · prueba: `test/library/run-e2e.test.ts` (la revisión de un agente de biblioteca lleva al endpoint de la instantánea el texto de su skill, y su fila de la corrida guarda id, digest y mecanismo `prompt-prepend`); `test/library/resolve.test.ts` (6 pruebas: asignación con digest de sus bytes, skill ausente, tope de 64 KiB, más de 5 por agente, agente que no existe); `test/config/agent-skills.test.ts` (4 pruebas del mapa `agentSkills`). Falsación hecha en tres sitios: el registro no entrega skills (la prueba extremo a extremo falla), el bucle nativo no las antepone (falla), y el runner acepta una skill que no es de la biblioteca (falla `test/agents/skills.test.ts`). Camino CLI: conectado (`injectedSkills` llega a `runAgent`); su mecanismo y la prueba de L2 son los de Q1, sin volver a ejecutarlos de extremo a extremo en esta tarea. Suite completa: 559 pruebas, 550 pasan, 9 omitidas, 0 fallan.
- [x] Q5.5 «Probar agente»: sólo investigación escrita de lo que necesita (copia desechable, costo, permisos, proveedor sin costo). No se construye aquí; su diseño va al final.
  commit: 87a8403 · prueba: `docs/plans/14-probar-agente.md`: investigación con los hechos del código (copia desechable, tope de costo por adaptador, permisos, proveedor sin costo, registro) y sus preguntas al usuario. No construye nada, así que no hay código que falsar.

### Cierre

- [x] C.1 Actualizar el docx (v0.5) con las secciones del plan 14 (script en el scratchpad de la sesión
  anterior; si no está, regenerar con el mismo método: editar el XML sobre `design/Synapser_Diseno.docx`).
  commit: 6cd70dd · prueba: secciones 37 a 40 (qué cambió, estado, invariantes, límites y decisiones) en el estilo del
  documento; cabecera y pie en 0.5. El paquete se valida (XML bien formado, zip íntegro), convierte a PDF sin errores
  y la página de la sección 37 se revisó en imagen (`docx-section-37.png` en `evidence/`). El script no se versiona.
- [x] C.2 README: sección de configuración desde la UI. commit: c18a4b0 · prueba: sección `Configure from the console` en README.md, revisada contra el estado real (la biblioteca aún no la leen las corridas, y se dice así).
- [ ] C.3 Demo integrada y guion de vídeo (el usuario pidió **no** hacerla todavía).

## Decisiones del usuario

Ronda 1 (14 oct): 1) hacer funcionar la biblioteca: las corridas la leen. 2) «probar agente» se diseña al final, tras investigar. 3) excepción decimal aprobada. 4) riesgo de claves: plan 15. 5) el resto de la lista sigue igual.

Ronda 2 (14 oct): D1 cookie HttpOnly (en modo adversario, además código de un solo uso). D2 lista de claves en el archivo, vacía. D3 destinos públicos y loopback para locales. D4 tarifas solo del archivo. D5 investigar primero el sandbox; LangSmith queda como vista opcional. D6 el archivo asigna las skills, 64 KiB y 5 por agente. D7 configurable, por defecto operador confiable. Precedencia sólo-añadir confirmada. Probar agente: tope de tiempo obligatorio, proveedor de prueba en el archivo, copia borrada con registro. Publicación: traducción al inglés antes de publicar; skills solo dentro del proyecto (sin -g); los resultados medidos de `docs/plans/05` y `06 §15` se quitan de los archivos, sin reescribir el historial.

Ronda 3 (14 oct): dependencias con baja superficie, no cero (la regla de cero dependencias era mía, leída de la documentación y sin preguntar). P15.5 usa `undici` (versión exacta 8.11.2). Orden: P15.4 y P15.7 primero, después P15.5. P15.8 (D5) con `pasta`. Lo demás, aprobado.

Abiertas: licencia (decidir más tarde). Pendientes de implementar: P15.4 a P15.7 y Q5.4. Traducción al inglés, sin tarea todavía. Resultados medidos: quitados de `06 §14` y `06 §15` (14 oct); `05` no tiene ninguno.

## Bitácora de traspaso

| Fecha | Quién | Cambio |
|---|---|---|
| 2026-10-14 | Claude Sonnet 5.5 | Tracker creado; Q1–Q4 sin empezar. Último commit del código: `868ff29` |
| 2026-10-13 | GPT-5 Codex | Q1.1: contrato `AgentAdapter`; el runner CLI delega construcción y parseo sin cambiar su aislamiento. |
| 2026-10-13 | GPT-5 Codex | Q1.2: adaptador `claude-code`; perfiles con modelo, permisos y presupuesto explícitos. |
| 2026-10-13 | GPT-5 Codex | Q1.3: adaptador `codex`; sandbox por perfil y `CODEX_HOME` dentro del HOME descartable. |
| 2026-10-13 | GPT-5 Codex | Q1.4: adaptador `kimi`; parser de sesión aislado y mecanismo `--skills-dir` declarado. |
| 2026-10-13 | GPT-5 Codex | Q1.5: adaptador `mimo`; skills nativas confirmadas mediante `skills.paths` en config efímera. |
| 2026-10-13 | GPT-5 Codex | Q1.6: adaptador `generic-cli`; argv declarativo, parser `plain` y fallback `prompt-prepend`. |
| 2026-10-14 | Claude Haiku 5.5 | Q2.3 tomada tras el reclamo de GPT-5 Codex (`29ff01e`, sin código). Roles del sistema configurables en `synapser.config.json` y validados enteros; runtime y `doctor` los usan. |
| 2026-10-14 | Claude Haiku 5.5 | Q2.4: prueba de conexión por proveedor (`src/model/connection.ts`) y CLI `provider test`; la clave no aparece en el informe. |
| 2026-10-14 | Claude Haiku 5.5 | Q2.5: instantánea de la biblioteca por corrida, copiada a sus artefactos; el manejador congelado es la única vía de lectura de la corrida. |
| 2026-10-14 | Claude Haiku 5.5 | Q2.6: `/api/library` (lectura abierta; escritura con token y mismo origen); validación completa por tipo; guardia único; precios decimales en la biblioteca con la opción `decimals`. |
| 2026-10-14 | Claude Haiku 5.5 | Q2.7: `doctor` y `config show` leen la biblioteca con un manejador de solo lectura (sin sincronizar ni crear journal). |
| 2026-10-14 | Claude Haiku 5.5 | Revisión del trabajo de GPT-5 Codex (Q2.2): el cargador buscaba `providers[id]` sin propiedad propia; `provider: "constructor"` lanzaba `TypeError` en vez de `ConfigError`. Corregido en `src/config/load.ts`. |
| 2026-10-14 | Claude Haiku 5.5 | Q3.1: diseñador de workflow (formulario, condiciones por verificador, comprobación en vivo con el validador del servidor vía `POST /api/designer/check`, vista previa JSON). Empezado sin commit de reclamo previo: proceso incumplido, registrado aquí. |
| 2026-10-14 | Claude Haiku 5.5 | Q3.5: editor de biblioteca (proveedores, agentes, skills, plantillas) y prueba de conexión por POST contra el documento guardado; reclamo previo en `da9c984`. |
| 2026-10-14 | Claude Haiku 5.5 | Q4.1–Q4.3: inicio (`GET /api/home`), estados vacíos que enlazan al diseñador, y la corrida del workflow seleccionado como contexto. Corregido: sin corridas las vistas quedaban en esqueletos. |
| 2026-10-14 | Claude Haiku 5.5 | Q4.4: intervenciones del asesor y efectos en el detalle del workflow, solo lectura (`GET …/interventions`, `GET …/effects`). |
| 2026-10-14 | Claude Haiku 5.5 | P15: plan de amenazas de la biblioteca y de las claves, escrito antes de reclamarlo (proceso incumplido, registrado aquí). |
| 2026-10-14 | Claude Haiku 5.5 | Decisiones del usuario: 1 hacer funcionar la biblioteca; 2 «probar agente» al final, tras investigar; 3 `decimals` aprobada; 4 riesgo de claves: plan con modelo de amenazas (P15); 5 sin cambios. |
| 2026-10-14 | Claude Haiku 5.5 | Decisión del usuario: validar los documentos de biblioteca sin dependencias nuevas (opción A: tablas en `validate.ts`, `validateProfile` sobre el perfil fusionado). |
| 2026-10-14 | Claude Haiku 5.5 | P15.2: IC1 a IC4 implementados y falsados. IC1 añade una regla que el plan no tenía: `enabled: true` sólo si el archivo activa el perfil base. |
| 2026-10-14 | Claude Haiku 5.5 | Q5.1: la corrida lee su instantánea de biblioteca bajo el archivo vigente; una biblioteca que no cumple para la corrida entera (antes del lock). Diseño revisado con el asesor (regla estricta; reserva de todos los ids integrados; referencias inversas en 409 para Q5.2). |
| 2026-10-14 | Claude Haiku 5.5 | Q5.2: referencias: 409 al borrar o editar lo que un agente o un workflow usa; un revisor que la instantánea no tiene detiene la corrida al arrancar. |
| 2026-10-14 | Claude Haiku 5.5 | Q5.3 se escribió antes de reclamarlo (proceso incumplido, como P15); la reclamación queda registrada aquí. |
| 2026-10-14 | Claude Haiku 5.5 | Q5.4 bloqueada por D6 (quién adjunta skills y con qué límite); Q3.3 desbloqueada, porque Q5.2 ya está hecha. |
| 2026-10-14 | Claude Haiku 5.5 | Q5.5: investigación de «probar agente» en `docs/plans/14-probar-agente.md`, sin construir; preguntas al usuario en ese documento. |
| 2026-10-14 | Claude Haiku 5.5 | Segunda ronda de preguntas: D1 a D7 decididas (ver «Decisiones del usuario»); precedencia confirmada; Q3.4 respondida; publicación: licencia por decidir, track Coding & Agentic Engineering, traducción antes de publicar. |
| 2026-10-14 | Claude Haiku 5.5 | Q3.3 reclamada: el usuario respondió «sí, ahora». |
| 2026-10-14 | Claude Haiku 5.5 | Resultados medidos quitados de `06 §14` y `06 §15`; `05` no tenía. D5 investigada en el plan 15, sección 10 (P15.8). Orden acordado: Q3.3, luego Q5.4, luego seguridad. |
| 2026-10-14 | Claude Haiku 5.5 | Q3.3: diseñador de agentes en la biblioteca, sobre el mismo documento que el editor JSON; ruta `GET /api/library/bases`; verificado en navegador y con falsación de la ruta. Falta el campo de skills (Q5.4). |
| 2026-10-14 | Claude Haiku 5.5 | Q5.4: skills de biblioteca en las corridas. El archivo asigna (`agentSkills`), la instantánea aporta el contenido con su digest, el bucle nativo las antepone y la corrida guarda id, digest y mecanismo. Camino CLI conectado, pendiente de prueba extremo a extremo. |
| 2026-10-14 | Claude Haiku 5.5 | P15.4 y P15.7: el token sale de la cookie HttpOnly; modo de confianza configurable, con código de un solo uso en modo adversario. Entorno: el PATH encontraba el wrapper npm de zoanthrope 0.1.6 (el lock pide el binario de cargo, que ya no está); reconstruido el commit fijado 37ecffa en el scratchpad, con sha256 igual al del lock, y las pruebas se corren con `ZOANTHROPE_BIN`. |
| 2026-10-14 | Claude Haiku 5.5 | P15.5: destinos de proveedores de biblioteca con `undici` 8.11.2 (dependencia aprobada) y búsqueda guardada; loopback sigue permitido para modelos locales. |
| 2026-10-14 | Claude Haiku 5.5 | P15.9 (prueba de concepto de D5): `pasta` no separa un puerto del loopback del host; `bwrap --unshare-net` con proxy en socket Unix aísla para HTTP. Bloqueada: el mecanismo aprobado no sirve tal cual. |
