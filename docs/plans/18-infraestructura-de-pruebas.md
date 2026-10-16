# Plan 18 — Infraestructura de pruebas

Estado: **aprobado** (15 oct 2026); en ejecución, en el orden de §3. E4 está cerrada; las demás épicas siguen el estado de §8 y del [seguimiento](14-seguimiento.md). Este documento es la lista de tareas: trece épicas, cada una desglosada en historias. Se ejecuta en el orden de dependencias de §3. Cada épica se reclama en el [seguimiento](14-seguimiento.md) antes de empezar.

## 1. Problema

Hoy tenemos pruebas unitarias, de integración con fixtures y de contrato parcial, pero nada que ejecute Synapser de punta a punta como lo usaría un operador: un MCP que recibe una tarea, un agente que la hace en un sandbox, un workflow que aprueba o rechaza el cambio, y una interfaz que muestra el resultado. Tampoco hay contratos explícitos por herramienta, ni comprobaciones que impidan que un agente pase las pruebas sin resolver el problema (el riesgo que describe la literatura sobre *reward hacking* y *feature isolation*, que no hemos verificado por nuestra cuenta).

Objetivo: **poder correr Synapser aquí, de punta a punta, y que una prueba falle cuando el sistema no hace lo que dice.**

## 2. Principios

- **Contratos antes que pruebas.** Cada herramienta (MCP, API, CLI, adaptador, documento de biblioteca) tiene un contrato versionado. Un cambio de contrato rompe una prueba, no pasa en silencio.
- **El oráculo vive fuera del espacio del agente.** Las pruebas de aceptación no están en el repositorio que el agente edita, y el agente no puede leerlas ni cambiarlas.
- **Realista por defecto.** Un test de aceptación usa el binario real, un sandbox real y un repositorio desechable. Los dobles se usan solo en pruebas unitarias.
- **Cada dependencia se justifica con la historia que la introduce** (regla del proyecto: baja superficie). Ninguna herramienta entra sin una historia que la use.
- **Sin pruebas que dependen del tiempo de la máquina.** Los límites de tiempo se miden con reloj inyectado o con presupuestos amplios y documentados.

## 3. Orden y dependencias

```
E1 base ──► E2 contratos ──► E5 fixtures ──► E6 sandbox ──► E7 MCP e2e ──► E8 oráculo oculto
   │            │                  │                              │
   │            └──► E3 propiedades ─┴──► E4 mutación              └──► E9 UI (Playwright)
   │
   ├──► E12 arquitectura (independiente, puede ir en paralelo)
   └──► E13 gobierno de pruebas (transversal, se cierra al final)

Opcionales con decisión propia: E10 verificación formal (TLA+), E11 simulación determinista.
```

## 4. Épicas

### E1 — Base, convenciones y punto de entrada

**Objetivo:** un único comando que ejecute todo lo que corresponde a cada nivel, y reglas para clasificar cada prueba.

- **H1.1** Clasificar pruebas por nivel con un prefijo o carpeta: `unit`, `contract`, `integration`, `property`, `mutation`, `sandbox`, `e2e`, `ui`. *Criterio:* `npm run test:<nivel>` ejecuta solo ese nivel.
- **H1.2** Script `npm run verify` que corre tipado, pruebas unitarias y de contrato, y falla con el primer error. *Criterio:* en un árbol limpio termina con código 0 en menos de un tiempo acordado (se mide en H13.3).
- **H1.3** Cobertura con el reporte integrado de `node:test`, sin dependencias nuevas. *Criterio:* `npm run test:coverage` escribe un resumen por módulo en `evidence/coverage/`.
- **H1.4** Variable `ZOANTHROPIC_BIN` documentada en un solo sitio, con un script que comprueba el hash del lock antes de correr. *Criterio:* un binario con otra versión o hash hace fallar `verify` con un mensaje claro.

*Herramientas:* ninguna nueva.

### E2 — Contratos por herramienta

**Objetivo:** un inventario de todo lo que Synapser expone, con su forma exacta, comprobado por pruebas.

- **H2.1** Inventario de contratos: herramientas MCP de tareas y de configuración, rutas de la API, subcomandos de la CLI, flags de cada adaptador, formato de documentos de biblioteca, eventos del ledger. Un único archivo `docs/contracts/README.md` que enumera cada uno con su fuente. *Criterio:* cada contrato tiene un identificador `C-<área>-<n>`.
- **H2.2** Esquemas zod para cada contrato que hoy es un objeto sin esquema explícito (entradas de herramientas MCP, cuerpos de la API de configuración, eventos del ledger). *Criterio:* el esquema es la fuente de verdad, y el tipo TypeScript se deriva de él.
- **H2.3** Pruebas de contrato: validan que cada respuesta real cumple su esquema, y que un cambio incompatible falla. *Criterio:* una prueba que renombra un campo obligatorio falla con el identificador del contrato.
- **H2.4** Instantáneas (golden) de los contratos, versionadas. Un cambio de instantánea exige commit explícito. *Criterio:* `npm run contracts:update` es la única forma de regenerarlas, y deja rastro en el diff.
- **H2.5** Comprobación de compatibilidad: el contrato nuevo es compatible con el anterior salvo que la historia lo marque como cambio mayor. *Criterio:* una regla lo verifica en `verify`.
- **H2.6** Contratos de adaptador: para cada CLI, las banderas que Synapser emite existen en su `--help` real. *Criterio:* reutiliza la prueba `adapter-help` y la extiende a todos los contratos de adaptador.

*Herramientas:* zod (ya es dependencia). Para la validación de compatibilidad de H2.5 se evalúa un comparador de esquemas JSON; si no hace falta, se escribe la regla en el propio script.

### E3 — Pruebas basadas en propiedades

**Objetivo:** comprobar invariantes sobre entradas generadas, en lugar de casos escritos a mano.

- **H3.1** Propiedades para digests y direccionamiento de contenido: mismo contenido, mismo digest; cambio mínimo, digest distinto. *Criterio:* al menos 200 casos generados por propiedad, semilla fija registrada.
- **H3.2** Propiedades para el ledger: la cadena de hashes se mantiene para cualquier secuencia de eventos válidos, y se rompe al alterar cualquier evento. *Criterio:* la alteración de un byte cualquiera de un evento es detectada.
- **H3.3** Propiedades para validadores de biblioteca, de perfiles y de proveedores: ninguna entrada generada hace caer el validador con una excepción no controlada, y toda entrada rechazada trae al menos un problema. *Criterio:* cero excepciones no controladas.
- **H3.4** Propiedades para la construcción de argv e inyección: ningún valor de clave generado aparece en argv, en la plantilla del ledger ni en archivos escritos. *Criterio:* se verifica para todos los CLIs y todos los protocolos admitidos. Esta es la propiedad que más importa para K1.
- **H3.5** Propiedad de escritura de configuración: una escritura aceptada seguida de una relectura da la misma configuración; una escritura rechazada no cambia el archivo. *Criterio:* para secuencias generadas de cambios.
- **H3.6** Reproducibilidad: cada fallo de propiedad imprime la semilla y el caso mínimo, y se puede reproducir con una variable de entorno. *Criterio:* `SEED=<n> npm run test:property` repite el fallo.

*Herramienta recomendada:* **fast-check** (dependencia de desarrollo). Justificación: es la biblioteca estándar de propiedades en TypeScript y ya cubre la reducción de casos (shrinking) que necesitamos para H3.6. Se incorpora con versión exacta en H3.1.

### E4 — Mutación

**Objetivo:** medir si las pruebas detectan fallos reales, no solo si cubren líneas.

- **H4.1** Configurar Stryker sobre un conjunto acotado: ejecutor, journal, validadores de biblioteca, `config/write.ts`, `agents/inject.ts`. *Criterio:* `npm run test:mutation` termina y produce un informe por archivo.
- **H4.2** Línea base: medir el *mutation score* actual de esos módulos y registrarlo en el plan, sin umbral todavía. *Criterio:* cifra registrada con fecha y commit.
- **H4.3** Umbral por módulo, subido de forma gradual. Un mutante sobreviviente en un módulo de seguridad (`inject.ts`, validadores) bloquea el umbral. *Criterio:* umbral en `verify` solo para los módulos de seguridad.
- **H4.4** Mutantes sobrevivientes se convierten en pruebas nuevas en la misma historia, o en un registro justificado. *Criterio:* ningún mutante sobreviviente en seguridad sin justificación escrita.

*Herramienta recomendada:* **Stryker** (`@stryker-mutator/core`). Justificación: es el estándar para JavaScript y TypeScript, y permite limitar el alcance por archivo, que es lo que necesitamos para no tardar horas. Se usa solo en `test:mutation`, nunca en `verify` completo, por tiempo.

### E5 — Fixtures realistas

**Objetivo:** datos de prueba que parecen un proyecto real, no cadenas de ejemplo.

- **H5.1** Generador de repositorios desechables: un proyecto pequeño, con pruebas, un historial de git y una dependencia local. *Criterio:* un generador determinista que, con la misma semilla, produce el mismo árbol.
- **H5.2** Agentes CLI de prueba con comportamientos programados: terminar bien, excederse en tiempo, fallar a mitad, cambiar archivos fuera de su alcance, y responder con texto que intenta una instrucción (inyección). *Criterio:* cada comportamiento tiene una prueba que lo exige.
- **H5.3** Endpoint de modelo falso, compatible con el protocolo de OpenAI y con el de Anthropic: respuestas programadas, llamadas a herramientas, errores 401, 429 y 500, y registro de cada petición. Es lo que ya usamos en P17.2, convertido en fixture reutilizable. *Criterio:* una sola implementación para todas las pruebas.
- **H5.4** Datos de biblioteca y de configuración de ejemplo, completos y válidos, más una versión inválida por cada regla. *Criterio:* cada regla de validación tiene un ejemplo que la rompe.
- **H5.5** Semillas registradas para cualquier fixture aleatorio. *Criterio:* reproducción con la semilla impresa.

*Herramientas:* ninguna nueva. Se escriben sobre `node:http` y `node:child_process`.

### E6 — Sandbox de ejecución

**Objetivo:** que las tareas de agente corran aislados, con red limitada, y que el aislamiento se pruebe.

- **H6.1** Arnés de sandbox con `bwrap`: sistema de archivos de solo lectura salvo el espacio de trabajo, sin acceso a la red salvo loopback hacia el endpoint falso. *Criterio:* una prueba intenta leer `~/.ssh`, escribir fuera del espacio y conectarse a un endpoint falso de loopback; las tres acciones deben fallar desde el sandbox.
- **H6.2** Pruebas de fuga de credenciales con centinelas, generalizando la puerta K8: un valor centinela en cada archivo de credenciales que el sandbox pueda ver nunca llega a un endpoint. *Criterio:* aplica a todos los CLIs y protocolos admitidos; el endpoint local captura los requests y rechaza el test si aparece cualquier centinela.
- **H6.3** Prueba de red con destino permitido para escenarios que necesitan red del modelo. Se descarta `pasta` como barrera porque el mapeo de loopback no separa servicios del host. La alternativa B es `bwrap --unshare-net` y un proxy host expuesto por socket Unix, con puente local al proxy. *Invariante:* sin proxy no existe salida; el proxy solo establece `CONNECT` a la autoridad exacta configurada. *Criterio:* DNS, IP directa y loopback directo no alcanzan destinos; el fixture HTTPS autorizado sí, y otra autoridad recibe rechazo. *Verificador:* `test/live/p159-network-proxy.test.ts`. *Falsación:* quitar el namespace, permitir otra autoridad o evitar el proxy debe hacer fallar el test. Esta alternativa fue autorizada por el usuario el 15 oct.
- **H6.4** Límites de recursos: tiempo, memoria y número de procesos. *Criterio:* un agente que entra en bucle se detiene y deja el estado registrado. El tiempo se impone con `timeout`, la memoria con `RLIMIT_AS` y los procesos con `TasksMax` en un scope transitorio de systemd por ejecución; el límite de procesos no usa `RLIMIT_NPROC`, que es compartido por UID.

  **Invariantes:** (1) cada scope es transitorio y limitado a una invocación; (2) el límite es de tareas del kernel y abarca descendientes, no una cuenta aproximada de procesos; (3) no se cambia el límite del scope padre ni se instala configuración persistente; (4) si falta systemd de usuario, la prueba del límite por tareas se omite explícitamente, sin declarar probado ese límite.

  **Verificador:** `test/sandbox/isolation.test.ts` intenta crear más procesos que el límite dentro de `bwrap` y exige el error de fork del kernel, mientras comprueba que no vence el timeout. `processLimitAvailable()` verifica antes que el host acepte un scope transitorio. **Falsación:** si el ataque completa, vence por timeout, o solo pasa porque no arrancó el scope, H6.4 no está verificada.

*Herramientas:* `bwrap` y `pasta` ya están instalados en la máquina. Docker no hace falta, y no se introduce.

### E7 — MCP de punta a punta

**Objetivo:** un cliente MCP real pide una tarea, Synapser la ejecuta en un sandbox sobre un repositorio desechable, y el resultado se comprueba desde fuera.

- **H7.1** Cliente MCP de prueba que arranca `synapser mcp` como proceso, habla por stdio y consume las herramientas tal como las vería Claude Code. *Criterio:* el cliente solo usa el protocolo, sin llamar a funciones internas.
- **H7.2** Historia de tarea completa: crear workflow, arrancarlo, aprobar la compuerta, y comprobar el cambio aplicado en el repositorio. *Criterio:* el repositorio cambia solo en el alcance declarado.
- **H7.3** Caso de rechazo: una tarea que el agente no puede completar termina en el estado correcto, sin cambios parciales. *Criterio:* el estado final es el declarado y el repositorio queda intacto.
- **H7.4** Conector de configuración de punta a punta: `mcp-config` cambia un proveedor, y la tarea siguiente lo usa. *Criterio:* la tarea registra el proveedor nuevo en el ledger (K4).
- **H7.5** Ejecución con un CLI real opcional, marcada como `live`, que no corre en `verify`. *Criterio:* requiere variable de entorno explícita y cuota aprobada.

*Herramientas:* el cliente del protocolo que usamos en P16.2 (`@modelcontextprotocol/server` no incluye cliente; antes de añadir uno, la historia verifica si hay un paquete cliente oficial y su versión exacta).

### E8 — Oráculo oculto y anti-trampas

**Objetivo:** que el agente no pueda aprobar las pruebas sin resolver el problema.

- **H8.1** Pruebas de aceptación fuera del espacio de trabajo: viven en un directorio que el sandbox no monta. *Criterio:* el agente no puede leerlas (prueba de H6.1 aplicada a este directorio).
- **H8.2** Pruebas compuestas: cada tarea de aceptación combina al menos dos capacidades del sistema, para que no basten módulos aislados. *Criterio:* una implementación que pasa cada capacidad por separado y falla la combinación es detectada.
- **H8.3** Detección de codificación de resultados: una tarea de aceptación con entradas no vistas por el agente. *Criterio:* una respuesta que solo memoriza las entradas visibles falla.
- **H8.4** Mutación guiada sobre el código que el agente escribe: se ejecutan las pruebas de aceptación contra mutantes del cambio. *Criterio:* un cambio que sobrevive a mutantes triviales se rechaza.
- **H8.5** Registro de intentos: el número de ejecuciones contra el oráculo queda registrado, para detectar búsquedas por fuerza bruta. *Criterio:* el registro existe y se consulta en el informe.

*Herramientas:* las del resto de épicas (sandbox, fast-check para generar entradas no vistas, Stryker para H8.4).

### E9 — Interfaz con Playwright

**Objetivo:** las pantallas se usan de punta a punta en un navegador real, contra un servidor real con datos de fixture.

- **H9.1** Arranque de `synapser serve` con estado de fixture en un puerto libre elegido por la prueba. *Criterio:* la prueba no depende de los puertos 4173 o 4177.
- **H9.2** Flujo de inicio: abrir la página, obtener la sesión, ver la pantalla de inicio. *Criterio:* sin errores en consola.
- **H9.3** Flujo de workflow: crear, ver el estado, aprobar una compuerta, ver el resultado. *Criterio:* cada paso se comprueba por lo que se ve, no por el DOM interno.
- **H9.4** Flujo de biblioteca: crear un agente con un proveedor, comprobar que la validación de la interfaz coincide con la de la API. *Criterio:* el mismo mensaje de error.
- **H9.5** Pantalla de configuración de proveedores y roles (P17.9, si se aprueba). *Criterio:* un cambio inválido muestra los problemas del validador sin mostrar valores de clave.
- **H9.6** Accesibilidad básica: foco, etiquetas y contraste comprobados automáticamente en cada pantalla. *Criterio:* cero violaciones de nivel crítico.

*Herramienta recomendada:* **Playwright** (`@playwright/test`), con navegadores instalados por una historia separada. Justificación: es el estándar para pruebas de navegador, tiene aserciones sobre lo visible y traza de fallos. Se ejecuta en `test:ui`, no en `verify`, por tiempo.

### E10 — Verificación formal (opcional, con decisión)

**Objetivo:** un modelo del diseño de concurrencia que se comprueba con un verificador de modelos, separado del código.

- **H10.1** Decisión registrada: qué partes se modelan (transiciones del journal, claims de Zoanthrope, bloqueo por workspace). *Criterio:* aprobación explícita antes de escribir el modelo.
- **H10.2** Modelo en TLA+ de las transiciones del journal, con las propiedades de seguridad (no hay dos escritores con el mismo claim) y de vida (una acción pendiente termina). *Criterio:* el verificador termina sin contraejemplos en el alcance acordado.
- **H10.3** Trazabilidad: cada propiedad del modelo enlaza con una prueba de implementación. *Criterio:* una tabla en el plan 01.
- **H10.4** Ejecución del verificador en `test:formal`, fuera de `verify`. *Criterio:* requiere JDK (ya está) y el jar de TLA+ fijado por hash.

*Herramienta:* **TLA+** (tla2tools con TLC). Quint queda como alternativa si el equipo prefiere sintaxis tipo TypeScript; no se incorpora ahora. Dafny y Lean no se recomiendan para este código: el coste de demostrar código asíncrono con procesos y E/S es mayor que el riesgo que cubren.

### E11 — Simulación determinista (opcional, después de E7)

**Objetivo:** reproducir fallos de recuperación con un reloj, un disco y una red controlados por semilla.

- **H11.1** Inyección del reloj y del generador aleatorio en el journal y el ejecutor. *Criterio:* ninguna llamada directa a `Date.now` o `Math.random` en el núcleo, comprobada por una regla de lint.
- **H11.2** Disco simulado con fallos programados (escritura parcial, falta de `fsync`). *Criterio:* la recuperación del plan 04 pasa para todas las semillas de un rango fijo.
  - **Invariantes:** el modelo separa imágenes durables del inode (bytes y modo, tras `fsync` de archivo) de entradas de directorio (tras `fsync` del directorio); sincronizar un archivo no hace durable su nombre. El journal conserva la intención; el executor y `recoverRun` reales deciden el roll-forward.
  - **Verificador:** `test/recovery/torn-writes.test.ts`, `test/recovery/lost-renames.test.ts` y `test/recovery/fsync-loss.test.ts`, con semillas fijas, estado durable restaurado tras `SIGKILL`, journal/Zoanthrope reales y `checkInvariants` al final.
  - **Falsación:** si bytes o entradas no sincronizados sobreviven en el estado restaurado, si se omite una llamada al límite de sincronización, o si la recuperación deja contenido/modo incompleto, temporales, claims o acciones abiertas, el caso debe fallar. Un control confirma que un renombre sincronizado sí sobrevive.
- **H11.3** Reproducción: cualquier fallo imprime la semilla. *Criterio:* `SEED=<n>` reproduce el mismo orden de eventos.

*Herramientas:* ninguna nueva. Es trabajo de diseño sobre el código existente. Se decide después de E7, porque cambia el núcleo.

### E12 — Arquitectura: límites, duplicación y principios

**Objetivo:** que la estructura se pueda comprobar, no solo describir.

- **H12.1** Auditoría inicial de módulos: dependencias entre carpetas, ciclos, módulos con varias responsabilidades. *Criterio:* lista de hallazgos con prioridad, en `docs/architecture/`.
- **H12.2** Regla de capas: la interfaz no importa el núcleo directamente, el núcleo no importa la API, la biblioteca no importa la ejecución. *Criterio:* la regla falla `verify` ante una importación prohibida.
- **H12.3** Sin ciclos de importación. *Criterio:* `verify` falla ante un ciclo nuevo; los existentes se listan con fecha para resolverse.
- **H12.4** Detección de duplicación: bloques repetidos por encima de un umbral. *Criterio:* informe en `verify`, sin bloquear hasta acordar el umbral.
- **H12.5** Revisión SOLID guiada por hallazgos, no por preferencia: cada hallazgo indica el principio y el cambio propuesto. *Criterio:* cada cambio tiene su prueba antes de tocar el código.

*Herramientas recomendadas:* **dependency-cruiser** para las reglas de capas y ciclos (H12.2, H12.3). Justificación: expresa las reglas como configuración y falla con el archivo y la línea exactos. Para la duplicación (H12.4) se evalúa una herramienta de detección de copias y pegadas; si no justifica una dependencia, se escribe un script corto.

### E13 — Gobierno de pruebas

**Objetivo:** que la suite siga siendo confiable al crecer.

- **H13.1** Política de fallos intermitentes: una prueba que falla una vez en una ejecución sin cambios se marca, se investiga y se corrige o se aísla con fecha. *Criterio:* la lista de intermitentes existe y está vacía al cierre del plan.
- **H13.2** Presupuesto de tiempo por nivel. *Criterio:* `verify` cabe en el presupuesto acordado; los niveles lentos tienen el suyo.
- **H13.3** Medición del tiempo de `verify` en cada cierre de épica. *Criterio:* cifra registrada en la bitácora.
- **H13.4** Evidencias: cada ejecución de un nivel lento deja su salida en `evidence/` (no versionada) y un resumen en el plan. *Criterio:* el resumen no contiene resultados medidos (regla de resultados privados).
- **H13.5** Revisión de cobertura de contratos: cada contrato de E2 tiene al menos una prueba que lo ejerce. *Criterio:* el informe lista contratos sin prueba y se revisa al cierre.

*Herramientas:* las ya incorporadas.

## 5. Herramientas: resumen

| Herramienta | Épica | Decisión |
|---|---|---|
| fast-check | E3 | Recomendada |
| Stryker | E4 | Recomendada, uso acotado |
| Playwright | E9 | Recomendada |
| dependency-cruiser | E12 | Recomendada |
| bwrap, pasta | E6, E7 | Ya instaladas |
| zod | E2 | Ya es dependencia |
| TLA+ (tla2tools con TLC) | E10 | Opcional, con decisión |
| Quint | E10 | No ahora |
| Dafny, Lean | — | No recomendadas: el coste de demostrar código asíncrono y con E/S supera el riesgo |
| Docker | E6 | No necesario |

Cada dependencia entra con versión exacta y con la historia que la usa. Ninguna se añade "por si acaso".

## 6. Criterio de cierre del plan

- `npm run verify` corre en un árbol limpio con el binario fijado y termina en verde.
- Cada épica tiene su historia de aceptación ejecutada al menos una vez, con evidencia.
- Las épicas E10 y E11 se cierran o se descartan por decisión registrada.
- La lista de intermitentes está vacía.

## 7. Decisiones

- **E10 (TLA+) y E11 (simulación determinista):** aprobadas el 15 oct. Entran en el plan.
- **Pantalla de configuración (H9.5):** fuera de este ciclo. P17.9 queda con su parte de CLI y API; la pantalla se decide más adelante.
- **Umbral de mutación (H4.3):** desde el primer ciclo, para los módulos de seguridad.

## 8. Estado y pendientes (15 oct 2026)

Cerradas: E1, E2, E3, E4, E5, E8, E9, E10, E12, E13. En curso: E6, E7, E11 (cada una con historias pendientes abajo). E9 cierra sin H9.5, que quedó fuera de este ciclo por decisión.

### Hecho en esta pasada

- **E4:** los gates de mutación de los módulos fijados y la cobertura pendiente del ejecutor y el journal pasaron sus suelos. Los informes detallados se conservan en `evidence/mutation/` (ignorado).
- **E7:** H7.2 (tarea completa en sandbox con compuerta y cambio dentro del alcance declarado), H7.3 tal como está escrita (tarea que el agente no completa: FALLA, repositorio intacto) y H7.4 (conector de configuración de punta a punta, rechazo sin escritura parcial).
- **E8:** H8.2 (oráculos compuestos), H8.3 (entradas generadas que el agente no ve), H8.4 (mutantes del cambio; un oráculo débil se rechaza).
- **E9:** H9.4 (biblioteca: el motivo mostrado es el de la API). Defecto de desmontaje al salir de `chat` corregido en el código (no en la prueba). H9.3 (workflow creado en el servidor y visible en la lista), H9.6 (accesibilidad WCAG 2.x A/AA en las doce vistas, en tema claro y oscuro).
- **E11:** H11.2 (pérdida simulada de fsync de archivo/directorio y recuperación desde snapshot durable) y H11.3 en corrida completa (el journal leía el reloj real; ahora pasa por el entorno).
- **E13:** dos intermitentes con límite revisado y causa probable escrita (no reproducidas).

### E6 en curso

- **H6.1–H6.2**: falta cubrir los ataques y la matriz explícita de centinelas indicados en los criterios.
- **H6.3**: verificador local opt-in definido en `test/live/p159-network-proxy.test.ts`; usa la alternativa B autorizada y verificada en P15.9.

### Bloqueado por una decisión del operador o del usuario

- **H7.5** ejecución `live`: necesita credenciales reales, que esta sesión no lee. `test:live` queda opcional.
- **H12.4**: informe informativo de duplicación de 12 líneas, sin umbral bloqueante acordado. El script y `verify` no fijan una cuota; los duplicados se guardan en evidencia local.
- **H12.5** aplicado con la decisión del operador (aplicar 2 a 4). Hallazgos 1, 2, 3 y 5 aplicados (commits 1ce20eb, 8cf489a, 4381443). El 4 se aplicó en lo que el SDK cubre: `tools/call` y -32002 se mantienen por M3 y por la imposibilidad de expresar -32002 en el SDK, y así queda documentado.
- **E10** cola FIFO del bloqueo del journal: el modelo muestra inanición con equidad débil; decidir si se implementa la cola o se acepta y registra.

### Decisiones que la regla de `verify` no cubre

- `npm run verify` no ejecuta `test:ui` ni `test:mutation` (tiempo). Ambos se ejecutan a mano antes de cerrar una épica que los toca.
