# Modelos formales (plan 18, E10)

Comando: `npm run test:formal`. Requiere Java y el jar de TLA+ (tools v1.7.4), que se lee de `SYNAPSER_TLA_JAR` o de `~/.cache/synapser-tools/tla2tools.jar`. Su digest está fijado en `tla2tools.sha256`. El jar no se versiona.

No entra en `verify`: TLC tarda segundos, pero depende de Java y de un jar externo.

## Trazabilidad (H10.3)

| Propiedad | Qué afirma | Prueba en la implementación | Estado |
|---|---|---|---|
| `MutualExclusion` | nunca dos procesos dentro del bloqueo del workspace | `test/journal/lock-and-artifacts.test.ts` (plan 01, bloqueo exclusivo por workspace) | comprobada en el modelo; la prueba de código existe |
| `EventualEntry` | un proceso que espera entra | ninguna | **no se cumple sin equidad fuerte.** Con equidad débil, TLC encuentra un contraejemplo: un proceso queda adelantado sin fin por otro que entra y sale. Ver el hallazgo. |

## Hallazgo

El bloqueo del journal (plan 01) es un bloqueo exclusivo de SQLite. No tiene cola ni orden de llegada: quien vuelve a pedirlo primero gana. Bajo contención sostenida, un proceso puede quedar sin entrar. El modelo lo demuestra con equidad débil. La propiedad solo se cumple si las peticiones se atienden en orden. Decisión pendiente: añadir una cola FIFO al bloqueo, o aceptar la inanición y registrar el límite.
