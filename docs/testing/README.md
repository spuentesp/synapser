# Cómo se prueba Synapser (plan 18)

## Niveles y comandos

| Nivel | Dónde viven | Comando | Entra en `verify` |
|---|---|---|---|
| Tipado | — | `npm run typecheck` | sí |
| Arquitectura | `.dependency-cruiser.cjs` | `npm run arch:check` | sí |
| Contratos | `test/contract/` | `npm run test:contract` | sí (primer nivel de pruebas) |
| Pruebas (unitarias, integración, propiedades, sandbox, MCP, fixtures) | `test/**` | `npm test` | sí |
| Mutación por módulo | `stryker.config.json`, `scripts/mutation-thresholds.json` | `npx stryker run` y `node scripts/mutation-gate.ts` | sí |
| Cobertura | — | `npm run test:coverage` (lcov en `evidence/coverage/`) | no |
| Interfaz (Playwright) | `test/ui/` (pendiente, E9) | — | no |
| Verificación formal (TLA+) | `formal/` (pendiente, E10) | — | no |

`npm run verify` ejecuta, en orden: comprobación del binario fijado, tipado, reglas de arquitectura, contratos, pruebas y mutación con su compuerta. Se detiene en el primer fallo.

## Reglas

- **Contratos antes que pruebas.** Un cambio de forma en un contrato falla una prueba. La instantánea se regenera solo con `npm run contracts:update` (ver `docs/contracts/README.md`).
- **Propiedades con semilla fija.** La semilla por defecto está en `test/property/support.ts`. `SEED=<n>` reproduce un caso; fast-check imprime la semilla y el caso reducido cuando falla.
- **Mutación con umbral por módulo.** Cada módulo de seguridad tiene su suelo en `scripts/mutation-thresholds.json`. Un suelo solo sube; bajarlo para pasar una ejecución está prohibido.
- **Los sandboxes se prueban.** `test/sandbox/` demuestra que el aislamiento se cumple; no se confía en que exista.
- **Evidencias fuera del repositorio.** Salidas de ejecuciones, capturas y registros van a `evidence/`, que no se versiona. Los resúmenes del plan no contienen resultados medidos (regla de resultados privados).

## Gobierno (E13)

### Intermitentes (H13.1)

Lista abierta al cierre de este documento. Cada entrada tiene fecha y se corrige o se aísla antes del cierre del plan.

- **Ejecutor de `kimi --help` en `test/agents/adapter-help.test.ts`:** con carga alta de la suite completa, el comando supera el límite de 10 s. Ejecutada sola, pasa. Pendiente: subir el límite con razón escrita o medir sin carga.
- **S13 en `test/executor/` (tiempo de proceso hijo):** falló una vez en una ejecución completa y pasó en las dos siguientes. Pendiente: revisar con reloj inyectado (E11).

### Presupuesto de tiempo (H13.2, H13.3)

Presupuesto de `npm run verify`: 4 minutos de tiempo real. Es un criterio, no una medición: un aumento que lo supere exige una decisión registrada.

### Cobertura de contratos (H13.5)

`docs/contracts/README.md` lista cada contrato con su estado. Los contratos sin prueba que ejerza su forma completa se listan ahí al cierre de cada épica.
