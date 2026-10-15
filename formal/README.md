# Modelos formales (plan 18, E10)

Comando: `npm run test:formal`. Requiere Java y el jar de TLA+ (tools v1.7.4), que se lee de `SYNAPSER_TLA_JAR` o de `~/.cache/synapser-tools/tla2tools.jar`. Su digest está fijado en `tla2tools.sha256`. El jar no se versiona.

No entra en `verify`: TLC tarda segundos, pero depende de Java y de un jar externo.

## Trazabilidad (H10.3)

| Propiedad | Qué afirma | Prueba en la implementación | Estado |
|---|---|---|---|
| `MutualExclusion` | nunca dos procesos dentro del bloqueo del workspace | `test/journal/lock-and-artifacts.test.ts` (bloqueo exclusivo por workspace) | comprobada en el modelo y en la prueba de código |
| `NoDuplicates` | un proceso tiene como mucho un lugar en la cola | `test/journal/lock-order.test.ts` | comprobada en el modelo y en la prueba de código |
| `EventualEntry` | un proceso en cola entra, o sale de la cola (si muere) | `test/journal/lock-order.test.ts` (orden de llegada, tickets de procesos muertos, tiempo de espera) | comprobada en el modelo con equidad débil sobre `Enter` y `Leave` |

## Hallazgo y decisión

El bloqueo del journal era un bloqueo exclusivo de SQLite sin cola: quien volvía a pedirlo primero ganaba, y bajo contención un proceso podía quedar sin entrar. Con equidad débil, TLC encontró ese contraejemplo.

Decisión tomada: cola FIFO. `acquireWorkspaceLockInOrder` (en `src/journal/lock.ts`) deja un ticket por espera y solo intenta el bloqueo quien tiene el ticket más antiguo vivo. El motor de workflows lo usa, así que una segunda corrida en el mismo workspace espera su turno en lugar de fallar. El modelo ahora representa la cola (`queue`), y el primero de la cola es el único que puede entrar.

Límite que queda: el ticket de un proceso muerto se elimina cuando el PID ya no existe. Si el sistema reutiliza ese PID antes de la poda, el ticket sobrevive hasta que el PID vuelva a quedar libre. La entrada eventual se enuncia así porque un proceso que muere no puede entrar: la propiedad dice que un proceso en cola termina entrando o sale de la cola.
