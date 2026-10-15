# Arquitectura: inventario, reglas y hallazgos (plan 18, E12)

Fecha de la medición: 15 oct 2026. Las cifras salen de un script de Node sobre `src/` (no incluye `test/`).

## 1. Inventario por carpeta (H12.1)

| Carpeta | Archivos | Líneas | Responsabilidad |
|---|---:|---:|---|
| agents | 14 | 1907 | adaptadores de CLI, runner, perfiles, inyección |
| audit | 6 | 1301 | consultas sobre el ledger, cadena de hashes, costos |
| workflow | 5 | 1215 | modelo, validación y gestor de workflows |
| journal | 5 | 1192 | SQLite: esquema, transiciones, eventos |
| model | 9 | 1074 | proveedores, roles, cliente OpenAI-compatible |
| mission | 6 | 1027 | ejecución de misiones |
| executor | 4 | 1025 | ejecución de acciones con aislamiento |
| orchestration | 8 | 1003 | catálogo, enrutador, compuertas |
| zoo | 6 | 921 | integración con Zoanthrope |
| agent | 4 | 859 | bucle nativo de agente |
| library | 4 | 669 | biblioteca del operador y validación |
| advisor | 3 | 655 | asesor |
| api | 1 | 655 | servidor HTTP y rutas |
| effects | 5 | 638 | efectos y su aprobación |
| mcp | 2 | 583 | servidor MCP de tareas y conector de configuración |
| config | 2 | 479 | carga del archivo del operador y escritura en caliente |
| cli | 3 | 452 | comandos |
| research | 6 | 397 | investigación web |
| digest | 4 | 309 | direccionamiento por contenido |
| validation | 2 | 244 | validación de cambios |
| chat | 1 | 209 | chat |
| bench | 1 | 190 | banco de pruebas de agentes |

Los archivos más grandes: `journal/journal.ts` (867), `executor/executor.ts` (662), `api/server.ts` (654), `agents/native/loop.ts` (581), `mission/runner.ts` (521).

## 2. Reglas comprobadas (H12.2, H12.3)

`npm run arch:check` (dependency-cruiser, `.dependency-cruiser.cjs`) está en `verify`. Reglas:

- El núcleo no importa la API (`src/api`).
- La biblioteca no importa la ejecución (runner, adaptadores, executor, motor de workflows).
- La interfaz web no importa `src/`.
- `src/` no importa `test/`.
- Sin ciclos de importación, con dos excepciones documentadas y fechadas el 15 oct 2026: `model/budget.ts` ↔ `model/types.ts`, y `web/.../workflow-designer.tsx` ↔ `workflow-templates.ts`.

El estado actual: cero violaciones.

## 3. Duplicación (H12.4)

`npm run` con `scripts/duplication-report.ts`: bloques de 12 líneas normalizadas repetidos en `src/`: **0**. Con ventana de 4 líneas hay 85 bloques repetidos; son patrones cortos, no duplicación de lógica. Sin umbral todavía: se fijará con estas cifras.

## 4. Hallazgos (H12.5)

Cada hallazgo indica el principio y el cambio propuesto. Ninguno se aplica sin su prueba antes. Estado: aplicados los hallazgos 1 y 5; los hallazgos 2, 3 y 4 quedan pendientes, cada uno como refactor propio con su prueba previa.

1. **Dos carpetas con nombres casi iguales, `agent/` (bucle nativo) y `agents/` (adaptadores y runner).** Principio: nombres que describen una sola responsabilidad. Aplicado: el bucle está en `agents/native/` (`loop`, `prompts`, `schema`, `tools`).
2. **`api/server.ts` concentra enrutado, validación de cuerpos y autorización en un solo archivo (654 líneas).** Principio: responsabilidad única. Cambio propuesto: una función de rutas por recurso (`config`, `library`, `workflows`), con la autorización en un solo sitio.
3. **`journal/journal.ts` mezcla esquema, escritura de filas y lecturas (867 líneas).** Principio: separación de lectura y escritura. Cambio propuesto: un módulo de lecturas que use solo la conexión.
4. **`mcp/server.ts` mantiene su propio despacho JSON-RPC, aunque el SDK ya lo hace para el protocolo (P16.2).** Principio: no reinventar. Cambio propuesto: reducir el servidor a las herramientas, delegando el protocolo en el SDK, con las pruebas de caracterización de P16.2 como red.
5. **`config/write.ts` y `config/load.ts` comparten la noción de "validar el archivo".** Principio: DRY. Cambio propuesto: un único validador del archivo completo, que usan la carga y la escritura. Aplicado: la escritura valida el archivo candidato con el cargador, igual que la carga.
6. **Inversión de dependencias en `api/server.ts`:** el servidor recibe el control como objeto con funciones, lo que ya permite probarlo sin la CLI. Principio: depender de abstracciones. Se conserva; es un buen patrón.

## 5. Límites de esta medición

- No se midió el acoplamiento por número de importaciones entrantes y salientes por módulo.
- No se revisó cada módulo contra cada principio SOLID; la lista son los hallazgos que las cifras y la lectura de los archivos más grandes muestran.
