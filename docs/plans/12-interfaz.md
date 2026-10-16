# Plan 12 — Interfaz de observación y auditoría

La interfaz pesa en la evaluación (visible, demostrable). Su diseño sigue una regla: **cada cifra que
muestra es una consulta sobre el ledger y cita los eventos que la sustentan.** No hay estado propio.

## 1. Vistas

| Vista | Pregunta que responde | Fuente |
|---|---|---|
| Enjambre | ¿qué hace cada agente ahora? árbol de tareas, estado, esperas | `state` (plan 11) |
| Línea de tiempo | ¿qué pasó, cuándo, en qué orden? con reproducción por `seq` | `timeline` |
| Por qué | ¿por qué cambió este archivo? cadena declarada + lo que el agente afirmó (etiquetado) | `why` |
| Costo y desperdicio | ¿quién gastó qué? lo desconocido marcado, no sumado como 0 | `cost`, `waste` |
| Coordinación | ¿dónde hubo esperas, vistas rancias, re-anclajes? | `coordination` |
| Aprobaciones | bandeja de compuertas pendientes (única vista con escritura) | plan 10 §4 |
| Integridad | cadena verificada, `head`, exportación verificable sin conexión | `verify` |

## 2. Arquitectura

Aplicación web en **React + Tailwind + shadcn/ui** (decisión del 13 oct; el mismo stack de los demás proyectos), servida por un `http` de Node **sin dependencias de servidor** (mismo criterio que el resto:
superficie mínima), más una API JSON delgada que solo proyecta `src/audit/*`. Sin framework de
estado en el cliente: la fuente es el servidor. SSE para el flujo vivo.

```
GET  /api/runs                         lista de corridas
GET  /api/runs/:id/{state,timeline,why,cost,waste,coordination,verify}
GET  /api/runs/:id/events?since=seq    SSE
POST /api/runs/:id/approvals/:gate     única escritura: registra APPROVED|REJECTED con actor
```

## 3. Invariantes

| | Invariante | Verificador |
|---|---|---|
| U1 | la interfaz no puede causar una escritura en el workspace | el servidor no importa el ejecutor; prueba de que `POST` solo añade eventos de aprobación |
| U2 | toda cifra visible trae sus `seq` de origen (cita) | prueba de contrato: la API devuelve `evidence: seq[]` en cada agregado |
| U3 | la API es determinista: mismas consultas ⇒ mismos bytes | doble petición |
| U4 | un aprobador solo aprueba compuertas **vigentes** (ligadas al digest actual) | prueba de rechazo con digest viejo |
| U5 | datos sensibles fuera por defecto: sin prompts ni contenido de archivos salvo opt-in | prueba de fuga como la de LangSmith |

## 4. Obligaciones de prueba

Contrato de cada endpoint contra la consulta equivalente; carga de la UI en navegador real (captura y
aserciones DOM por vista con datos de un ledger fixture); estado vacío y corrida abortada; la cadena
rota se muestra como tal (insignia roja con el primer `seq` malo), no se oculta.

## 5. Guion de demostración (3–5 min)

El guion ejecutable actual es **offline y repetible**: `scripts/demo.ts` usa agentes simulados y el
runner real, sin llamar a Nemotron ni a un CLI externo. La toma de aprobación, coste e integridad,
con sus límites de afirmación, está en `docs/guion-demo-c3.md`. No afirmar contención/re-anclaje si
Coordinación no los muestra ni presentar actividad simulada como salida de un modelo real.

## 6. Falsación

Si una cifra de la UI no puede reconstruirse desde la API (U2), esa cifra se elimina. Si el costo de
mantener la vista de "reproducción" supera su valor en la demo, se recorta a la línea de tiempo
estática; las vistas 1, 3 y 7 no se recortan.

## 7. Estado de implementación

Implementado: `src/api/server.ts` (HTTP sin dependencias, `127.0.0.1`; GET de solo lectura con
**evidencia citada** en agregados, SSE con reanudación por `Last-Event-ID`, una sola escritura:
`POST …/approvals/:task` con token de sesión, comprobación de origen y digest vigente) y
`src/ui/` (HTML + CSS + JS sin dependencias, CSP `default-src 'self'`, todo texto dinámico escapado,
ES/EN, tema claro/oscuro, rutas por `#vista`). Vistas: enjambre (grafo por niveles con esperas y
retenciones), línea de tiempo (filtro), por qué (cadena declarada + afirmación rotulada), costo y
desperdicio (lo desconocido marcado), coordinación, aprobaciones e integridad (verificación y
exportación; `scripts/verify-export.ts` la verifica sin conexión). Reproducción por `seq` con el
deslizador. `scripts/demo.ts` levanta una misión determinista completa con la interfaz;
`scripts/serve.ts` sirve un directorio de estado existente.

Pruebas: contrato de la API (U1–U5, SSE, entradas hostiles) y la interfaz en un navegador real por
CDP (render, clic en *Aprobar* ⇒ evento en el ledger con actor, texto hostil inerte).

### Cambio de stack (13 oct)

La primera versión de la interfaz (JS sin dependencias) se reemplazó por **React 19 + Vite +
Tailwind 4 + shadcn/ui** (variante base-ui) en `web/`. El servidor y los invariantes U1–U5 no
cambian: la app es un artefacto de compilación (`web/dist`) que `src/api/server.ts` sirve con la misma
CSP estricta; el núcleo conserva cero dependencias de ejecución. Comandos: `npm run web:install`,
`npm run web:build`, `npm run web:dev` (proxy de `/api`). Estados de misión con tokens semánticos
(`--status-*`) definidos en el CSS global, según las reglas del skill de shadcn. Skills instalados para
el stack en `.claude/skills` (shadcn/ui oficial, Vercel react-best-practices y composition-patterns,
Tailwind v4 comunitario), con `skills-lock.json` fijando sus hashes.
