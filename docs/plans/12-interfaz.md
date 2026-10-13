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

Aplicación estática servida por un `http` de Node **sin dependencias** (mismo criterio que el resto:
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

1. Misión dada a Nemotron; el enjambre se arma y se ve el árbol (catálogo → perfiles asignados).
2. Contención en vivo sobre un archivo; se ve una espera y un re-anclaje, sin pérdida.
3. Compuerta de aprobación humana; se aprueba desde la bandeja.
4. Pregunta de auditoría: "¿por qué cambió esta línea?" → cadena declarada con citas.
5. Panel de costo: quién gastó qué, con lo desconocido marcado.
6. Insignia de integridad; se altera un byte del export y la verificación falla.

## 6. Falsación

Si una cifra de la UI no puede reconstruirse desde la API (U2), esa cifra se elimina. Si el costo de
mantener la vista de "reproducción" supera su valor en la demo, se recorta a la línea de tiempo
estática; las vistas 1, 3 y 7 no se recortan.
