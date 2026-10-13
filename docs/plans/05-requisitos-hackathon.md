# Requisitos de las bases oficiales y su efecto en la arquitectura

Fuente: <https://nebiusglobalaihackathon.devpost.com/rules> (leída el 13 oct 2026).
Citas textuales entre comillas; el resto es interpretación mía, marcada como tal.

## 1. Fechas

| Hito | Fecha (bases) | En Santiago (UTC−3) |
|---|---|---|
| Cierre de envíos | vie 30 oct 2026, 10:00 PT | 30 oct, 14:00 |
| Evaluación | 1 dic 09:00 PT – 15 dic 12:00 PT | 1 dic 13:00 – 15 dic 16:00 |
| Anuncio | ~11 ene 2027 | — |

Tras el cierre "you may not make any changes or alterations to your Submission". El repositorio y la
demo, en cambio, tienen que seguir funcionando durante toda la evaluación.

## 2. Requisitos duros (incumplirlos descalifica o deja fuera de juicio)

| # | Requisito | Cita / fuente | Estado actual |
|---|---|---|---|
| R1 | App funcional que "runs on either Nebius Token Factory or Nebius AI Cloud" y usa **al menos un modelo open source de NVIDIA** | Project Requirements | Diseño: Nemotron vía Token Factory. **Sin llamada real aún** |
| R2 | "Runs on" significa: llamada en runtime a la API de inferencia de Token Factory, **o** desplegado en cómputo de AI Cloud (Serverless Jobs / Endpoints / DevPods) | Project Requirements | Cubierto por diseño, no probado |
| R3 | Encajar en **una** de las 4 pistas | Tracks | Recomendada: *Coding and Agentic Engineering* |
| R4 | URL de demo/app hospedada o build de prueba | Submission Requirements | Planificado (G5), sin host aún |
| R5 | Repo **público** (GitHub/GitLab/Bitbucket) con **licencia open source detectable** "visible at the top of the repository page (in the About section)" | Submission Requirements | **Faltan LICENSE y remoto público** |
| R6 | El repo contiene "all necessary source code, assets, and instructions required for the project to be functional" + README con setup | Submission Requirements | README existe; falta instalar Zoanthrope reproduciblemente |
| R7 | README/descripción destacan cómo se usó Nemotron, **dónde Token Factory aceleró** y otros servicios Nebius | Submission Requirements | Pendiente |
| R8 | Video **< 3 min**, público en **YouTube**, mostrando el proyecto funcionando; sin marcas de terceros ni música con copyright sin permiso | Submission Requirements | Diseño: 175 s (margen de 5 s) |
| R9 | Identificar la pista | Submission Requirements | Pendiente |
| R10 | **Feedback obligatorio** sobre Token Factory, AI Cloud y herramientas NVIDIA usadas | Submission Requirements | No iniciado |
| R11 | Si el proyecto existía antes del 26 ago, explicar qué se actualizó significativamente | New & Existing | Ver G11 |
| R12 | Acceso "free of charge and without any restriction" para pruebas, hasta el fin de la evaluación | Testing | Ver G3 |
| R13 | Todo en **inglés** (o traducción al inglés) | Language | Diseño y planes están en español |
| R14 | Obra original, sin derechos de terceros; OSS permitido si se "builds upon" el producto subyacente | IP Rights | Ver G11, G12 |

## 3. Cómo se puntúa (y qué implica para la arquitectura)

Etapa 1 es pasa/no-pasa: "reasonably fits the theme and reasonably applies the required APIs/SDKs".
Etapa 2: cuatro criterios **con igual peso**:

| Criterio (25 % c/u) | Pregunta de las bases | Implicancia |
|---|---|---|
| Technological Implementation | "How well is the project built, and how effectively does it use … Token Factory … and NVIDIA Nemotron" | Nemotron no puede ser decorativo; las trazas (modelo, latencia, tokens) deben ser visibles |
| Design | "complete, coherent product experience not just a technical proof of concept" | **La interfaz vale 25 %.** El journal ya emite eventos: la UI debe construirse sobre ellos desde pronto |
| Potential Impact | "credible, specific case for solving a real problem for a real audience" | El caso del ingeniero que dirige agentes sobre un repo compartido y el A/B de trabajo perdido |
| Quality of the Idea | "creative, non-obvious use of … Token Factory … Nemotron" | La tesis "el modelo propone, el sistema certifica" |

Premios (interpretación): un proyecto opta a **un** premio general **o** uno de pista, **más** un bono.
General: $20 000 / $10 000 / $6 000. Pista: NVIDIA Jetson Orin Nano. Bonos: Tavily $3 000
(requiere "functional, runtime call to the Tavily API"); *Most Valuable Feedback* ×10 ($100 + swag).

## 4. Lo que usaremos

| Pieza | Uso | Obligatorio |
|---|---|---|
| **Nebius Token Factory** | Inferencia de Nemotron con tool calling, en runtime | Sí (R1/R2) |
| **NVIDIA Nemotron** | Supervisor (descomposición, recuperación) y agentes (parches) | Sí |
| **Nebius AI Cloud** | Hospedar backend, ejecutor y UI con disco para workspace/journal | Recomendado (R4, R12) |
| Zoanthrope 0.1.3 | Arbitraje de archivos (binario real, fijado) | Del diseño |
| Node 24, `node:sqlite`, TypeScript | Ejecutor, journal, API | Del diseño |
| React | Interfaz de control | Del diseño |
| Serverless Jobs *(opcional)* | Correr las pruebas de aceptación en copia aislada y sin red | No |
| **Tavily** | Puerto de investigación web con procedencia de citas ([plan 07](07-tavily-investigacion-web.md)); habilita el bono | Decidido (opcional para las bases) |
| Builder Program | Créditos de Token Factory y Tavily | Recomendado |

## 5. Brechas entre el diseño v0.2 y las bases

| # | Brecha | Acción propuesta |
|---|---|---|
| G1 | Sin `LICENSE` ni remoto público (R5) | Añadir licencia (MIT, coherente con Zoanthrope) y publicar el repo; verificar que aparezca en *About* |
| G2 | Sin commits en el repo | Primer commit pronto; las bases piden "significantly updated"/historia visible |
| G3 | R12 exige acceso gratuito y sin restricción **hasta el 15 dic 12:00 PT**; el diseño promete "1 al 15 de diciembre" y una demo con límites | Mantener la demo **desde el envío** hasta el 15 dic. Los límites son del *producto* (presupuesto de misión visible), no de acceso: sin login, sin cuota por usuario. Fijar un tope de gasto en Token Factory y una degradación explícita al agotarse |
| G4 | `zoanthrope.lock.json` fija el SHA-256 de **un** build; en otra máquina (p. ej. el host Nebius) compilar daría otro hash y G0 fallaría | El script de instalación compila el commit fijado, verifica `--version` y **registra** el hash; el hash fijado se vuelve opcional (R6: el repo debe ser reproducible) |
| G5 | Documentos en español (R13) | README, descripción, instrucciones de prueba y video en inglés. Traducir el diseño o separar lo interno |
| G6 | Video de 175 s (R8) deja 5 s de margen | Apuntar a ≤ 165 s; sin logos ni música de terceros; sin referencias a Warhammer |
| G7 | Feedback es campo **obligatorio** (R10) | Abrir `docs/feedback.md` ya y anotar fricciones reales (tool calling, límites, errores). Además compite por *Most Valuable Feedback* |
| G8 | El diseño usa Nemotron 3 Nano 30B A3B para todo; la pista menciona Ultra para razonamiento y Super/Nano para llamadas rápidas | Modelo **por rol** y configurable: supervisor con el mayor disponible, agentes con Nano. Registrar modelo por corrida. Requiere el spike de tool calling en la cuenta |
| G9 | Nemotron podría parecer accesorio (Etapa 1 + Technological Implementation + Idea) | Panel de llamadas al modelo en la UI; que el A/B muestre trabajo real de Nemotron en descomposición, parches y propuesta de recuperación |
| G10 | "Design" pesa 25 % y la UI está al final del plan (22–25 oct) | Esqueleto de UI sobre el stream de eventos del journal desde la semana del 17; pulirla después |
| G11 | Zoanthrope es un proyecto previo del mismo autor (v0.1.0 el 12 oct, dentro del período de envío) | README de Synapser lo declara: qué es Zoanthrope, qué se construyó nuevo (ejecutor, journal, supervisor, UI, A/B) |
| G12 | "Zoanthrope" y su README ("Tyranid", "Hive Mind") remiten a una marca de Games Workshop (creo; vale confirmarlo) | No usar esa iconografía en la demo ni el video; evaluar si el nombre es un riesgo para R8/R14 |
| G13 | Una sola submission por proyecto; varias deben ser "substantially different" | Presentar solo Synapser; Parallax queda fuera |
| G14 | Tras el cierre no se edita la submission | Etiquetar un release en el envío y no romper la demo después |

## 6. Riesgos

1. **Cuenta y créditos.** Nada en este entorno (ni variables, ni perfil) confirma API key de Token
   Factory ni qué modelos Nemotron ofrece la cuenta. Es el riesgo externo más grande y bloquea G4 del
   diseño.
2. **Costo de la demo abierta.** Una demo sin restricción ejecutada por muchos jueces consume
   créditos; hace falta tope y degradación visible (G3).
3. **Hosting.** Los ejemplos de las bases (Serverless Jobs/Endpoints/DevPods) no incluyen "una VM":
   elegir la forma de despliegue después de ver qué ofrece la cuenta. Un espacio de trabajo nuevo por
   sesión admite disco efímero; el reinicio demostrable del ejecutor sólo requiere matar un proceso.
4. **Calendario.** Quedan 17 días a la fecha de este documento; el plan ya define qué se recorta.

## 7. Decisiones que necesito

1. **Pista:** *Coding and Agentic Engineering* (recomendada) — ¿confirmas?
2. **Licencia:** MIT (coherente con Zoanthrope) o Apache-2.0, y a nombre de quién.
3. ~~**Tavily**~~ — resuelto: incluido (plan 07). Queda decidir la tarea T0.
4. **Idioma:** ¿traduzco el diseño al inglés para el repo o lo dejo fuera del repositorio público?
