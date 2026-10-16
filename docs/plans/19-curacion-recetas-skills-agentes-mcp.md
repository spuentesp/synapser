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
