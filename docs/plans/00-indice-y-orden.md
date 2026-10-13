# Planes de implementación — ventana 17–21 oct

Alcance: journal SQLite, protocolo de acción, ejecutor, digests, conciliación y recuperación
tras crash. Referencia: `design/Synapser_Diseno.docx` §4–§7, §14–§15, gates G2/G3.
Objetivo de salida de la ventana (diseño §11): **S01–S07 pasan sin depender del modelo**.

| Plan | Contenido | Depende de |
|---|---|---|
| [01 Journal](01-journal-sqlite.md) | esquema, transiciones, eventos, artefactos, bloqueo local | — |
| [03 Digests](03-digests-e-identidad-de-contenido.md) | hash de contenido, `request_digest`, snapshot | — |
| [02 Protocolo y ejecutor](02-protocolo-y-ejecutor.md) | máquina de estados de la acción, API, escritura | 01, 03 |
| [04 Conciliación y recovery](04-conciliacion-y-recovery.md) | clasificación post-crash, failpoints, invariantes, arranque | 01, 02, 03 |
| [05 Requisitos de las bases](05-requisitos-hackathon.md) | qué exigen las reglas, cómo se puntúa, brechas del diseño | — |
| [06 Integración Nebius/NVIDIA](06-integracion-nebius-nvidia.md) | modelos por rol, puertos intercambiables, validación aislada, despliegue | 05 |
| [07 Tavily](07-tavily-investigacion-web.md) | puerto de investigación web, procedencia de citas, tarea T0 | 06 |
| [08 Agentes CLI y registro](08-agentes-cli-y-registro.md) | puerto `AgentRunner`, broker, ledger encadenado, consultas, LangSmith | 02, 06 |
| [09 A/B de coordinación](09-ab-coordinacion.md) | hipótesis, control, invariantes I1–I5, falsación | 08 |
| [10 Orquestación y workflow](10-orquestacion-catalogo-y-workflow.md) | catálogo, enrutador, pasos, aprobaciones, subtareas | 07, 08 |
| [11 Zoanthrope y estado vivo](11-enganche-zoanthrope-y-estado-vivo.md) | identidad/intención, colector, proyección determinista | 08 |
| [12 Interfaz](12-interfaz.md) | vistas, API, invariantes U1–U5, guion de demo | 10, 11 |

## Decisiones tomadas en estos planes (para aprobar)

Cada una se aparta o precisa el diseño v0.2; ninguna lo contradice.

1. **`node:sqlite` integrado, sin dependencias.** Verificado en este host: SQLite 3.53.4, WAL y
   `synchronous=FULL` operativos. Es API experimental de Node 24; el riesgo es de API, no de formato
   de archivo (migrable a `better-sqlite3` tras una interfaz `Journal` estrecha).
2. **El bloqueo local es un lock exclusivo de SQLite, uno por workspace**, no un pidfile ni uno por
   corrida. Verificado con dos procesos: el segundo recibe BUSY mientras el primero vive y adquiere
   inmediatamente tras `kill -9` (lo libera el kernel). Cubre S17 sin carreras de pid reciclado; el
   mismo criterio (start time, no sólo pid) se aplica al matar hijos huérfanos (plan 04, paso 1).
3. **Se añade un estado de acción `CLAIMING`** (escribir la intención *antes* de llamar a Zoanthrope).
   Sin él, un crash entre "Zoo concedió" y "journal CLAIMED" deja un claim en el registro que nadie
   puede atribuir. El diseño §15 pide "pausar y reconciliar con el mismo actor"; `CLAIMING` es lo que
   hace reconocible ese caso.
4. **El parche se resuelve a bytes en PREPARE**, contra la vista que leyó el agente (blob
   direccionado por contenido). `expected_after` es un hash conocido *antes* de adquirir nada; la
   recuperación compara disco con `before`/`after` sin volver a ejecutar un parche ni llamar al modelo.
5. **Estado del coordinador fuera del workspace** (`SYNAPSER_STATE_DIR`, default
   `<workspace>/../.synapser-state/<run_id>`). Mantiene el journal fuera de snapshots y diffs y permite
   permisos de SO distintos. `.synapser` queda además reservado en `paths.ts`.
6. **Solo roll-forward.** La recuperación nunca revierte archivos. Completa pasos registrados o se
   detiene con evidencia (alineado con §15 y "nunca reset global").
7. **Lecturas con identidad de Zoo propia (`run:task#r`).** Hallazgo con el binario real: un
   `read` + `release` del mismo agente borra su propio claim `edit`. Sin esto, S04 + reintento de
   lectura rompe INV1 sin dejar rastro.
8. **`incarnation` no entra en `request_digest`.** Si entrara, un reintento tras reinicio sería "otro
   cuerpo bajo la misma clave" y se rechazaría.

## Decisiones que necesitan tu aprobación

| # | Decisión | Por qué requiere aprobación |
|---|---|---|
| 3 | Estado `CLAIMING` (intención antes de llamar a Zoo) | amplía la máquina de estados del §5 |
| 6 | Solo roll-forward en recuperación; nunca revertir | descarta "volver a BEFORE" como opción |
| plan 04 §4 | Liberar claims huérfanos **propios** de la corrida tras recuperar | roza "el MVP no elimina locks a mano" (§6); usa la API normal de release |
| 5 | Directorio de estado fuera del workspace | cambia dónde vive el journal respecto del diseño |
| 7 | Identidad de lectura `#r` separada | cambia el contrato de identidad del §14 |

## Riesgos abiertos que estos planes no resuelven

- **TTL de lease de Zoo (60 s).** El registro, sin TTL, se consulta antes que el lease
  (`cli_claim_inner`: `check_claim` precede a `fs_lease::reassert`), por lo que un lease viejo no
  debería abrir el recurso a otro agente. *Verificarlo con un test* (G3, `ZOANTHROPE_LEASE_TTL_SECS=1`)
  antes de apoyarse en ello; no lo doy por probado.
- **Durabilidad ante corte de energía** fuera de alcance (diseño §15). El plan aplica fsync de
  temporales y directorio en nuestra escritura; el `save` de Zoo no hace fsync.
- **`node:sqlite` experimental** — ver decisión 1.

## Orden de trabajo y condición de salida

| Día | Entrega | Salida verificable |
|---|---|---|
| 17 | Digests + journal (esquema, CAS de transición, eventos, artefactos, lock) | tests unitarios; S17 |
| 18 | Protocolo feliz: PREPARE→…→SETTLED con 1 y N archivos; API idempotente | S01, S02, S03, S04 (respuesta perdida simulada) |
| 19 | Failpoints + arranque con recuperación | S05 (kill entre renames), S13 |
| 20 | Incarnation, rejoin, stale≠libre, Zoo caído | S06, S07, S09, S16 |
| 21 | Verificador de invariantes + corridas aleatorias de crash; limpieza y evidencia G2/G3 | todo S01–S07 verde 20 corridas seguidas |

Si el día 19 se retrasa, se recorta la corrida aleatoria del día 21, no los failpoints.

## Fase 2 — del motor al producto (hasta el 30 oct, 10:00 PT = 14:00 Santiago)

Orden por valor y dependencia; cada entrega deja la suite en verde y sus invariantes con verificador.

| Tramo | Entrega | Salida verificable |
|---|---|---|
| A (14–17) | Plan 10 núcleo: catálogo, validador, enrutador, compuertas, W1–W4; Tavily U1/U2 (plan 07) | pruebas de §7 del plan 10 sin modelo; una misión con perfil elegido y una aprobación |
| B (18–21) | Plan 11: spike S-Z, colector, `state`, SSE; `request_subtask` (W5) | Z1–Z4, L1–L2; reproducción por `seq` |
| C (22–26) | Plan 12: API y vistas 1, 3, 4, 5, 7 primero; luego 2 y 6 | U1–U5; capturas por vista |
| D (27–29) | A/B sobre carga realista; licencia, repositorio público, traducción al inglés, vídeo, formulario | lista de entrega del plan 05 completa |
| 30 | Reserva; solo correcciones | — |

Regla de recorte, en este orden: reproducción por `seq` → vista de coordinación → delegación (W5) →
L3 (hooks nativos). No se recortan: integridad, aprobaciones, por qué, costo.

### Decisiones de la fase 2 (aprobadas el 13 oct)

| # | Decisión | Dónde |
|---|---|---|
| D1 | El enrutador determinista manda; el modelo solo sugiere perfil | plan 10 |
| D2 | Profundidad de delegación configurable por workflow (default 2) | plan 10 |
| D3 | Costo desconocido: alerta, no bloqueo; se aprende y se estima con procedencia propia | plan 10 §2.1 |
| D4 | Interfaz como app web + API JSON/SSE | plan 12 |
| D5 | Los resultados medidos no se documentan en el repo | memoria |
| D6 | `design/Synapser_Diseno.docx` se expande y actualiza (alinear con planes 08–12) | docx |
