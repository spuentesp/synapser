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
la biblioteca apenas validan `id` y no gobiernan una corrida. El plan añadirá un tipo de documento
estricto para recetas ejecutables. Los perfiles CLI, perfiles nativos y roles internos del sistema
seguirán distinguiéndose: el worker nativo es un agente que Synapser dirige; un CLI conduce su
propio bucle en una copia aislada y no recibe un canal de vuelta durante esa invocación.

## 3. Modelo de conceptos

- **Receta de tarea**: documento versionado con propósito, entradas, plan inicial, capacidades
  requeridas, skills requeridas o sugeridas, condiciones, no-metas, política de inicio, límites y
  política de divulgación del resultado.
- **Skill**: instrucciones curadas que especializan a un agente. No son permisos ni una fuente de
  verdad para los verificadores.
- **Perfil de agente**: ejecución y capacidades declaradas/validadas. Diferencia `native` de cada
  CLI y registra limitaciones de control, MCP, skills, salida estructurada, permisos y presupuesto.
- **Servidor MCP**: integración externa administrada por el operador, con transporte, proceso o
  endpoint, nombres de variables secretas, herramientas permitidas y clasificación de riesgo.
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
   curada y un snapshot fijado. Los casos holdout y el oráculo no se exponen al agente constructor.
   Se acotan los intentos y la divulgación para evitar que la revisión se convierta en un oráculo de
   reward hacking. El log de intentos no se considera por sí mismo un límite de tasa.
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
8. **Curar MCPs**: registrar un servidor MCP confiable, descubrir sus herramientas/esquemas, escoger
   qué perfiles pueden usarlas y qué tools quedan habilitadas. Separar el MCP de tareas de Synapser
   del conector MCP de configuración y de los MCP externos conectados a agentes.

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

La curación de MCP externos debe descubrir el protocolo y las herramientas desde el servidor real,
pero no confiar en sus descripciones como autorización. El operador fija una allowlist de herramientas
y perfiles. Un tool de escritura o efecto no puede eludir el broker de efectos: se rechaza hasta que
exista un puente verificable a la política y aprobación de Synapser. Ningún secreto se guarda como
valor en biblioteca, respuesta MCP, ledger o UI; solo se nombran variables permitidas.

## 6. Invariantes y criterios de falsación

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
  solicitante constructor; cuotas/incidencias se hacen cumplir por identidad y periodo, no solo se
  registran. Falsación: repetir requests excede el límite o recuperar un caso sellado.
- **RCP6 — MCP cerrado**: solo servidores y tools habilitados por el operador se exponen al perfil;
  tools con efectos no mediados por Synapser son inaccesibles. Falsación: servidor/tool desconocido,
  respuesta malformada o tool de efecto alcanza datos/escritura fuera de política.
- **RCP7 — Evidencia honesta**: el juicio del modelo/revisor nunca se presenta como verificación
  determinista. Las condiciones requeridas deben tener checker determinista, aprobación humana o una
  aceptación explícita auditada de evidencia secundaria. Falsación: solo un `PASS` textual marca DONE.
- **RCP8 — Persistencia única**: el journal SQLite y sus blobs siguen siendo fuente de verdad; las
  proyecciones se reconstruyen y no divergen. Falsación: editar `state/library` altera el documento
  recuperado o se requiere una segunda base para leer una versión publicada.

## 7. Verificación

- Contratos versionados para receta, selección de skills, configuración MCP, herramientas expuestas,
  eventos de curación y las respuestas de `task_catalog`/`task_request`.
- Pruebas deterministas para validación, enrutamiento, listas permitidas, presupuestos, divulgación, límites de
  cuota, snapshot, ledger y migración compatible de configuraciones anteriores.
- Pruebas de proceso con el MCP real de Synapser y servidor MCP local real: descubrir, allowlistear,
  invocar una herramienta inocua, rechazar una herramienta de escritura no mediada y comprobar trazabilidad.
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
4. **Recetas curadas**: esquema/versionado, grafo de tareas, política, divulgación, vista previa, casos dev y
   holdout, admisión manual, rollback.
5. **MCPs curados**: gestión visual de conexiones, descubrimiento de herramientas/esquemas, lista permitida por
   perfil/receta, protección de secretos y bloqueo de efectos no mediados.
6. **MCP de tareas**: catálogo y request tipado con receta/params; el MCP de tareas solo puede usar
   recetas publicadas y no obtiene herramientas del conector operador.
7. **UI de operación/curación**: editores visuales, explicación de ruta/skill/costo/límite, diferencias
   de versión y confirmación de publicación/configuración.
8. **Pruebas de composición y equipo rojo**: pruebas independientes de acceso al holdout, reward hacking,
   repetición del oráculo, evasión por MCP y recorrido MCP→worker→verificador.

## 9. Decisiones que siguen abiertas

1. **Alcance de “curación de MCP”**: este diseño incluye los MCPs externos que Synapser conecta a
   workers y la curación del catálogo MCP de tareas. La configuración del operador queda separada de
   los documentos publicables de biblioteca.
2. **Inicio por receta**: recomendación: cada receta declara `draft`, `auto_start_bounded` o
   `human_approval`; ningún efecto externo se ejecuta sin la política de efectos existente.
3. **Divulgación de revisión adversarial**: separar hallazgos de desarrollo de verificación sellada;
   el operador puede ver el reporte completo, mientras que un solicitante automatizado recibe una
   salida acotada según política.
4. **Cuotas**: definir límites por cliente MCP, identidad humana y receta, retención/periodo y respuesta
   al agotamiento. P18.8 es un contador append-only, no una barrera técnica.
5. **Fuente de capacidades MCP**: decidir qué propiedades se descubren del handshake y cuáles requieren
   declaración/confirmación del operador (especialmente side effects e idempotencia).

No se propone una dependencia de ejecución nueva ni una base SQLite adicional. Cada decisión que
amplíe el acceso de un worker a red, MCPs o efectos necesita diseño y falsación propios antes de
habilitarse.
