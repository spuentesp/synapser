# C.3 — Guion de demo integrada y vídeo

## Alcance

Esta es la demo **offline y repetible**: ejecuta una misión real sobre `Executor`, `Journal` y
Zoanthrope, pero las respuestas de agentes vienen de un `ScriptedModel`. No llama a Nemotron,
MiniMax ni a un CLI externo. No presentar sus pausas como latencia de modelo, sus costes como cargos
reales ni su salida como trabajo producido por un LLM.

El guion muestra el hito de aprobación humana, la misión en la consola, el coste desconocido de las
llamadas simuladas y la verificación del ledger. No promete contención/re-anclaje: el escenario no
garantiza una colisión. Tampoco incluye publicación, despliegue ni grabación del vídeo.

## Preparación

1. Desde la raíz del repo, arranca `npm run demo -- --port 4184`. Debe imprimir una URL `/#swarm`.
   Si el puerto está ocupado, elige otro libre; no uses el 4173 compartido.
2. Abre esa URL en el navegador. La misión crea un workspace y un estado temporales, y se detiene en
   la compuerta `docs` hasta que una persona decida.
3. Espera a que la consola muestre la corrida `demo-billing`, con la compuerta pendiente. No uses
   `--approve-after`: el propósito de esta toma es que la decisión pase por la interfaz.

## Toma propuesta (3–5 min)

1. **Enjambre (30–45 s).** “Esta es una misión de ejemplo, ejecutada localmente sin proveedor de
   modelos. Cada tarjeta corresponde a una tarea con estado y evidencia en el ledger.” Mostrar el
   árbol y el estado de la misión; no afirmar que hubo contención si Coordinación no la muestra.
2. **Línea de tiempo (30–45 s).** “Las acciones se pueden rastrear en orden; los eventos no son una
   transcripción de razonamiento.” Mostrar los eventos recientes y sus secuencias.
3. **Aprobación (45–60 s).** Abrir Aprobaciones, leer el resumen `Document the discount parameter in
   the README`, escribir `operador-demo` y aprobar. Confirmar que la compuerta desaparece y la misión
   continúa. La decisión debe quedar atribuida a ese actor en el ledger.
4. **Coste (30–45 s).** Abrir Coste. Explicar que el modo offline no factura y que la UI mantiene
   separadas las llamadas sin tarifa conocida; no describirlas como coste cero.
5. **Integridad (45–60 s).** Abrir Integridad, verificar la cadena, descargar el export y ejecutar
   `node scripts/verify-export.ts demo-billing.ledger.json`. En una copia de ese export, alterar un
   byte de un evento y repetir el comando: la copia alterada debe ser rechazada. No tocar el ledger
   original.
6. **Cierre (10–20 s).** “Esto demuestra composición y trazabilidad local, no una comparación de
   modelos ni una demo alojada.”

## Invariantes, verificador y falsación

- **Invariantes:** el flujo no usa credenciales ni red de proveedores; la aprobación se registra
  mediante la UI con actor y queda en el ledger; la exportación válida verifica y una copia alterada
  falla; la narración distingue el modelo simulado del real.
- **Verificador:** `test/demo/demo.test.ts` arranca la demo contra el binario Zoo fijado, decide la
  aprobación en Chromium, verifica actor/estado/cadena y exige que el export alterado falle;
  `scripts/demo.ts` es también el punto de entrada manual y `scripts/verify-export.ts` el verificador
  offline.
- **Falsación:** misión que no llega a `DONE` tras aprobar, decisión ausente o sin actor en el
  ledger, dato visible que no coincide con la API, export válido rechazado, export alterado
  aceptado, solicitud de red a un proveedor o una narración que atribuye las respuestas a Nemotron
  o a un CLI real.
