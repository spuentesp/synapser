# Plan 16 — Spike, validación, curación y optimización

Estado: **P16.2 hecho e incorporado a `main`** (`73991d1`; decisión 1 aprobada el 14 oct 2026). P16.3 hecho para agentes y skills de biblioteca; el usuario aprobó el 15 oct migrar proveedores y workflows también, como P16.6. El resto, propuesto. Cada tarea se reclama en el [seguimiento](14-seguimiento.md) antes de tocar código. Orden: P16.2 → P16.3 → P16.4 → P16.5. Este plan no instala dependencias: cada una necesita la aprobación del usuario antes de entrar en `package.json`.

El usuario pidió llevar a plan cuatro líneas: un spike del SDK oficial de MCP, validación con zod, curación de skills y optimización. Salieron de revisar qué código propio es difícil de construir bien y qué paquetes existen para ello. Rige la regla de baja superficie (ronda 3 del plan 14): cada dependencia nueva la justifica el plan que la añade, con versión exacta.

## 1. Qué motiva cada línea

- **Protocolo MCP.** `src/mcp/server.ts` (399 líneas) implementa transporte, despacho y herramientas. Habla la revisión `2024-11-05` (línea 33). Lo que hay que mantener al día es el protocolo, no las herramientas.
- **Validación.** Las reglas de forma de la biblioteca son tablas (`src/library/validate.ts`: `EXTENDING_FIELDS`, `NATIVE_FIELDS`, `NATIVE_REQUIRED`, `FILE_ONLY_FIELDS`) mezcladas con reglas semánticas (IC1 a IC4, D3, referencias). Los borradores de workflow también entran por la API: el diseñador los guarda con `PUT` (Q3.1).
- **Curación.** La biblioteca versiona cada documento por digest y registra qué skill recibió cada agente en cada corrida (Q5.4). No hay admisión según el comportamiento de una versión, ni reversión con evidencia.
- **Optimización.** No existe. Hay que elegir una herramienta sin meterla en la ruta de ejecución.

No se toca: `undici` (aprobado en P15.5); la canonicalización de digests (`src/digest/canonical.ts`), porque cambiarla cambiaría todos los digests; el cliente de modelo propio (`src/model/openai-compatible-provider.ts`), que ya tiene presupuesto, redacción de claves y registro; y el exportador de LangSmith (`src/audit/langsmith.ts`), mientras su vista siga siendo opcional (D5 del plan 14).

## 2. Principios

1. **Baja superficie.** Cada dependencia aparece en la sección 7 con versión exacta, licencia, dependencias directas y el plan que la añade. Lo que no aparece ahí no entra.
2. **La optimización no está en la ruta de ejecución.** Un optimizador escribe texto candidato, y ese texto entra en la biblioteca solo por la puerta de admisión de P16.4.
3. **Forma con librería, reglas con código.** zod valida la forma. Las reglas que protegen la frontera de confianza (IC1, IC2, D3, referencias) siguen en el código, con sus pruebas actuales.
4. **Resultados medidos fuera del repositorio.** Los resultados de los prototipos van a `evidence/` (ignorado). El seguimiento guarda solo la decisión y su prueba.

Etiquetas de invariantes: X (spike), V (validación), CU (curación) y O (optimización). M y C ya las usa el plan 13 para el modelo de confianza de MCP y los workflows.

## 3. P16.2 — Spike: servidor MCP con el SDK oficial

**Hechos del registro (consultados el 14 oct 2026).** `@modelcontextprotocol/server` tiene 2.3.1 como `latest`, publicada el 5 oct 2026, con licencia Apache-2.0. Sus dependencias directas son `zod` ^4.2.0 y `@modelcontextprotocol/core` 2.3.1, y exige Node ≥20. Su README en npm menciona el transporte stdio y la revisión `2026-07-28`. Las guías de terceros se contradicen sobre si la v2 es beta o estable, así que no se usan para eso.

**Lo que no depende de la especificación.** Una guía de terceros dice que la revisión `2026-07-28` retira el handshake `initialize`. El spike no lo usa como premisa: los clientes de hoy negocian la era 2025, que el SDK sirve con `initialize`, y la era `2026-07-28` (`server/discover`) queda fuera de alcance (ver el resultado).

**Alcance.** Sustituir el transporte y el despacho de `src/mcp/server.ts`. La lógica de herramientas (gestor, catálogo, compuertas de efectos, códigos de aprobación) no cambia.

**Preguntas que responde, en este orden.**
1. ¿Qué revisiones negocia el servidor del SDK, y cuáles envían los clientes MCP instalados en el host? El spike enumera esos clientes antes de probarlos.
2. ¿Las pruebas de `test/mcp/` pasan sin cambiar sus aserciones de herramientas?
3. ¿Qué entra en el árbol de producción? Se lista completo con `npm ls --omit=dev`.

**Invariantes y verificación.**
- **X1 Catálogo idéntico.** Nombres, descripciones y esquemas de las herramientas coinciden con una instantánea del `tools/list` tomada antes del cambio. *Falsación:* quitar una herramienta o cambiar un esquema; la prueba falla.
- **X2 Regresión de transporte.** `test/mcp/mcp.test.ts` y `test/mcp/stdio-e2e.test.ts` pasan sin cambiar aserciones de herramientas.
- **X3 Clientes reales.** Cada cliente MCP instalado en el host lista las herramientas y llama a una. Es una prueba manual; el nombre y la versión del cliente se anotan en el seguimiento.
- **X4 Dependencias.** El árbol de producción añade solo `@modelcontextprotocol/*` y `zod`. Cualquier otro paquete vuelve a decisión del usuario.

**Criterio de salida.**
- **Adoptar** si X1 a X4 se cumplen y los clientes de X3 conectan con la revisión que negocian.
- **No adoptar** si un cliente de X3 necesita un handshake que el SDK no ofrece. Se mantiene el servidor escrito a mano, se anota el motivo y la tarea se cierra con esa decisión. La línea 1.x del SDK tiene 17 dependencias directas, así que no es una alternativa barata.
- **Acotado.** El spike no cambia nada fuera de `src/mcp/server.ts` y sus pruebas.

**Decisión previa.** Añadir `@modelcontextprotocol/server` requiere la aprobación del usuario, con versión exacta, como `undici` (ronda 3 del plan 14).

### Resultado del spike (14 oct 2026)

Rama `spike/mcp-sdk`: `b53f601` (caracterización y X1, contra el servidor de `main`) y `6a6d11d` (el SDK como capa de protocolo). Suite completa: 601 pruebas, 592 pasan, 0 fallan, 9 omitidas. `npm run typecheck` en verde. El árbol de producción añade `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/core` 2.3.1 y `zod` 4.6.7 (deduplicada con la del SDK).

**Lo que lleva el SDK:** la negociación de `initialize`, `ping`, las notificaciones, `tools/list` y los errores de método.

**Lo que sigue escrito a mano:**
- El encuadre de líneas sobre stdio. El transporte stdio del SDK cierra la sesión ante una línea que no es JSON; el nuestro responde `-32700` y sigue.
- `tools/call`. El SDK valida sus parámetros antes de nuestro código, y así una llamada sin nombre no llegaría al ledger (M3). Tampoco puede expresar el `-32002` de una sesión sin inicializar.
- Las herramientas, los roles y el registro. El nombre del cliente sale del `initialize`; el rol nunca.

**Diferencias deliberadas,** cada una fijada en `test/mcp/characterization.test.ts`:
1. La negociación responde la revisión que el cliente pide, si el SDK la conoce (`2025-06-18` → `2025-06-18`). Una revisión desconocida recibe `2025-11-25`. Antes se respondía `2024-11-05` siempre.
2. Los métodos desconocidos reciben el texto `Method not found` del SDK, en lugar de `method not found: <nombre>`. El código `-32601` no cambia.
3. Una petición con `id` nulo recibe `-32600`. Antes recibía un resultado.
4. Un mensaje sin `id` que no es notificación no recibe respuesta. Antes recibía un resultado con `id` nulo.
5. Una notificación con `id` no recibe respuesta. Antes, solo las dos que nombra el servidor (`notifications/initialized` y `notifications/cancelled`) no la recibían; las demás recibían `-32601`.
6. Los parámetros de `ping` y `tools/list` no se leen, como antes: un `cursor` que no sea texto no impide el listado.
7. Un `initialize` sin revisión, sin `clientInfo.version` o con capacidades que el servidor no lee se responde como antes. Las capacidades del cliente no se pasan al SDK.
8. En llamadas en proceso (`handle`), `ping` e `initialize` se responden aunque haya una llamada de herramienta retenida. Por stdio, la cadena de líneas sigue reteniéndolos, como antes.

**Guarda.** Una petición que el SDK no responda en `answerTimeoutMs` (10 s por defecto) recibe `-32603`, en lugar de congelar la sesión. Ninguna de las entradas probadas la activa. Su única verificación es una falsificación que quitó el filtro de `id` y convirtió el cuelgue en esa respuesta.

**Era moderna, fuera de alcance.** `server/discover` responde `-32601`, e `initialize` con `2026-07-28` recibe `2025-11-25`. Para servirla hay que rehacer el estado por sesión: la clave de propietario y el contador de llamadas viven en una instancia por conexión. El SDK crea instancias por conexión y era (en HTTP, por petición). Por eso la actualización de revisión no es un beneficio inmediato de adoptar el SDK.

**Clientes reales (X3).**
- Claude Code 2.1.299: conectado al arrancar; `workflow_list` respondió sin error.
- codex-cli 0.160.1: llamada completada. Para esa invocación se habilitó solo esa herramienta y se aprobó: el bloqueo inicial lo puso la política de aprobación del cliente, no el servidor.
- mimo 0.1.15: `mimo mcp list` lo ve conectado. Por ACP (`mimo acp`, agente OpenCode 0.1.15), la sesión con el servidor de Synapser se acepta, pero la llamada no llegó a ocurrir: el proveedor respondió `402 Insufficient account balance`. Sin esa llamada no hay prueba de la herramienta; hace falta saldo y repetir el chequeo.
- kimi 2.1.1: su CLI no tiene subcomando ni flag MCP, pero su runtime carga servidores MCP desde `$KIMI_CODE_HOME/mcp.json`, desde `.mcp.json` del proyecto (con workspace de confianza) y desde `mcpServers` de ACP. Verificado por ACP: `session/new` con el servidor de Synapser, una llamada a `workflow_list` con permiso concedido una vez y respuesta `{"workflows":[]}`. La sesión queda en `~/.kimi-code/sessions/`. Headless con MCP no verificado: sin credenciales la corrida se para antes de arrancar MCP.

El detalle está en `evidence/p16-2-clients/` (no versionado).

**Criterios.** X1 cumplido: la instantánea de `tools/list` por rol coincide, y se falsó quitando una herramienta y cambiando una descripción. X2 cumplido: `mcp.test.ts` y `stdio-e2e.test.ts` pasan sin cambiar sus líneas. X3 cumplido con Claude Code, codex y kimi (por ACP); mimo queda pendiente por saldo insuficiente de su proveedor. X4 cumplido: tres paquetes en el árbol de producción.

**Lo que la adopción compra:** la negociación de las revisiones 2025 y los tipos del protocolo, mantenidos por el SDK. No compra la revisión `2026-07-28`, y el encuadre y `tools/call` siguen siendo nuestros.

**Decisión 1, aprobada (14 oct).** Incorporada a `main` en `73991d1`, con esta lista de diferencias. El beneficio es la negociación de revisiones 2025, no la era nueva.

## 4. P16.3 — Validación con zod

**Alcance (cortado de la propuesta; decisión del usuario del 15 oct).** Esta entrega cubrió los agentes y las skills de biblioteca, los dos tipos que solo existen en la biblioteca. Proveedores y borradores de workflow se migran en P16.6, ya aprobado:
- Los proveedores de biblioteca. Usan `validateProviderConfig`, que también valida el archivo del operador; migrarlo cambiaría la configuración, que este plan excluye.
- Los borradores de workflow. Su validador mezcla forma con referencias a ids de comandos y de perfiles, y a rutas del workspace. Necesita su propio corpus, y no es una cuestión de dos fuentes de verdad.
- Las plantillas siguen sin esquema (decisión abierta de Q3.2).

**Método.**
- `src/library/schema.ts`: un esquema zod por variante de agente (la que extiende un perfil y la nativa) y uno para skills. zod decide el tipo de cada campo, las claves obligatorias y las claves desconocidas (`z.strictObject`).
- `validate.ts` deriva `EXTENDING_FIELDS`, `NATIVE_FIELDS` y `NATIVE_REQUIRED` de esos esquemas, en lugar de tenerlos escritos a mano. La tabla de textos de los motivos está tipada sobre las claves del esquema: un campo nuevo sin texto no compila.
- Las reglas semánticas siguen en código y solo corren cuando la forma es válida: IC1 (`enabled` solo si el archivo activa el perfil base; pool rechazado), la existencia del perfil base, del proveedor y del modelo, `validateProfile`, IC2 (lista de claves), D3 (destinos literales) y las referencias de Q5.2.

**Dependencia.** `zod` 4.6.7, exacto, declarado como dependencia directa (aprobado el 14 oct junto con este paso). Es la versión que ya trae `@modelcontextprotocol/server`, así que el árbol de producción no añade paquetes. Revertir el paso es `git revert 0086fde`: vuelve a las formas escritas a mano, y el golden queda como regresión. Quitar solo la línea de `package.json` no sirve: `schema.ts` importa `zod`, que quedaría sin declarar.

**Invariantes y verificación.**
- **V1 Equivalencia.** `test/library/validation-golden.test.ts`: 204 casos del corpus `test/library/validation-corpus.ts`, con los motivos que daba `main` antes del cambio (golden de `8d3a0db`, generado desde `73991d1`) y el perfil resuelto de cada agente válido. Los motivos se comparan ordenados, porque el orden no es un contrato: cada problema se informa. Los textos no cambian. Regenerar el golden es un cambio deliberado, como el snapshot X1.
- **V2 Reglas intactas.** Las pruebas de IC1 a IC4 (`test/library/agent-rules.test.ts`, `read.test.ts`, `references.test.ts`, `resolve.test.ts`), de D3 y de la API de biblioteca pasan sin cambiar sus aserciones.
- **V3 Forma estricta.** Un campo desconocido se rechaza y se nombra; un campo ausente o de tipo incorrecto se rechaza con su nombre.
- **V4 Nombres de prototipo.** Un documento leído de JSON puede traer una clave propia `__proto__`, `constructor` o `toString`, y un proveedor o una base con esos nombres. Se rechazan con su motivo, y nunca se leen de `Object.prototype`. Una sonda comparó el validador anterior con el nuevo sobre estos casos: sin diferencias, salvo los proveedores con nombre de prototipo, que lanzaban `TypeError` y ahora se rechazan (corregido en el mismo paso; pruebas en `test/library/agent-rules.test.ts`).
- **Falsación.** Seis cambios al esquema, cada uno hace fallar el golden: límite de temperatura `lte(2)`→`lt(2)` (2 casos), mínimo de timeout `gt(0)`→`gte(0)` (2), etiquetas de skill sin tipo (1), campo obligatorio hecho opcional (1), `strictObject`→`object` (23), tamaño de skill menos un byte (4). Después, el esquema original, restaurado y verificado con `cmp`.

### P16.6 — Proveedores y borradores de workflow

**Alcance.** zod gobierna las formas de proveedor (incluido el archivo del operador, que comparte `validateProviderConfig`) y los borradores de workflow. No se cambia la política de proveedores: slug, protocolo por contexto, destinos, allowlist de claves, precios en pareja y modelos duplicados siguen como reglas semánticas. En workflows siguen en código las referencias a comandos/perfiles, rutas del workspace, unicidad de condiciones, evidencia secundaria y la condición obligatoria no exenta. Claves desconocidas se siguen ignorando, sin reescribir ni quitar datos del archivo.

**Normalización que no cambia.** `goals` y `nonGoals` ausentes pasan a `[]`; una cadena de `nonGoals` pasa a `{statement}`; `required` ausente pasa a `true`; `citations.min` ausente pasa a `1`; listas `diff` vacías se omiten. Un paso de guardado conserva su validación completa y atómica.

**Invariantes y verificación.** V1: corpus dorado de proveedores y workflows generado antes del cambio, comparando veredicto, problemas en orden y objeto normalizado. V2: las pruebas existentes de config del operador, hot reload, biblioteca, workflow, referencias, rutas e invariantes siguen pasando. V3: sin claves desconocidas nuevas rechazadas ni dependencias de ejecución añadidas. Goldens: `test/model/provider-validation-golden.test.ts` y `test/workflow/validation-golden.test.ts`; regeneración deliberada con `test/regen-p166-validation-golden.ts`.

**Falsación.** Cambiar `providerBaseUrlShape` de string a número debe diferir del golden de proveedor; cambiar la forma de `required` o de las cadenas de workflow debe diferir del golden de workflow. Un cambio intencional de contrato actualiza el corpus y explica la nueva regla; no se regenera para silenciar una diferencia accidental.

## 5. P16.4 — Curación de skills

**Idea.** Una versión de skill entra en uso solo después de pasar sus casos de regresión.

**Definiciones.**
- **Caso.** Una tarea, una comprobación de la salida o de la traza, y una división: `dev` (visible para el optimizador) o `holdout` (retenido, nunca visible para el optimizador).
- **Conjunto.** Los casos de una skill. Dónde viven y cómo se admiten son decisiones del usuario (sección 8).

**Admisión.** Una versión nueva de skill pasa todos sus casos `holdout` antes de que las corridas la usen. Cada caso declara sus repeticiones `k` y los aciertos que exige (por defecto, todos). Un fallo devuelve el id del caso, con el mismo formato de error que el 409 de Q5.2.

**Rollback.** Restaura una versión admitida anterior por su digest, y queda como evento con actor y motivo. No vuelve a evaluar. Las corridas siguientes registran el digest restaurado.

**Qué se mide por corrida (corrección).** Con D6, el archivo asigna las skills por id (`src/library/resolve.ts:83–107`). El agente no elige nada, así que no hay fallos de selección que medir. La rúbrica separa tres cosas:
1. **Asignación:** qué skill recibió la corrida, con id, digest y mecanismo (registrado desde Q5.4).
2. **Uso:** si la traza muestra que la skill se aplicó. El mecanismo `prompt-prepend` no deja huella, así que el uso solo se mide en los casos que definen su propia comprobación.
3. **Resultado:** si el caso pasó.

Un caso sin comprobación de uso mide solo resultado. Eso se declara en el caso, no se supone.

**Invariantes y verificación.**
- **CU1 Admisión.** Ninguna versión con un caso `holdout` fallido queda en la biblioteca. *Verificador:* un intento de guardarla devuelve 409 con el id del caso; con todos los casos en verde, guarda. *Falsación:* admitir sin comprobar; la prueba falla.
- **CU2 Rollback por digest.** Tras restaurar, la corrida siguiente registra el digest restaurado, y el evento tiene actor y motivo. *Falsación:* un rollback que solo cambia una etiqueta; la prueba falla.
- **CU3 Asignación visible.** La fila de cada corrida conserva id, digest y mecanismo de cada skill (prueba existente de Q5.4).

**Dependencia.** P16.3, si el tipo nuevo de documento (`cases`) se valida con zod. Si no, se usan las tablas actuales.

## 6. P16.5 — Optimización offline

**Prerrequisito.** P16.4: casos `dev` y `holdout`, y la puerta de admisión. Ningún optimizador se conecta antes.

**Qué se optimiza.** Textos (instrucciones de agente y skills), no programas. Por eso DSPy queda fuera: su unidad son los módulos y las firmas, y tiene 16 dependencias directas.

**Evaluador.** `dev` guía la búsqueda; `holdout` decide. Cada evaluación es una llamada real a un modelo, con costo.

**Presupuesto.** Tope de evaluaciones, siempre. Tope de costo en USD cuando la tarifa viene del archivo (D4). Sin tope, el optimizador no arranca. Un costo sin tarifa se muestra como desconocido: alerta, no bloqueo (D3 del plan 10).

**Prototipos.** Dos, con criterios fijados antes de correrlos:

| | `gepa` 0.1.4 (PyPI) | `@ax-llm/ax` 25.3.2 (npm) |
|---|---|---|
| Lenguaje | Python ≥3.10, herramienta aparte | TypeScript, dentro del proyecto |
| Dependencias requeridas | ninguna, según los metadatos | 1: `@opentelemetry/api` ^1.9.0 |
| Licencia | MIT | Apache-2.0 |
| Entrada | texto semilla, conjuntos, modelo de tarea y modelo de reflexión | ejemplo de GEPA con dos clientes de modelo |
| Madurez declarada | sin dato en el README | el README no declara la de sus optimizadores |

Criterios:
1. **Fuera de la ruta del orquestador.** Corre como proceso del operador y escribe candidatos. Los dos cumplen; `gepa` exige un runtime Python nuevo.
2. **Superficie añadida.** Cuenta el runtime y los paquetes. Si gana `gepa`, Python como dependencia del operador es decisión del usuario.
3. **Salida.** Texto que se convierte en un documento de skill sin pasos manuales.
4. **Presupuesto.** El tope de evaluaciones se respeta (prueba).
5. **Evidencia.** Los resultados del prototipo van a `evidence/`. El seguimiento guarda la decisión.

**Invariantes y verificación.**
- **O1 Única puerta.** Un candidato solo llega a la biblioteca por CU1. *Verificador:* un candidato no admitido no aparece en la instantánea de ninguna corrida. *Falsación:* escribir el candidato directamente; la prueba falla.
- **O2 Tope.** Sin tope, no arranca. Con tope, se detiene al alcanzarlo, y el recuento de llamadas coincide con el tope. *Falsación:* ignorar el tope; la prueba falla.
- **O3 Retención.** Un candidato que mejora `dev` y empeora `holdout` se rechaza. *Verificador:* un modelo de prueba construido para sobreajustar. *Falsación:* decidir con `dev`; la prueba falla.

## 7. Dependencias: registro

Datos de los registros de npm y PyPI, consultados el 14 oct 2026. La fecha es la de la versión indicada.

| Paquete | Versión | Publicado | Licencia | Dependencias directas | Plan | Estado |
|---|---|---|---|---|---|---|
| `undici` | 8.11.2 | — | MIT | — | P15.5 | aprobada |
| `@modelcontextprotocol/server` | 2.3.1 | 2026-10-05 | Apache-2.0 | `zod` ^4.2.0, `core` 2.3.1 | P16.2 | propuesta; requiere aprobación |
| `@modelcontextprotocol/core` | 2.3.1 | 2026-10-05 | Apache-2.0 | `zod` ^4.2.0 | P16.2, transitiva | — |
| `zod` | 4.6.7 | 2026-10-12 | MIT | ninguna | P16.3 | propuesta; requiere aprobación |
| `@ax-llm/ax` | 25.3.2 | 2026-10-13 | Apache-2.0 | `@opentelemetry/api` ^1.9.0 | P16.5 | candidata (prototipo) |
| `gepa` (PyPI) | 0.1.4 | 2026-07-15 | MIT | ninguna requerida | P16.5 | candidata (prototipo, Python) |
| `@modelcontextprotocol/sdk` | 1.32.1 | 2026-10-05 | MIT | 17 | — | descartada: línea 1.x |
| `ajv` | 8.20.0 | 2026-04-24 | MIT | 4 | — | descartada: zod cubre la forma |
| `openai` | 7.33.0 | 2026-10-14 | Apache-2.0 | ninguna | — | descartada: el proveedor propio cubre el caso |
| `canonicalize` | 5.1.0 | 2026-09-18 | Apache-2.0 | ninguna | — | descartada: cambiaría todos los digests |
| `langsmith` | 0.10.13 | 2026-10-13 | MIT | 1 | — | descartada por ahora: exportador propio |
| `langfuse` | 3.39.2 | 2026-09-15 | MIT | 1 | — | descartada por ahora: mismo motivo |
| `dspy` (PyPI) | 3.4.1 | 2026-10-12 | MIT | 16 | — | descartada como núcleo |
| `promptfoo` | 0.124.1 | 2026-10-08 | MIT | 76 | — | descartada |
| `inspect-ai` (PyPI) | 0.3.280 | 2026-10-14 | MIT | 41 | — | descartada |
| `deepeval` (PyPI) | 4.2.8 | 2026-10-02 | Apache-2.0 | 29 | — | descartada |
| `textgrad` (PyPI) | 0.1.8 | 2025-03-26 | MIT | 12 | — | descartada: sin versiones desde marzo de 2025 |

**Cuándo reabrir una descartada.**
- DSPy: si el sistema pasa a programas de varios módulos.
- promptfoo, inspect-ai o deepeval: si la evaluación necesita más que los casos de la biblioteca (comparaciones entre modelos, paneles).
- LangSmith o Langfuse: si D5 del plan 14 hace de la vista algo obligatorio.
- canonicalize: solo con una migración de digests planificada.
- ajv: si zod no cubre un caso real.

## 8. Decisiones que necesitan tu aprobación

| # | Decisión | Recomendación | Por qué requiere aprobación |
|---|---|---|---|
| 1 | Añadir `@modelcontextprotocol/server` en versión exacta, si P16.2 cumple | aprobada el 14 oct; incorporada en `73991d1` | es dependencia nueva |
| 2 | zod en versión exacta, dentro de `^4.2.0` | aprobada con P16.3 (14 oct), en 4.6.7, la que ya trae el SDK | es dependencia directa nueva; el árbol de producción no cambia |
| 3 | Dónde viven los casos de regresión | fixtures versionados bajo `test/`, fuera de la biblioteca de runtime | decisión del usuario: fixtures bajo `test/` |
| 4 | Cómo se admite una versión: (a) el propio guardado exige los casos, o (b) un paso de admisión aparte que crea un candidato y lo promueve | (b): cada caso llama a un modelo; una escritura HTTP no debería esperar eso ni depender de un proveedor | decisión del usuario: admisión manual tras holdout; ver alcance candidate→promote en P16.4 |
| 5 | Umbral de admisión: todas las repeticiones, o una proporción declarada | todas, por defecto | decisión del usuario: deben pasar todas las repeticiones |
| 6 | Python como dependencia del operador, solo si gana `gepa` | decidir con el prototipo delante | añade un runtime |
| 7 | Rollback: vuelve a evaluar, o solo registra | solo registra (CU2) | cambia la garantía que se ofrece |

## 9. Lo que este plan no hace

- No cambia el modelo de amenazas del plan 15 ni la política de destinos.
- No promete mejoras de calidad. Promete que cada cambio de skill tenga una prueba que se puede repetir.
- No actualiza el docx de diseño (sección 40) ni toca C.3.

## Lecturas

Resúmenes de preprints; no se leyeron los artículos completos.
- SkillsVote, [arXiv 2605.18401](https://arxiv.org/abs/2605.18401): las actualizaciones solo ocurren cuando una corrida tiene éxito y deja hallazgos reutilizables («evidence-gated updates»). El resumen no trae cifras.
- Survey de skills dinámicas, [arXiv 2607.10113](https://arxiv.org/abs/2607.10113): ocho etapas, desde reunir evidencia hasta la gobernanza con rollback. Señala que la admisión y la reparación pesan mucho.
- SkillCoach, [arXiv 2607.01874](https://arxiv.org/abs/2607.01874): separa el juicio del proceso del resultado que da el verificador externo. El resumen no trae cifras.
- GEPA, [arXiv 2507.19457](https://arxiv.org/abs/2507.19457): reflexión en lenguaje natural sobre las corridas de prueba. Las cifras de los autores no se usan en este plan.
