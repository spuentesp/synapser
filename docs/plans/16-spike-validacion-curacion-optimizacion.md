# Plan 16 — Spike, validación, curación y optimización

Estado: **propuesto** (14 oct 2026). Ninguna tarea está empezada. Cada tarea se reclama en el [seguimiento](14-seguimiento.md) antes de tocar código. Orden: P16.2 → P16.3 → P16.4 → P16.5. Este plan no instala dependencias: cada una necesita la aprobación del usuario antes de entrar en `package.json`.

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

**Lo que no está verificado.** Que la revisión `2026-07-28` elimine el handshake `initialize` y la cabecera de sesión. Solo lo afirma una guía de terceros. Se verifica en la especificación oficial antes de decidir.

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

## 4. P16.3 — Validación con zod

**Alcance.** Los documentos de biblioteca y los borradores de workflow, porque ambos entran por la API y cruzan la frontera de confianza. La configuración del archivo queda fuera: la escribe el operador y no pasa por la API.

**Método.**
- Un esquema zod por tipo de documento: campos, tipos, obligatorios y rechazo de campos desconocidos. Cada rechazo nombra el campo.
- Las tablas de `validate.ts` se derivan del esquema o se contrastan con él. No hay dos fuentes de verdad.
- Las reglas semánticas siguen en código: IC1 (`enabled` solo si el archivo activa el perfil base; pool rechazado), IC2 (lista de claves), D3 (destinos literales) y las referencias de Q5.2.

**Dependencia.** zod es dependencia directa del proyecto, con versión exacta dentro de `^4.2.0`, para que npm la deduplique con la copia del SDK. Si P16.2 no se adopta, zod entra por sí solo y necesita su propia aprobación.

**Invariantes y verificación.**
- **V1 Equivalencia.** Sobre un corpus (los documentos de `test/library/agent-rules.test.ts`, `test/library/read.test.ts`, `test/api/library.test.ts` y los borradores de `test/api/designer.test.ts`), el veredicto (aceptado o rechazado) y el campo que motiva el rechazo son los mismos antes y después. El texto del motivo puede cambiar, y cada cambio se anota.
- **V2 Reglas intactas.** Las pruebas de IC1 a IC4, de D3 y de referencias no cambian sus aserciones.
- **V3 Forma estricta.** Un campo desconocido o de tipo incorrecto se rechaza y se nombra.
- *Falsación:* quitar el esquema de un campo. V1 deja pasar un documento que antes se rechazaba, y la prueba falla.

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
| 1 | Añadir `@modelcontextprotocol/server` en versión exacta, si P16.2 cumple | sí, si X3 pasa | es dependencia nueva |
| 2 | zod en versión exacta, dentro de `^4.2.0` | sí, en P16.3 | es dependencia nueva, aunque el SDK la trae |
| 3 | Dónde viven los casos de regresión | un tipo de documento `cases` en la biblioteca, enlazado por el id de la skill | cambia el modelo de la biblioteca |
| 4 | Cómo se admite una versión: (a) el propio guardado exige los casos, o (b) un paso de admisión aparte que crea un candidato y lo promueve | (b): cada caso llama a un modelo; una escritura HTTP no debería esperar eso ni depender de un proveedor | cambia la máquina de estados de la biblioteca |
| 5 | Umbral de admisión: todas las repeticiones, o una proporción declarada | todas, por defecto | define qué cuenta como fallo |
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
