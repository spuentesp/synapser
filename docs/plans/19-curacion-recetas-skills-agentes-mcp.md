# Plan 19 — Curación de recetas, skills, agentes y MCP

Estado: propuesto para cerrar la brecha entre la intención de un agente iniciador y la ejecución
supervisada por Synapser. La fuente única del avance es [`14-seguimiento.md`](14-seguimiento.md).

## 1. Objetivo

Un agente conectado a Synapser debe poder pedir por MCP un trabajo de alto nivel —revisión,
revisión adversarial, alternativas, investigación o implementación— y recibir una ejecución
compuesta por workflows, agentes y skills que el operador haya curado y autorizado.

El orquestador traduce la intención en tareas, requisitos de capacidad y skills; el enrutador
determinista valida compatibilidad, autorización, presupuesto y política antes de despachar.
El modelo propone; no concede permisos, no instala skills y no certifica por sí solo el resultado.

## 2. Estado actual y decisión de persistencia

La biblioteca ya persiste proveedores, skills, agentes y plantillas como documentos versionados:
los bytes canónicos se guardan en artefactos direccionados por digest y cada cambio se registra en
el journal SQLite `_server` como evento `library_change`. Los archivos bajo `state/library/` son
una proyección reconstruible; cada corrida congela su propia vista de la biblioteca. Por tanto,
este plan reutiliza SQLite y el journal existentes; no migra el almacenamiento ni añade una base
paralela.

Las plantillas de UI actuales son presets que rellenan el diseñador; las plantillas guardadas en
la biblioteca apenas validan `id` y no gobiernan una corrida. La biblioteca agrega el tipo
versionado `recipes` con contrato estricto; `templates` conserva su validación y documentos heredados,
sin conversión implícita. La versión 1 de receta declara categoría, parámetros tipados, capacidades,
skills y servidores MCP requeridos, una plantilla de workflow con aceptación, política de inicio y
presupuesto. Esta validación comprueba forma e invariantes locales; referencias a comandos, perfiles,
rutas y MCPs se resolverán contra la configuración del operador antes de publicar o iniciar. Un
checker de revisión basada en el juicio de un agente queda como evidencia informativa en una receta;
no puede ser por sí solo una condición requerida.

Los perfiles CLI, perfiles nativos y roles internos del sistema seguirán distinguiéndose: el worker
nativo es un agente que Synapser dirige; un CLI conduce su propio bucle en una copia aislada y no
recibe un canal de vuelta durante esa invocación.

## 3. Modelo de conceptos

- **Receta de tarea**: documento versionado con propósito, entradas, plan inicial, capacidades
  requeridas, skills requeridas o sugeridas, condiciones, no-metas, política de inicio, límites y
  política de divulgación del resultado.
- **Skill**: instrucciones curadas que especializan a un agente. No son permisos ni una fuente de
  verdad para los verificadores.
- **Perfil de agente**: ejecución y capacidades declaradas/validadas. Diferencia `native` de cada
  CLI y registra limitaciones de control, MCP, skills, salida estructurada, permisos y presupuesto.
- **Servidor MCP**: integración externa administrada por el operador, con origen y versión fijados,
  transporte, proceso o endpoint, nombres de variables secretas, herramientas permitidas y
  clasificación de riesgo. Instalarlo, probarlo, habilitarlo para perfiles y retirarlo son acciones
  distintas y auditadas.
- **Workflow instanciado**: ejecución concreta que conserva la receta, perfiles, skills y digests
  que vio al iniciarse.

Las recetas ejecutables se exponen en la biblioteca como un tipo versionado estricto, separado de
los presets visuales legacy hasta que exista una migración no destructiva. Los parámetros de
ejecución de servidores MCP (comando, argumentos, endpoint, entorno y credenciales) pertenecen al
archivo/configuración del operador, nunca a una receta o documento de agente de biblioteca.

## 4. Casos de uso

1. **Revisión**: otro perfil inspecciona un diff o alcance explícito, sin escribir; entrega hallazgos
   referidos a rutas/evidencia. Su juicio es evidencia secundaria.
2. **Revisión adversarial**: un perfil verificador separado busca fallos y bypasses bajo una rúbrica
   curada y un snapshot fijado. Antes de ejecutar, la receta declara qué recibe el operador, el agente
   que pidió la revisión y el ejecutor que corregirá el trabajo; puede haber otros destinatarios
   aprobados por el operador. Synapser prepara una vista separada para cada audiencia antes de enviar
   el reporte. El ejecutor recibe por defecto lo mínimo necesario para corregir, sin casos holdout,
   prompts privados ni respuestas del oráculo. El operador diseña esa divulgación por tipo de hallazgo
   y audiencia. El registro de intentos no sustituye una cuota técnica.
3. **Alternativas**: produce opciones, trade-offs y evidencia sin modificar el workspace.
4. **Investigación**: busca y sintetiza información con procedencia verificable cuando la receta lo
   exige.
5. **Implementación**: descompone un caso de uso en tareas con alcance, no-metas y comprobaciones;
   puede añadir una revisión independiente como etapa posterior.
6. **Curar una skill**: crear/editar, evaluar localmente y admitir manualmente una versión; asignarla
   solo a perfiles autorizados. Mantener las evaluaciones `dev`/`holdout` y todas las repeticiones
   aprobadas según P16.4.
7. **Curar un perfil**: crear o ajustar un perfil CLI/nativo, ver sus capacidades efectivas y probarlo
   antes de habilitarlo; las recomendaciones de `doctor` no habilitan perfiles automáticamente.
8. **Curar MCPs**: instalar o registrar un servidor desde un origen y versión fijados, verificarlo,
   descubrir herramientas/esquemas, probar llamadas, y escoger perfiles y herramientas permitidas.
   Synapser inyecta la configuración aprobada en el entorno aislado del agente, sin copiar secretos
   al workspace ni al HOME del usuario; también permite revocar y retirar la instalación. El catálogo
   MCP de tareas declara qué integraciones requiere cada receta. El MCP de tareas de Synapser, el
   conector de configuración y los MCP externos siguen siendo superficies separadas.

## 5. Flujo de orquestación y curación

```text
task_catalog / task_request (MCP)
  → receta publicada + solicitud tipada
  → plan propuesto: tareas, capacidades, skills, perfiles, presupuesto y divulgación
  → validadores deterministas (biblioteca, autorización, política, presupuesto, alcance)
  → DRAFT o arranque permitido explícitamente por la política de la receta
  → snapshot congelado, despacho por adaptador y verificación de condiciones
  → resultado según audiencia + ledger auditable
```

El catálogo solo muestra recetas publicadas. La petición crea una propuesta explicable; el inicio
depende de la política de la receta y del operador, no de una regla global. Un perfil solo puede
recibir skills incluidas en la autorización del operador. El planificador selecciona un subconjunto
por tarea; la selección ausente, inválida o no compatible falla cerrada. Si falta una skill, el
borrador indica el hueco y puede proponer una skill, pero nunca la instala ni la asigna.

#### P19.6: frontera segura del primer catálogo/request

La publicación y despublicación son acciones explícitas del operador por API autenticada, ligadas al
digest vigente y auditadas en el journal `_server`; un `PUT` no publica y una edición/borrado retira
la versión anterior del catálogo. `task_catalog` solo expone recetas publicadas y válidas.
`task_request` valida estrictamente los parámetros tipados y su interpolación, crea un workflow
`DRAFT` y nunca lo inicia. La solicitud registra en el journal del workflow el id/digest de receta y
el digest/nombres de parámetros, sin duplicar los valores en el evento de procedencia. Los valores
sustituidos sí forman parte del documento de workflow almacenado: no se deben enviar secretos como
parámetros.

Esta primera entrega no afirma enrutamiento ni límites que el runtime no pueda hacer cumplir. Los
perfiles y costos devueltos son candidatos/estimaciones, no una asignación ni una reserva. En la
primera entrega, categoría, capacidades y skills no estaban ligadas al plan despachado, por lo que se
rechazaban. El binding de skills de P19.8 levanta ese rechazo solo para la combinación implementada:
workflow solicitado por receta con selección MCP exacta y worker `native` elegible; el resto sigue
fallando cerrado. También se rechaza un
presupuesto USD (sin tope USD efectivo) y las políticas `human_approval`/`auto_start_bounded` (sin
compuerta por receta y presupuesto agregado aplicado). Solo `draft` es aceptado. La divulgación se
marca “not configured”; `clientInfo.name` sigue siendo una etiqueta no autenticada, no una identidad
para cuotas. Estos rechazos se levantan únicamente cuando el runtime tenga los controles y pruebas
de composición correspondientes.

- **RCP10 — solicitud tipada sin ejecución implícita**: solo recetas publicadas para el digest actual
  son descubribles; publicar requiere operador autenticado. Parámetros no declarados, inválidos,
  capacidades/dependencias no ejecutables y políticas sin enforcement no crean workflow; una solicitud
  aceptada crea exclusivamente `DRAFT` y conserva procedencia por digest sin guardar valores crudos en
  el evento MCP. *Verificador:* API HTTP real y servidor MCP de Synapser comprueban publicación,
  retiro, validación, procedencia y estado; *falsación:* aparece una receta no publicada, un digest
  obsoleto se publica, un rechazo crea estado o la herramienta inicia una corrida.

La UI de curación de recetas será distinta del diseñador de corridas. Debe permitir editar propósito,
parámetros, grafo de tareas, capacidades, skills, verificadores, límites, permisos y divulgación;
validar con el servidor; previsualizar el workflow que produciría MCP; evaluar con casos `dev` y
`holdout`; y publicar manualmente una versión. La publicación y el rollback por digest quedan en el
journal. Los casos holdout no se sirven a los agentes que construyen o solicitan el trabajo.

La curación de MCP externos debe permitir instalar o registrar el servidor, descubrir el protocolo y
las herramientas desde el proceso real, fijar origen/versión/digest y probar llamadas antes de
habilitarlo. La instalación va a un espacio administrado por Synapser y requiere confirmación del
operador; una receta o agente no puede instalar paquetes. La configuración administrada por el
operador fija el comando o endpoint, argumentos, entorno, variables secretas y permisos; cada perfil
recibe solo la configuración aprobada para ese servidor y su allowlist de herramientas. Para CLIs,
el adaptador escribe la configuración dentro del HOME efímero de la corrida; para `native`, el
orquestador expone únicamente las herramientas MCP aprobadas en su registro de herramientas. No se
copian configuraciones al repositorio ni al HOME del usuario. Retirar o revocar un servidor impide
nuevas ejecuciones y no altera los snapshots ya registrados.

El primer transporte de P19.5 es `stdio` con `@modelcontextprotocol/client` fijado en 2.3.1. El
wrapper selecciona el handshake legacy `2025-11-25` y expone solo descubrimiento y llamada de
herramientas; limita el buffer de lectura del SDK, número de tools/páginas, tiempos y esquemas
soportados. En Linux verifica el scope de systemd antes del handshake y aplica 4 GiB, 64 tareas,
accounting y `KillMode=control-group`; al cerrar exige `ActiveState=inactive` y cgroup vacío. bwrap
confina el proceso a raíz de solo lectura, workspace/HOME scratch explícitos, `/tmp` privado y
namespaces de red, IPC y UTS separados. El `HOME` y `cwd` canónicos deben estar bajo `/tmp`; el comando
se expone desde `/usr`, el workspace o como archivo único de solo lectura. En plataformas sin
systemd/bwrap falla cerrado. Las pruebas con servidor MCP local real comprueban el límite efectivo,
la inaccesibilidad de un archivo host vecino, el aislamiento de loopback y el cierre de un descendiente
que llama a `setsid`. El SDK administra JSON-RPC y lifecycle del transporte, mientras Synapser mantiene
validación adicional de política. El límite del SDK es del buffer de lectura, no una garantía de tamaño
independiente por frame. La contención verificada reduce acceso accidental y persistencia de procesos,
pero no es una frontera frente a exploits del kernel: no configura seccomp. El namespace PID separa la
enumeración de procesos del host, pero no es una frontera contra exploits del kernel. Tampoco
provee proxy de salida; el networking queda completamente aislado. Las anotaciones del servidor no
autorizan herramientas. El cliente por sí solo no es un broker de efectos. La integración existente
es una concesión opt-in limitada a perfiles native/worker y herramientas que el operador atestigua
como read-only; no prueba semántica ni concede efectos. Fuera de ese corte, hasta que procedencia,
allowlist efectiva, identidad esperada, inyección por perfil y mediación de efectos estén conectados
y verificados, no se habilitan llamadas MCP ni se inyectan secretos o herramientas de efecto. El
transporte HTTP queda fuera de este incremento.

Cada MCP mantiene su scope propio (4 GiB y 64 tareas), y cada CLI conserva sus límites por invocación.
Además, `ProductionEngine` crea de manera perezosa un slice transitorio privado por workflow con
`MemoryMax=4G` y `MemoryAccounting=yes`; todos los scopes externos CLI/MCP de esa ejecución se
colocan debajo de ese padre, por lo que el cgroup aplica la cuota agregada elegida por el usuario.
La creación falla cerrada si no se pueden leer de vuelta las propiedades y el `memory.max` efectivo;
al finalizar, Synapser mata los scopes descendientes y exige que el slice desaparezca sin procesos.
`test/live/run-memory-scope.test.ts` verifica con dos scopes CLI benignos la pertenencia compartida y
el readback de un límite de prueba pequeño; `test/mcp/outbound-stdio-client.test.ts` verifica que un
servidor MCP real se inicia bajo el padre y conserva su techo individual. No se provoca OOM ni se
incluye el proceso principal de Synapser en la cuota; los procesos de la corrida no deben exceder el
límite configurado.

#### P19.5 — RCP6b: frontera local del proceso MCP

Un proceso stdio conectado por Synapser solo se considera contenido cuando se verificaron antes del
handshake el scope activo de systemd con `MemoryMax=4G`, `TasksMax=64`, accounting y `KillMode` de grupo,
y la frontera bwrap configurada. El workspace y HOME son rutas canónicas bajo `/tmp`; el proceso no ve
hermanos, root modificable, red de host ni archivos externos montados; un namespace PID impide enumerar
procesos del host o leer sus entornos. Cierre/timeout no se considera exitoso hasta que el scope quede
inactivo y su cgroup sin miembros. *Verificador:* proceso local MCP lee `/proc/self/cgroup` y los límites
efectivos, intenta leer un sentinel hermano y un proceso host de mismo UID, conectar a loopback y deja un
descendiente detached; las pruebas observan rechazo de los accesos y terminación completa.
*Falsación:* límite ausente/distinto, acceso fuera de mounts, conexión a host o scope/descendiente vivo
tras el cierre. Esto no afirma resistencia ante un exploit del kernel.

El registro inicial en `mcpServers` es solo configuración declarativa operator-owned: exige un id,
estado habilitado explícito, localizador HTTPS o `file:` sin credenciales, versión declarada,
runtime absoluto, argumentos separados, identidad de servidor esperada y allowlists por perfil
conocido. `synapser mcp artifact import <directorio-local> <entrypoint>` copia un paquete local
al almacén `state/mcp-artifacts/<digest>`; el digest versionado cubre rutas POSIX ordenadas,
bandera ejecutable y bytes. Se rechazan symlinks, archivos especiales, rutas no normalizadas y
árboles que excedan los límites de importación. Cada descubrimiento requiere el pin, crea una copia
efímera, vuelve a verificar el árbol y monta esa copia en solo lectura antes de iniciar el runtime.
Una entrada legacy sin pin se puede leer y mostrar, pero el endpoint la rechaza antes del spawn.

El pin acredita integridad de la copia local importada, no que el origen remoto declarado produzca
esos bytes: no se descarga ni valida firma upstream. El runtime configurado y las bibliotecas del
sistema tampoco forman parte del digest. `origin` y `version` siguen siendo procedencia declarativa,
no prueba criptográfica. El importador no ejecuta el paquete y no acepta variables de entorno. Un
filtro de marcadores comunes en `args` es solo higiene y no detecta todos los secretos; no se debe
tratar como control de divulgación. El panel operador permite crear/reemplazar registros completos
y deshabilitarlos; el GET que recupera runtime/argv está protegido por misma-origin y sesión/token.
El test-call es explícito, autenticado, sin secretos y confinado; su respuesta no se entrega al agente.
La integración inicial con agentes queda limitada a `nativeReadOnlyProfiles`: un permiso separado,
curado por tools descubiertas, asignable desde el panel solo a perfiles efectivos native/writer/worker.
La ruta dedicada valida el mismo filtro en servidor y conserva intacto el resto del registro; el PUT
general no puede crear ni modificar el permiso. Esto es una atestación del operador, no una prueba de
que el servidor MCP sea realmente read-only. No hay selección desde recetas/tareas ni inyección a CLIs;
no se habilitan advisor/repair, secretos ni tools con efectos, y el broker de efectos sigue pendiente.

**RCP6d — Integridad del paquete MCP ejecutado**: un proceso registrado solo puede arrancar desde
una copia aislada cuyo árbol completo coincide con el digest SHA-256 fijado; la configuración legacy
sin pin falla cerrada antes de crear el proceso. El digest cubre rutas relativas POSIX, bit ejecutable
y bytes; symlinks, especiales, traversal y tamaños fuera de límites se rechazan. *Verificador:*
importar el mismo árbol produce el mismo digest, cambiar bytes/modo altera el digest, la ejecución
resuelve un import relativo desde el paquete copiado aunque cambie la fuente, y alterar el almacén
detiene el spawn antes del handshake; un proceso real informa que el árbol está montado de solo
lectura. *Falsación:* un pin ausente/alterado ejecuta el proceso, la copia difiere del digest, una
dependencia relativa se resuelve desde la fuente mutable, un symlink escapa del árbol o se presenta
el digest local como prueba del origen remoto o del runtime del host.

El catálogo MCP de tareas vincula recetas publicadas con las integraciones necesarias. `task_request`
explica qué servidor/herramientas asignará y por qué; el inicio falla cerrado si falta una integración,
una versión o un perfil compatible. Los MCPs se llaman desde el agente mediante esa inyección, con
resultados auditados por servidor, herramienta y corrida. Una herramienta de escritura o efecto no
puede eludir el broker: se rechaza hasta que un puente verificable aplique la política y aprobación de
Synapser. Ningún secreto se guarda como valor en biblioteca, respuesta MCP, ledger o UI; solo se
nombran variables permitidas.

Las cuotas anti-oráculo son configuración del operador, ajustable por identidad autenticada y receta,
con un valor predeterminado y un techo duro. Synapser resuelve la identidad desde la sesión autenticada,
reserva cuota antes de iniciar y registra consumo, periodo y agotamiento; no acepta que el modelo
invente o cambie la identidad. La UI debe mostrar límites efectivos y permitir su ajuste sin editar
fixtures ni respuestas del verificador.

## 6. Invariantes y criterios de falsación

### Registro efectivo de capacidades (P19.2)

Una sola declaración canónica por adaptador alimenta el adaptador de ejecución, la validación de
perfiles y la tarjeta derivada que consulta el router. La matriz efectiva expone modo de ejecución,
salida estructurada/texto, mecanismo de skills, cliente MCP, inyección MCP de Synapser, modos y modo
de permisos configurado, allowlist de herramientas, dirección, presupuesto que el adaptador realmente
puede imponer, timeout, reanudación y steering. `mcp.client` significa solo que el CLI implementa un
cliente MCP; no afirma que Synapser inyectó una conexión. Hasta P19.5, `mcp.injected` no está disponible.

Las recetas y planes pueden requerir identificadores (`execution.native`, `execution.cli`,
`output.structured`, `output.text`, `skills.native`, `skills.prompt-prepend`, `skills.injectable`, `mcp.client`,
`mcp.injected`, `budget.usd`, `resume`, `permissions.tool-allowlist` o
`permissions.mode.<modo>`). El router solo compara estos requisitos con la matriz derivada del perfil
efectivo: etiquetas de biblioteca no pueden crear capacidades. Un identificador desconocido o ausente
de la matriz no es compatible y no se despacha tarea. Las pruebas de conformidad cotejan los flags
emitidos con la matriz y, cuando el binario está instalado, con su `--help` real.

### Selección de skills por tarea (P19.3)

`agentSkills` en el archivo del operador es una allowlist por perfil, no una instrucción que el modelo
pueda ampliar. Una tarea puede pedir un subconjunto explícito con id, si es requerido y el motivo. Si
omite la selección, se conserva el comportamiento previo de recibir la allowlist completa; una lista
vacía explícita significa que no recibe ninguna. Las skills requeridas deben estar autorizadas y el
perfil debe soportar inyección; de lo contrario la ruta se rechaza antes del proceso. Las recomendadas
que no estén autorizadas se omiten, nunca se buscan en la biblioteca viva. El runner valida el digest
contra el contenido congelado y registra id, digest, mecanismo y motivo de cada skill inyectada; el
motivo no altera permisos ni políticas del adaptador.

### Curación visual y evaluación local (P19.4)

La biblioteca conserva recetas y skills como versiones inmutables por digest. La UI ofrece un editor
visual inicial para los campos de intención/política de receta, vista previa no ejecutable y una
acción `check` que llama al mismo validador del servidor sin escribir. Guardar/publicar sigue siendo
un acto explícito separado; no se afirma que la API exija evaluación previa ni se inicia un workflow
desde la vista previa.

La evaluación `dev`/`holdout` recibe casos versionados bajo `test/` y salidas ya observadas por el
operador. No llama al modelo ni presenta texto de casos al agente evaluado; el ejecutor de tareas MCP
no recibe esta vista. Dev y holdout se califican por separado, se comprueba cobertura exacta de cada
caso/repetición elegido y todas las repeticiones deben pasar para declarar elegibilidad. La elegibilidad
es informativa, no una admisión automática. El UI permite inspeccionar historial y restaurar un digest
histórico de skill con motivo, validado de nuevo bajo la política vigente y auditado en el journal.

- **RCP9 — Curación sin ejecución implícita**: validar/preview no persiste ni arranca; evaluar procesa
  solo las salidas del split elegido y no hace llamadas externas; restaurar solo puede seleccionar un
  digest histórico válido para la identidad y política actuales. *Verificador:* API y Playwright
  prueban validación sin escritura, cobertura/repeticiones, filtrado por split, publicación manual y
  rollback auditable. *Falsación:* `check` añade un evento, holdout fallido resulta elegible, el UI
  dispara un modelo o se restaura un digest que no pertenece al historial.

- **RCP1 — Autoridad**: recetas, skills y documentos de biblioteca no amplían permisos del perfil,
  presupuesto, red, sandbox o herramientas. Falsación: una skill o receta cambia un flag protegido o
  un perfil no autorizado recibe una skill; debe fallar antes de crear el proceso.
- **RCP6h — Efectos MCP mediados por el broker**: el operador declara en el registro, por servidor,
  `effectTools`: herramientas que producen un efecto externo. Cada una debe estar en la allowlist general
  de algún perfil y nunca en `nativeReadOnlyProfiles`. Ningún perfil recibe esas herramientas de forma
  directa: el registro de corrida y el MCP de tareas siguen sin exponerlas. Un perfil solicita el efecto
  con `effect_request` de tipo `mcp.call` `{server, tool, arguments}`. El broker valida que el servidor
  esté habilitado y pinneado, que la herramienta figure en `effectTools` y que `arguments` sea un objeto
  JSON de hasta 20 000 caracteres. Prepara el resumen y el material del efecto: servidor, digest del pin,
  herramienta y SHA-256 de los argumentos; el texto del agente no entra en la decisión. La política
  por defecto es `deny`; el efecto solo se ejecuta tras la decisión del canal existente de aprobación,
  ligada a ese digest. La ejecución conecta el servidor pinneado en el sandbox de la prueba de
  herramientas, sin secretos, llama la herramienta con los argumentos aprobados y devuelve la salida
  como `UNTRUSTED_MCP_DATA` con tope de tamaño. *Verificador:* un servidor MCP local pinneado con una
  herramienta de efecto recorre `effect_request → PENDING → aprobación → DONE`. *Falsación:* una herramienta
  no declarada, un servidor deshabilitado o sin pin, un cambio de argumentos tras aprobar (`STALE`), un
  pin distinto del aprobado, o una salida que el runtime trate como instrucción, ejecutan o concede acceso.
- **RCP11 — Integridad del origen de receta**: el evento de solicitud queda en la misma transacción
  del journal que la revisión inicial; un iniciador no puede cambiar una definición nacida de receta,
  especialmente sus condiciones de aceptación. Solo el operador puede emitir una revisión posterior.
  *Verificador:* el e2e crea por MCP, intenta retirar/modificar condiciones y comprueba rechazo sin
  nueva revisión, y luego alcanza `DONE` por el checker original. *Falsación:* un reinicio o una llamada
  MCP deja un borrador de receta sin procedencia, acepta un cambio del iniciador o juzga la corrida
  contra condiciones distintas a las preservadas por el operador.
- **RCP2 — Selección acotada**: las skills por tarea son subconjunto de la allowlist del operador y
  de la snapshot congelada; cada inyección registra id, digest, adaptador y motivo. Falsación: skill
  no autorizada, borrada o modificada entre draft y start entra en la corrida.
- **RCP3 — Reproducibilidad**: la corrida usa la versión congelada de receta, agente, MCP y skill;
  actualizar la biblioteca/configuración no muta una corrida existente. Falsación: cambiar un documento
  a mitad de corrida altera una entrada ya congelada.
- **RCP4 — Enrutamiento**: toda tarea se asigna solo a un perfil habilitado con modo y capacidades
  compatibles, tier suficiente, skills permitidas y cupo/presupuesto. Si ninguno cumple, no hay
  despacho. Falsación: perfil incompatible, deshabilitado o fuera del presupuesto recibe una tarea.
- **RCP5 — Anti-oráculo**: revisión sellada no revela fixtures, prompts privados ni casos holdout al
  solicitante constructor; antes de ejecutarla, una política versionada define campos y nivel de
  detalle por audiencia. Cuotas configurables se hacen cumplir por identidad, receta y periodo, no
  solo se registran. Falsación: cambiar la política durante una corrida altera la entrega, se filtra
  un holdout o repetir requests excede la cuota efectiva.
- **RCP6 — MCP cerrado**: solo servidores y tools habilitados por el operador se exponen al perfil;
  configuración inyectada solo en el entorno aislado del perfil; origen y versión quedan fijados, y
  tools con efectos no mediados por Synapser son inaccesibles. Las configuraciones MCP preexistentes
  del HOME o workspace no constituyen autorización y deben quedar deshabilitadas por defecto.
  Falsación: servidor/tool desconocido, versión no aprobada, secreto filtrado o tool de efecto alcanza
  datos/escritura fuera de política, o un CLI arranca un servidor heredado sin autorización.
- **RCP6a — Transporte acotado**: el cliente stdio acepta solo el ciclo de herramientas explícito,
  aplica límites y valida el subconjunto de esquema que puede hacer cumplir; no ejecuta llamadas si no
  verifica supervisor y sandbox. Falsación: RPC desconocido, esquema con restricción no soportada,
  frame/paginación fuera de límites o argumento inválido que llega al servidor.
- **RCP5a — Revisor independiente ligado al snapshot**: una revisión solo la ejecuta un perfil `advisor`
  distinto de los perfiles que ya escribieron en la corrida. La ejecución recibe el digest de la ronda;
  su copia debe ser consistente y tener ese mismo digest, no puede producir cambios aceptados, y el árbol
  vivo debe conservar el digest al terminar. Los asesores nativos reciben solo `read_files`/`finish` y el
  handler rechaza mutaciones aunque el modelo las solicite. Sigue siendo evidencia secundaria, nunca
  aceptación determinista. *Verificador:* workflow con CLI de proceso real y pruebas del bucle nativo;
  casos de auto-revisión, cambio en copia y mutación concurrente deben fallar cerrados. *Falsación:*
  auto-revisión lanzada, digest diferente/inconsistente, cambios del reviewer, árbol vivo mutado o PASS
  secundario sin aceptación atribuida que marque DONE.
- **RCP6b — Frontera local del proceso MCP**: el scope verificado de systemd aplica memoria/tareas y
  termina todos sus miembros; bwrap limita mounts y red. *Verificador:* proceso stdio MCP informa sus
  límites cgroup, no lee sentinel host/no conecta a loopback y no deja un descendiente detached activo.
  *Falsación:* límite ausente/distinto, acceso externo, conexión a host o scope/descendiente activo tras
  cerrar. No implica resistencia a exploits del kernel.
- **RCP6c — Identidad y superficie por perfil**: un conector de registro exige coincidencia exacta de
  `name/version` anunciados por el proceso con la identidad fijada por el operador; publica únicamente
  herramientas incluidas en la allowlist explícita del perfil y rechaza llamadas directas fuera de ella
  antes de enviar RPC. *Verificador:* proceso MCP local anuncia identidad correcta/incorrecta, ofrece
  tools permitidas y ajenas, y se prueba filtrado más rechazo de la llamada no permitida sin que llegue
  al proceso. *Falsación:* identidad parcialmente distinta aceptada, tool ajena visible o llamada directa
  no autorizada alcanza al servidor.
- **RCP6e — Registro MCP operator-owned**: el alta/edición reemplaza el registro completo bajo la
  misma sesión de operador y la validación del archivo entero; el cambio se aplica al registro live
  solo después de validar y persistir. La revocación inicial es reversible (`enabled: false`) y solo
  bloquea nuevos discoveries; no borra artefactos ni afirma cancelar uno ya iniciado. *Verificador:*
  pruebas API rechazan lectura/escritura sin sesión y escrituras cross-origin; Chromium completa un
  reemplazo autenticado, persiste la desactivación y la lista live la observa sin reiniciar; el botón
  de discovery se deshabilita mientras el registro está apagado. *Falsación:*
  escritura no autenticada, configuración parcial o inválida aplicada, pérdida entre archivo y live,
  o revocación que elimina un pin compartido.
- **RCP6f — Concesión nativa separada**: el permiso `nativeReadOnlyProfiles` solo puede asignarse
  bajo sesión operator y a perfiles efectivos habilitados con `adapter=native`, `role=writer` y
  `nativeRole=worker`; cada tool debe existir también en la allowlist general del servidor. La UI
  obtiene candidatos del servidor y selecciona tools descubiertas; no escribe el registro general.
  La actualización dedicada conserva todos los demás campos, y el PUT general conserva o rechaza la
  concesión en vez de borrarla/cambiarla. El opt-in empty revoca. *Verificador:* pruebas HTTP y de
  configuración rechazan advisor, repair, CLI, perfil deshabilitado, herramienta no allowlisted y
  servidor apagado/sin pin; Chromium selecciona una tool para native worker, confirma exclusión de
  perfiles no elegibles y que una edición del registro general conserva el permiso. *Falsación:*
  permiso para perfil no nativo o no worker, tool fuera de allowlist, escritura sin autenticación,
  pérdida/modificación del permiso por PUT general o un perfil no elegible mostrado como candidato.
  “Read-only” es una declaración del operador y no acredita semántica ni neutraliza efectos.
- **RCP6g — Selección MCP de receta sin ampliación de permisos**: cada receta declara pares exactos
  servidor/herramienta, y cada servidor requerido debe tener al menos una herramienta nombrada. La
  solicitud resuelve solo perfiles `native` writer/worker con servidor habilitado y artefacto pinneado,
  y la ejecución intersecta la selección inmutable de la receta con la allowlist general y la concesión
  `nativeReadOnlyProfiles` del operador. La selección y el digest de configuración/pin observado al
  solicitar la receta se persisten como procedencia; cambiar esa configuración antes del inicio bloquea
  la corrida. La selección viaja fuera del plan del modelo y se hereda sin cambios en tareas delegadas y
  se conserva como metadato de procedencia en reparación; el runtime solo abre herramientas para tareas
  `worker` nativas elegibles. Una reparación no recibe herramientas MCP ni inicia un servidor. El
  registro de corrida expone únicamente las herramientas exactas al worker autorizado. Selecciones ausentes en
  workflows manuales conservan el comportamiento anterior; una lista vacía de receta significa cero
  herramientas. *Verificador:* e2e con MCP stdio local pinneado recorre `task_catalog → task_request →
  workflow_start → ProductionEngine → checker`, concediendo al operador `inspect` y `status` mientras
  la receta solo selecciona `inspect`; prueba unitaria rechaza la llamada directa a `status`, y el
  esquema rechaza servidores sin tool, pares inconsistentes y duplicados. Las skills requeridas de
  una receta se resuelven al digest vigente al crear el workflow, se guardan en su procedencia y se
  validan contra el snapshot congelado al iniciar. Solo se aceptan con binding MCP y perfil `native`
  worker que tenga cada skill en la allowlist de operador; el engine impone esa selección en todas las
  tareas write del plan, sin permitir que el planner la omita o amplíe. Una skill requerida sin MCP o
  sin worker compatible se rechaza antes de crear el workflow. *Verificador:* las pruebas de receta
  rechazan skill ausente o perfil no autorizado; el e2e comprueba el digest exacto, llegada al prompt,
  registro de inyección y rechazo antes de planificar si la skill cambia después del request. El binding liga al digest
  del registro/configuración observado al solicitar; se prueba que un cambio posterior de configuración
  se rechaza antes de spawn. El broker de delegación hereda ese binding del requester sin aceptarlo en
  la solicitud del agente. *Falsación:* el agente ve o
  llama una tool no seleccionada, una propuesta del planner amplía la selección, una revocación llega
  tarde, un workflow manual pierde compatibilidad, una tarea write omite la skill fijada o una subtarea
  delegada obtiene un grant más amplio.
- **RCP7 — Evidencia honesta**: el juicio del modelo/revisor nunca se presenta como verificación
  determinista. Las condiciones requeridas deben tener checker determinista, aprobación humana o una
  aceptación explícita auditada de evidencia secundaria. Falsación: solo un `PASS` textual marca DONE.
- **RCP8 — Persistencia única**: el journal SQLite y sus blobs siguen siendo fuente de verdad; las
  proyecciones se reconstruyen y no divergen. Falsación: editar `state/library` altera el documento
  recuperado o se requiere una segunda base para leer una versión publicada.

## 7. Verificación

- Contratos versionados para receta, selección de skills, configuración MCP, instalación y revocación,
  herramientas expuestas, política de divulgación por audiencia, cuotas y respuestas de
  `task_catalog`/`task_request`.
- Pruebas deterministas para validación, enrutamiento, listas permitidas, presupuestos, divulgación
  por audiencia, cuotas configurables y límite duro, identidad autenticada, snapshot, ledger y
  migración compatible de configuraciones anteriores.
- Pruebas de proceso con el MCP real de Synapser y servidor MCP local real: instalar/registrar,
  descubrir, allowlistear, inyectar la configuración, invocar una herramienta inocua desde un agente,
  revocar, rechazar una herramienta de escritura no mediada y comprobar trazabilidad.
- Prueba de composición desde solicitud MCP hasta receta publicada, enrutamiento, skills inyectadas por el
  adaptador, workflow ejecutado y verificador sobre el mismo workspace/snapshot. Usar CLI real cuando está
  disponible; pruebas live externas solo opt-in y con presupuesto explícito.
- UI verificada en Chromium real para diseñar, evaluar, comparar versión, publicar y revertir una
  receta, skill, perfil y MCP.
- Las fixtures `dev`/`holdout` se versionan bajo `test/`; resultados crudos y mediciones, en
  `evidence/` ignorado. No versionar cifras ni análisis de fallos.

## 8. Épicas propuestas

1. **Contratos y compatibilidad**: contratos estrictos; estrategia no destructiva para plantillas
  heredadas; inventario de roles internos, agentes CLI/nativos y MCPs.
2. **Registro de capacidades**: capacidades efectivas por adaptador/proveedor, límites por modo,
   disponibilidad, validación y prueba de perfil; el router no confía en capacidades de biblioteca
   que puedan ampliar el perfil base.
3. **Skills por tarea**: separar autorización del operador y selección contextual; guardar motivo,
   digests y mecanismo en workflow/ledger; resolver ausencia sin fallback silencioso.
4. **Recetas curadas**: esquema/versionado, grafo de tareas, política, divulgación por audiencia,
  vista previa, casos dev y holdout, admisión manual, rollback y cuotas por identidad configurables.
5. **MCPs curados**: gestión visual de instalación/conexión, origen y versión fijados, descubrimiento
  de herramientas/esquemas, llamada de prueba, inyección por perfil/receta, revocación, protección de
  secretos y bloqueo de efectos no mediados.
6. **MCP de tareas**: catálogo y request tipado con receta/params; el MCP de tareas solo puede usar
  recetas publicadas y solicita al router inyectar en cada agente únicamente los MCPs requeridos y
  autorizados. No obtiene herramientas del conector operador.
7. **UI de operación/curación**: editores visuales, explicación de ruta/skill/costo/límite, diferencias
   de versión y confirmación de publicación/configuración.
8. **Pruebas de composición y equipo rojo**: pruebas independientes de acceso al holdout, reward hacking,
   repetición del oráculo, evasión por MCP y recorrido MCP→worker→verificador.

## 9. Decisiones acordadas y política pendiente de detalle

1. **Alcance de curación MCP**: incluye registrar/instalar, probar, invocar, asignar por inyección de
   configuración y revocar MCPs externos para agentes, además de curar el catálogo MCP de tareas. La
   configuración ejecutable pertenece al operador, separada de los documentos publicables.
2. **Cuotas**: son configurables por identidad y receta, con valor predeterminado y techo duro. Falta
   fijar en el diseño de implementación los campos concretos, periodos y valores iniciales; el límite
   debe aplicarse antes de cada ejecución y no depender del registro histórico de intentos.
3. **Divulgación adversarial**: cada receta define antes de ejecutarse quién recibe cada parte del
   resultado. El operador puede ver el reporte completo; el ejecutor recibe solo lo habilitado por esa
   política. El diseño de implementación fijará categorías, nivel de detalle y opción de revisión
   humana previa a la devolución; el default no incluye secretos del verificador, prompts privados ni
   datos holdout.
4. **Inicio por receta**: recomendación: cada receta declara `draft`, `auto_start_bounded` o
   `human_approval`; ningún efecto externo se ejecuta sin la política de efectos existente.
5. **Capacidades MCP**: Synapser descubre las herramientas y sus esquemas, pero el operador confirma
   permisos y clasificación de efectos; las descripciones del servidor no son autorización.

No se propone una dependencia de ejecución nueva ni una base SQLite adicional. Cada decisión que
amplíe el acceso de un worker a red, MCPs o efectos necesita diseño y falsación propios antes de
habilitarse.
