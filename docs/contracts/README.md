# Contratos de Synapser

Cada contrato tiene un identificador `C-<área>-<n>`, una fuente en el código y su estado de prueba.
Un contrato con estado **pendiente** no tiene todavía una prueba que lo ejerza; la épica E2 del plan 18 los cierra.

Regla: un cambio de forma en un contrato rompe una prueba de `test/contract/`. Para aceptarlo se regenera la instantánea con `npm run contracts:update`, y el diff de la instantánea queda en el commit.

| Id | Qué es | Fuente | Estado |
|---|---|---|---|
| C-CFG-TOOL-1 | Lista de herramientas de `synapser mcp-config` (nombres, descripciones, esquemas de entrada) | `src/mcp/config-connector.ts`, instantánea en `test/contract/golden/` | con prueba |
| C-CFG-TOOL-2 | Cada herramienta de configuración tiene su esquema de entrada | `src/contracts/config.ts` | con prueba |
| C-CFG-TOOL-3 | Forma de un proveedor y de un rol: estricta, sin campos de clave | `src/contracts/config.ts` | con prueba |
| C-CFG-API-1 | Respuestas de `PUT /api/config/...`: `{ ok: true }` o `{ error: "INVALID_CONFIG", errors[] }` | `src/contracts/config.ts`, `src/api/server.ts` | con prueba contra la API real (`test/contract/config.api.contract.test.ts`) |
| C-CFG-API-2 | `GET /api/config` | `src/api/server.ts` | con prueba de estado (`test/api`) |
| C-MCP-TASK-1 | Herramientas de `synapser mcp` (18 nombres y sus esquemas de entrada) | `src/mcp/server.ts`, instantánea en `test/contract/golden/` | con prueba (`test/contract/golden.contract.test.ts`) |
| C-API-1 | Resto de rutas de la API (`/api/workflows`, `/api/library`, `/api/chat`, `/api/home`) | `src/api/server.ts` | con pruebas de estado en `test/api` (no hay instantánea de forma) |
| C-LEDGER-1 | Columnas de `agent_runs`, con `injection_json` | `src/journal/schema.ts`, instantánea en `test/contract/golden/` | con prueba (`test/contract/golden.contract.test.ts`) |
| C-ADAPTER-1 | Banderas que cada adaptador emite, presentes en el `--help` real del CLI | `src/agents/*.ts`, `test/agents/adapter-help.test.ts` | con prueba (existente) |
| C-LIB-1 | Documentos de biblioteca: agentes, skills y proveedores | `src/library/schema.ts`, `test/library/fixtures/validation-golden.json` | con prueba (existente, golden de P16.3) |

## Estado de la épica E2

- H2.1 inventario: hecho.
- H2.2 esquemas zod: hechos para la configuración; las demás rutas se validan por sus pruebas de estado.
- H2.3 pruebas de contrato: hechas.
- H2.4 instantáneas y `contracts:update`: hechas (tres instantáneas).
- H2.5 compatibilidad: hecha, con la regla de `test/contract/compat.ts`.
- H2.6 banderas de adaptadores: existente (`test/agents/adapter-help.test.ts`).
