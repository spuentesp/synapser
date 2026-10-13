# Plan 07 — Tavily como fuente de datos externos

Decisión: **Tavily entra al producto** como puerto de investigación (`ResearchPort`), no como
adorno. Habilita el bono *Best Use of Tavily* (US$3 000), que exige "a functional, runtime call to
the Tavily API as part of its solution"; un proyecto puede combinarlo con un premio de pista.

## 1. Hechos verificados

Fuente: [docs.tavily.com](https://docs.tavily.com/llms.txt), leída el 13 oct 2026. Sin ejecutar
contra la cuenta (no hay key).

| Tema | Hecho |
|---|---|
| API | Base `https://api.tavily.com`; `Authorization: Bearer tvly-…`; endpoints `/search`, `/extract`, `/map`, `/crawl`, `/research` |
| `/search` | `query`, `search_depth` (`basic`/`advanced`/`fast`/`ultra-fast`), `max_results` (≤ 20), `include_domains`, `exclude_domains`, `time_range`, `include_answer`, `include_usage`, `chunks_per_source` (≤ 3) |
| Costo | `basic`/`fast`/`ultra-fast` = 1 crédito, `advanced` = 2; extract: 5 URLs = 1 crédito; 1 000 créditos gratis al mes |
| Límites | Dev 100 RPM, Prod 1 000 RPM; 429 con `Retry-After`; `/research` 20 RPM |
| Créditos | El Builder Program de Nebius da créditos de Tavily (bases, *Project Requirements*) |
| Sin key | Existe acceso *keyless* a Search y Extract, con límite bajo ([keyless](https://docs.tavily.com/documentation/keyless.md)). No sé si cuenta para el bono: no depender de él |

## 2. Qué problema resuelve en Synapser

Un agente que modifica código necesita **hechos que no están en el repo**: semántica de una API,
un estándar, el significado de un error. Hoy el modelo los inventa o los recuerda mal. Con Tavily
esos hechos entran como **evidencia con fuente**, igual que en el resto del producto ("el texto del
agente no es certificado": la afirmación necesita evidencia).

| Uso | Rol | Efecto visible |
|---|---|---|
| **U1 Fundamentar el plan** | `supervisor` | El plan cita fuentes; la UI muestra un panel "Fuentes" por revisión de plan |
| **U2 Consulta durante la tarea** | `worker` (herramienta `web_search`) | El agente consulta documentación sin salir del bucle |
| **U3 Reparación** | `repair` | Tras un test fallido, busca el mensaje de error |
| **U4 Dato requerido por la misión** | tarea T0 (opcional, §6) | La misión *no puede* completarse sin un dato externo verificable |

## 3. `ResearchPort`

```ts
interface ResearchPort {
  search(q: ResearchQuery, ctx: CallContext): Promise<ResearchResult>;   // lanza ResearchError
  extract?(urls: string[], ctx: CallContext): Promise<ExtractResult>;
}
interface ResearchQuery { query: string; maxResults: number; depth: "basic" | "advanced";
                          includeDomains?: string[]; excludeDomains?: string[]; }
interface ResearchResult {
  callId: string;
  results: { url: string; title: string; content: string; score: number }[];
  creditsUsed: number | null;     // include_usage
  latencyMs: number; cached: boolean;
}
type ResearchError = "RATE_LIMITED" | "UNAVAILABLE" | "TIMEOUT" | "AUTH" | "BAD_REQUEST" | "DISABLED" | "BUDGET";
```

Adaptadores: `TavilyResearch` (fetch nativo, sin SDK), `ReplayResearch` (cassettes para CI y para
una demo reproducible) y `NullResearch` (cuando `research.enabled=false`). Cambiar de proveedor de
búsqueda es un adaptador; el bucle y la UI no cambian.

## 4. Reglas de seguridad (el punto delicado)

El contenido web es **no confiable** y la consulta es **una salida de datos hacia un tercero**.

| Riesgo | Control |
|---|---|
| Inyección de instrucciones en una página | Los resultados llegan como mensaje `tool` rotulado "contenido externo no confiable". No hay herramienta de navegación ni de ejecución derivada; rutas, alcance y claims los decide el ejecutor, no el modelo |
| Fuga de código privado en la consulta | Consulta ≤ 200 caracteres, sin saltos de línea; el backend rechaza consultas que contengan fragmentos copiados de archivos del workspace (coincidencia de subcadenas largas) y patrones de secretos; `research.enabled=false` para repos privados |
| Resumen opaco | `include_answer=false`: se guardan **las fuentes**, no el resumen de otro modelo |
| Costo/abuso | Tope por tarea (5) y por misión (20), tope de créditos, caché por `(query, params)` |
| Disponibilidad | Tavily caído → la tarea continúa sin investigación y lo registra; **nunca** se fabrican citas |

## 5. Procedencia: "ninguna cita sin recuperación"

Todo artefacto que cite una URL (plan, `docs/SOURCES.md`, comentario) se comprueba contra las
consultas registradas de la corrida:

```
verifyCitations(artifact, runId) → { ok, uncited: [...], unretrieved: [url…] }
```

Una URL que **no** aparece en ningún `research_call` de esa corrida marca el artefacto como
`CITATION_UNVERIFIED` y bloquea el criterio de aceptación que la requiera. Es la misma filosofía
que `DONE` por evidencia: el modelo no puede "recordar" una fuente y presentarla como consultada.

## 6. Tarea T0 opcional: dato que no está en el repo

Para que Tavily sea **funcionalmente necesario** (y no decorativo) en la demo:

> **T0 / investigación — `docs/SOURCES.md` + `app/currency.py`:** determinar el exponente de la
> unidad menor de CLP, USD, JPY y KWD según ISO 4217, con la fuente. T1 y T2 dependen de T0.

- Oracle independiente (valores fijados antes de la corrida): `USD=2`, `CLP=0`, `JPY=0`, `KWD=3`.
- Criterio de aceptación adicional: cada URL citada ∈ resultados de Tavily de esa corrida (§5).
- Un modelo podría "saber" los exponentes; por eso el criterio no es el valor sino **valor + cita
  recuperada**. Mide Tavily de verdad.
- **Costo**: modifica fixture y oracle, y añade un nodo al DAG. Es una variante; el camino
  principal del diseño v0.2 sigue intacto. *Necesito tu decisión* (sección 9).

## 7. Datos y trazas

```sql
CREATE TABLE research_calls(
  call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL,
  provider TEXT NOT NULL, endpoint TEXT NOT NULL, query TEXT NOT NULL, params_json TEXT NOT NULL,
  started_at INTEGER NOT NULL, latency_ms INTEGER, http_status INTEGER,
  credits_used INTEGER, cached INTEGER NOT NULL DEFAULT 0,
  result_blob TEXT, error TEXT) STRICT;
```

Cada llamada emite un evento (`entity='research_call'`); la UI muestra consulta, dominios, créditos
y fuentes junto a las llamadas al modelo. Los cuerpos van como artefactos direccionados por
contenido (reproducción sin gastar créditos).

## 8. Efecto en lo ya diseñado

| Documento | Cambio |
|---|---|
| Plan 01 | Añadir `research_calls` |
| Plan 02 | `web_search` entra en la superficie de herramientas del agente; **no** es una acción de escritura (no pide claims) |
| Plan 05 | Decisión 3 resuelta: Tavily incluido; bono opcional además de la pista |
| Plan 06 | El "puerto opcional de búsqueda" pasa a ser `ResearchPort` + `TavilyResearch` |
| README | Declarar el uso de Tavily y qué datos salen hacia él |
| Feedback (R10) | Anotar fricciones de Tavily también |

## 9. Qué necesito

1. `TAVILY_API_KEY` (clave de desarrollo basta; créditos por el Builder Program).
2. **¿Incluimos la tarea T0 (§6)?** Recomiendo que sí: es lo que hace "un uso creativo y no obvio"
   comprobable. Cambia el fixture y el oracle.
3. Si prefieres no tocar el fixture, Tavily queda en U1–U3 y el bono depende de que el panel de
   fuentes y las citas verificadas se vean en la demo.
