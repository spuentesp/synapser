# Plan 14 — Seguimiento y traspaso

Fuente única de qué está hecho y qué falta del [plan 14](14-diseno-en-la-ui.md). Cualquier agente que
continúe **actualiza este archivo en el mismo commit** que cambia el código. `node scripts/plan-status.ts`
resume el estado y falla si una tarea marcada hecha no cita un commit.

Estados: `[ ]` pendiente · `[~]` en curso (anotar quién y desde cuándo) · `[x]` hecha (con `commit:` corto
y la prueba que la cubre) · `[!]` bloqueada (con motivo).

## Cómo trabajar aquí (leer antes de tocar nada)

- Repo `/data/agents/orca/synapser`, rama `main`. Node 24, sin dependencias de ejecución nuevas salvo que el
  plan lo diga. La UI es React + Tailwind + shadcn/ui en `web/` (`npm run web:build`).
- Pruebas: `env -u NEBIUS_TOKEN env -u TAVILY_TOKEN npm test` (las pruebas vivas se omiten sin claves).
  Estado al traspaso: 381 pasan, 0 fallan, 8 omitidas. Una tarea no está hecha si baja ese número.
- Pruebas vivas: `node --env-file=.env --test test/live/<archivo>.test.ts`. Las claves están en `.env`
  (gitignored); **nunca** imprimirlas ni commitearlas; revisar el diff antes de cada commit.
- Commits: mensaje claro, cuerpo con el porqué, y cerrar con `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
  No commitear `pnpm-lock.yaml` ni `design/` salvo el docx cuando se pide.
- **Resultados medidos y análisis de fallos NO van a archivos versionados** (memoria del usuario). Datos
  crudos en `evidence/` (gitignored); se informan en el chat. Los documentos dicen contratos, invariantes
  y criterios de falsación, no cifras.
- No usar `pkill -f` ni `kill` por patrón: mata el propio shell. Ubicar el PID con `ps ... | grep "[x]"`.
- Cada diseño nuevo trae sus invariantes, su verificador y su falsación, como en los planes 08–13.
- Idioma de la documentación: español. Código y mensajes de commit: inglés.
- Para ver la app: `scripts/sandbox.sh [puerto]` y abrir `http://127.0.0.1:<puerto>/`. **La UI nueva
  nunca se ha visto en un navegador real**: toda tarea de UI se verifica ahí antes de marcarla.

## Contexto que no está en el código

- `native` = el bucle de Synapser conectado a un proveedor de modelos (hoy solo OpenAI-compatible).
- Los CLI (claude, codex, kimi, mimo) conducen su propio bucle en la copia aislada; Synapser controla
  entradas, permisos y presupuesto y recoge el cambio. No tienen canal de vuelta (subtareas, efectos, MCP).
- El runner de CLI corre con HOME efímero, sin credenciales y con git apuntando a la nada
  (`src/agents/runner.ts`); la inyección de skills debe usar ese HOME, no el del usuario.
- Los modos headless están verificados en el plan 14 §1. Falta confirmar dónde lee skills `mimo`.

## Estado heredado (plan 13): hecho

P1 workflow/condiciones/MCP · P2 compuertas de efectos · P3 asesor · P4 niveles, escalera, pools,
`doctor` · P5 chat, API de workflows y vistas Chat/Workflows/Agentes. Docx de diseño en v0.4.

## Tareas

### Q1 — Adaptadores por agente y skills

- [x] Q1.1 Interfaz `AgentAdapter` con `capabilities` y `build/parse` (`src/agents/adapter.ts`); el
  `CliOneShotRunner` actual delega en ella sin cambiar el comportamiento. *Prueba:* toda la suite actual verde.
  commit: c7ff72d (inicio; implementación y cierre en este commit). Prueba: suite completa y regresión
  directa de delegación `build/parse` verdes.
- [ ] Q1.2 `claude-code`: invocación, parser, permisos y presupuesto como parámetros del perfil.
- [ ] Q1.3 `codex`: ídem; HOME efímero con `CODEX_HOME`.
- [ ] Q1.4 `kimi`: ídem; `--skills-dir`.
- [ ] Q1.5 `mimo`: ídem; averiguar el mecanismo de skills o declarar `prompt-prepend`. Hoy está
  deshabilitado por saldo (402): la prueba real puede quedar como omitida con motivo.
- [ ] Q1.6 `generic-cli`: envoltorio con parser `plain` (ya existe el parser).
- [ ] Q1.7 Inyección de skills por mecanismo (`native-dir`, `skills-dir-flag`, `prompt-prepend`) y registro
  en `agent_runs` de id + digest + mecanismo. *Invariantes:* L1, L2.
- [ ] Q1.8 Prueba L5: cada flag que emite un adaptador está en su tabla de capacidades y existe en el
  `--help` del binario real (omitida si el binario no está).
- [ ] Q1.9 Una corrida real por CLI instalado con una skill inyectada, verificando que la skill llegó.

### Q2 — Biblioteca, proveedores y API

- [ ] Q2.1 Almacén `library/` en el estado: proveedores, skills, plantillas, agentes; versión por digest;
  cada cambio es un evento en el ledger del servidor. *Invariante:* L4.
- [ ] Q2.2 `Provider` (protocolo, baseUrl, apiKeyEnv, modelos con precio) y agentes `native` que lo
  referencian; migrar `endpoint` de perfiles a proveedor; precio declarado → costo conocido.
- [ ] Q2.3 Roles del sistema (supervisor, worker, repair, advisor, chat) asignables a proveedor+modelo;
  hoy fijos en `defaultModelConfig()`.
- [ ] Q2.4 Prueba de conexión de proveedor (lista modelos + llamada mínima; la clave nunca sale).
- [ ] Q2.5 Congelar la biblioteca al iniciar un workflow. *Invariante:* L3.
- [ ] Q2.6 Endpoints CRUD (`/api/library/*`) con token y mismo origen; configuración inválida rechazada
  entera con todos los problemas.
- [ ] Q2.7 `synapser doctor` y `config show` leen la biblioteca además del archivo.

### Q3 — Diseñadores y plantillas (UI)

- [ ] Q3.1 Diseñador de workflow: formulario, constructor de condiciones por verificador, validación en
  vivo contra el validador real, vista previa JSON.
- [ ] Q3.2 Plantillas parametrizadas e integradas: cambio acotado con pruebas, investigación con citas,
  revisión, migración con no-metas.
- [ ] Q3.3 Diseñador de agente: adaptador, nivel, rol, permisos, presupuesto, pool, skills; muestra qué se
  puede y no controlar en cada modo.
- [ ] Q3.4 «Probar agente»: tarea trivial en una copia desechable; muestra resultado, costo y skills recibidas.
- [ ] Q3.5 Editor de skills y de proveedores con prueba de conexión.
- [ ] Q3.6 Verificación en navegador real de todo lo anterior (capturas en `evidence/`, no versionadas).

### Q4 — Inicio y pantallas sin datos

- [ ] Q4.1 Pantalla de inicio: workflows activos, compuertas pendientes, agentes, costo acumulado.
- [ ] Q4.2 Estados vacíos que dicen qué hacer y enlazan al diseñador (Enjambre, Línea de tiempo, Por qué,
  Costo, Coordinación, Aprobaciones, Integridad).
- [ ] Q4.3 La corrida del workflow seleccionado es el contexto por defecto de las vistas por corrida.
- [ ] Q4.4 Vista de intervenciones del asesor y de efectos (hoy solo existen en CLI y MCP).

### Cierre

- [ ] C.1 Actualizar el docx (v0.5) con las secciones del plan 14 (script en el scratchpad de la sesión
  anterior; si no está, regenerar con el mismo método: editar el XML sobre `design/Synapser_Diseno.docx`).
- [ ] C.2 README: sección de configuración desde la UI.
- [ ] C.3 Demo integrada y guion de vídeo (el usuario pidió **no** hacerla todavía).

## Decisiones abiertas del usuario (no resolver sin preguntar)

Licencia (MIT sugerida) · track del hackathon (Coding & Agentic Engineering sugerido) · momento de la
traducción al inglés · instalación global (-g) de skills · si se limpian resultados medidos de
`docs/plans/05` y `06 §15` y del historial git antes de publicar.

## Bitácora de traspaso

| Fecha | Quién | Cambio |
|---|---|---|
| 2026-10-14 | Claude Sonnet 5.5 | Tracker creado; Q1–Q4 sin empezar. Último commit del código: `868ff29` |
| 2026-10-13 | GPT-5 Codex | Q1.1: contrato `AgentAdapter`; el runner CLI delega construcción y parseo sin cambiar su aislamiento. |
