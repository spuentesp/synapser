# Contratos de Synapser

Cada contrato tiene un identificador `C-<área>-<n>`, una fuente en el código y su estado de prueba.
Un contrato con estado **pendiente** no tiene todavía una prueba que lo ejerza; la épica E2 del plan 18 los cierra.

Regla: un cambio de forma en un contrato rompe una prueba de `test/contract/`. Para aceptarlo se regenera la instantánea con `npm run contracts:update`, y el diff de la instantánea queda en el commit.

| Id | Qué es | Fuente | Estado |
|---|---|---|---|
| C-CFG-TOOL-1 | Lista de herramientas de `synapser mcp-config` (nombres, descripciones, esquemas de entrada) | `src/mcp/config-connector.ts`, instantánea en `test/contract/golden/` | con prueba |
| C-CFG-TOOL-2 | Cada herramienta de configuración tiene su esquema de entrada | `src/contracts/config.ts` | con prueba |
| C-CFG-TOOL-3 | Forma de un proveedor y de un rol: estricta, sin campos de clave | `src/contracts/config.ts` | con prueba |
| C-CFG-API-1 | Respuestas de `PUT /api/config/...`: `{ ok: true }` o `{ error: "INVALID_CONFIG", errors[] }` | `src/contracts/config.ts`, `src/api/server.ts` | con prueba de forma; falta la prueba contra la API real |
| C-CFG-API-2 | `GET /api/config` | `src/api/server.ts` | pendiente |
| C-MCP-TASK-1 | Herramientas de `synapser mcp` (18 nombres, con sus entradas y salidas) | `src/mcp/server.ts` | pendiente |
| C-API-1 | Resto de rutas de la API (`/api/workflows`, `/api/library`, `/api/chat`, `/api/home`) | `src/api/server.ts` | pendiente |
| C-LEDGER-1 | Forma de una fila de `agent_runs`, con `injection_json` | `src/journal/schema.ts` | pendiente |
| C-ADAPTER-1 | Banderas que cada adaptador emite, presentes en el `--help` real del CLI | `src/agents/*.ts`, `test/agents/adapter-help.test.ts` | con prueba (existente) |
| C-LIB-1 | Documentos de biblioteca: agentes, skills y proveedores | `src/library/schema.ts`, `test/library/fixtures/validation-golden.json` | con prueba (existente, golden de P16.3) |

## Pendiente de la épica E2

- Prueba de C-CFG-API-1 contra una API real arrancada en la prueba.
- Contratos de C-MCP-TASK-1, C-API-1 y C-LEDGER-1.
- H2.5: regla de compatibilidad (un cambio incompatible exige marca de cambio mayor).
