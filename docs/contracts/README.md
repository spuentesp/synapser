# Contratos de Synapser

Cada contrato tiene un identificador `C-<área>-<n>`, una fuente en el código y su estado de prueba.
Un contrato con estado **pendiente** no tiene todavía una prueba que lo ejerza; la épica E2 del plan 18 los cierra.

Regla: un cambio de forma en un contrato rompe una prueba de `test/contract/`. Para aceptarlo se regenera la instantánea con `npm run contracts:update`, y el diff de la instantánea queda en el commit.

| Id | Qué es | Fuente | Estado |
|---|---|---|---|
| C-CFG-TOOL-1 | Lista de herramientas de `synapser mcp-config` (nombres, descripciones, esquemas de entrada) | `src/mcp/config-connector.ts`, instantánea en `test/contract/golden/` | `test/contract/config.contract.test.ts` |
| C-CFG-TOOL-2 | Cada herramienta de configuración tiene su esquema de entrada | `src/contracts/config.ts` | `test/contract/config.contract.test.ts` |
| C-CFG-TOOL-3 | Forma de un proveedor y de un rol: estricta, sin campos de clave | `src/contracts/config.ts` | `test/contract/config.contract.test.ts` |
| C-CFG-API-1 | Respuestas de `PUT /api/config/...`: `{ ok: true }` o `{ error: "INVALID_CONFIG", errors[] }` | `src/contracts/config.ts`, `src/api/server.ts` | `test/contract/config.api.contract.test.ts` contra API real y schemas |
| C-CFG-API-2 | `GET /api/config` | `src/api/server.ts` | `test/contract/config.api.contract.test.ts` contra API real |
| C-MCP-TASK-1 | Herramientas de `synapser mcp` (18 nombres y sus esquemas de entrada) | `src/mcp/server.ts`, instantánea en `test/contract/golden/` | `test/contract/golden.contract.test.ts` |
| C-API-1 | Resto de rutas de la API (`/api/workflows`, `/api/library`, `/api/chat`, `/api/home`) | `src/api/server.ts` | `test/api/control.test.ts`, `test/api/library.test.ts`, `test/api/home.test.ts` |
| C-LEDGER-1 | Columnas de `agent_runs`, con `injection_json` | `src/journal/schema.ts`, instantánea en `test/contract/golden/` | `test/contract/golden.contract.test.ts` |
| C-ADAPTER-1 | Banderas que cada adaptador emite, presentes en el `--help` real del CLI | `src/agents/*.ts`, `test/agents/adapter-help.test.ts` | `test/agents/adapter-help.test.ts` |
| C-LIB-1 | Documentos de biblioteca: agentes, skills y proveedores | `src/library/schema.ts`, `test/library/fixtures/validation-golden.json` | `test/library/validation-golden.test.ts` |

## Estado de la épica E2

## Revisión de cobertura H13.5

Se contrastaron los diez identificadores del inventario con sus pruebas listadas arriba. No queda ningún contrato sin una prueba que lo ejerza. La comprobación de `GET /api/config` se añadió a `test/contract/config.api.contract.test.ts`; las rutas de `C-API-1` se cubren por estado y comportamiento, sin afirmar que exista una instantánea de forma.

- H2.1 inventario: hecho.
- H2.2 esquemas zod: hechos para la configuración; las demás rutas se validan por sus pruebas de estado.
- H2.3 pruebas de contrato: hechas.
- H2.4 instantáneas y `contracts:update`: hechas (tres instantáneas).
- H2.5 compatibilidad: hecha, con la regla de `test/contract/compat.ts`.
- H2.6 banderas de adaptadores: existente (`test/agents/adapter-help.test.ts`).
