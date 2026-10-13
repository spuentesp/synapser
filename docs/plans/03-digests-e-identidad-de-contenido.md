# Plan 03 — Digests e identidad de contenido

Todo lo que el sistema compara (vista leída, estado previo, resultado previsto, snapshot validado)
pasa por un único módulo `src/digest/`. Sin hashes ad hoc repartidos por el código.

## 1. Digest de archivo
- `sha256` sobre los **bytes crudos**, hex en minúscula, prefijo de algoritmo: `sha256:<64 hex>`.
- **Archivo ausente** es un valor distinto: `null` en el journal, `"absent"` en JSON. El hash de un
  archivo vacío (`sha256:e3b0c4…`) *no* significa "no existe". Mezclarlos permitiría tratar un
  `create` ya aplicado como un `replace` sobre vacío.
- Hash por streaming; tope MVP de **1 MiB por archivo** de acción (mayor → `REJECTED/FILE_TOO_LARGE`).
- Se registra también `mode` (bits `0o7777`). El digest de contenido no incluye el modo; el
  digest de *estado* sí (§3). Un parche que cambie el modo lo declara explícitamente.
- Zoanthrope calcula su propio fingerprint (mtime+size, sha256 ≤ 256 KiB). **No se reutiliza**: el
  ejecutor hashea siempre todos los bytes (diseño §12) y pasa su digest como `caller stamp`
  (`digest:<path>`) sólo para que un agente en espera vea qué fijó el titular.

## 2. `request_digest` (idempotencia)
`sha256(canonical_json({ task_id, plan_revision, expected_files, edits, declared_outputs }))`.
- **Excluye** `incarnation`, `action_id` y `run_id` (la clave ya los incluye; ver decisión 7 del índice).
- **Canonical JSON**: claves ordenadas por punto de código, sin espacios, UTF-8, enteros únicamente
  (se rechaza cualquier número no entero), cadenas sin sustitutos sueltos, arrays en el orden dado
  salvo `expected_files` y `declared_outputs` (conjuntos: se ordenan) y `edits` (se ordena por `path`
  conservando el orden relativo de las ediciones sobre una misma ruta, que es semántico).
- Misma clave + mismo digest → recibo o estado en curso. Misma clave + otro digest →
  `ACTION_ID_REUSED`; nunca se aplica.

## 3. Digest de estado de un conjunto de rutas (snapshot / alcance)
```
line(p)  = "<mode octal 4 dígitos> <sha256 hex|absent> <path>\n"
state_digest(P) = sha256( concat(line(p) for p in sort(P)) )
```
- Para el **alcance de una tarea**: P = rutas declaradas de su `scope_json` (las que existen o
  deberían existir). Sirve para invalidar una validación cuando cambia algo relevante (S11).
- Para la **misión**: P = todos los archivos regulares del árbol menos reservados
  (`.git`, `.zoanthrope`, `.synapser`, temporales `.synapser-tmp-*`). Es el digest de T4.
- Se calcula **sobre la copia**, no sobre el árbol vivo (S18): ver §5.

## 4. Predicción del resultado (`expected_after`)
En PREPARE el ejecutor ya tiene el contenido que el agente leyó (blob de `views`, identificado por
`before_digest`). Aplica `edits` en memoria y obtiene los bytes finales:

| Operación | Entrada | Efecto |
|---|---|---|
| `replace_exact` | `old` (debe aparecer exactamente 1 vez), `new` | sustitución textual |
| `write_file` | `content` completo | `replace` o `create` |
| `delete_file` | — | `after_digest = null` |

Reglas: UTF-8 válido salvo `write_file`; `old` ausente o ambiguo → `REJECTED/PATCH_DOES_NOT_APPLY`
(el agente corrige y reenvía; no se adivina). Se descarta `diff` unificado como formato de entrada
del agente: los modelos lo producen con desfase de contexto y el fallo sería indistinguible de
`STALE_VIEW`. Los codemods/tests que generen un diff real lo convierten a `write_file` en la copia
aislada (diseño §2), no se aplican con `patch`.

Resultado: `after_blob` + `after_digest`. **La recuperación no vuelve a aplicar edits**; sólo compara
disco con `before_digest`/`after_digest` y, si procede, escribe `after_blob`.

## 5. Snapshot consistente para validar (S11, S18)
1. Cerrar admisiones de escritura y **drenar**: ninguna acción en `CLAIMING..RELEASE_PENDING`.
2. Calcular `state_digest(live)` = D1.
3. Copiar el árbol (excluyendo reservados) al directorio de validación; calcular `state_digest(copy)` = D2.
   Si D1 ≠ D2 → la copia no es consistente: reintentar (sólo puede ocurrir por escritor externo).
4. Ejecutar el comando permitido sobre la copia. Guardar `validations(snapshot_digest = D2)`.
5. Al final recalcular `state_digest(live)`; si ≠ D2, el resultado se marca `valid=0` (el árbol
   cambió durante la prueba). Cualquier acción `APPLIED` posterior que toque el alcance invalida las
   validaciones cuyo `scope_digest` ya no coincide (S11) en la misma transacción que el `APPLIED`.

## Tests (día 17)
- Vectores fijos: vacío, ASCII, UTF-8 multibyte, binario con NUL; `absent` ≠ vacío.
- Canonical JSON: permutación de claves → mismo digest; float → error; `incarnation` distinta →
  mismo `request_digest`; un byte distinto en `edits` → digest distinto.
- `state_digest`: orden de entrada irrelevante; cambiar sólo el modo cambia el digest; renombrar una
  ruta lo cambia.
- Edits: `old` ausente, `old` duplicado, UTF-8 inválido, `create` sobre ruta existente → rechazos
  tipados y **ningún byte escrito**.
