// Workspace containment (design §14, S10/S15). Zoanthrope accepts absolute
// paths outside the workspace as claim keys, so containment is enforced HERE,
// before any claim. `WorkspacePath` can only be produced by `resolveInWorkspace`,
// which makes "claimed an unchecked path" a compile-time error in the adapter.

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

declare const brand: unique symbol;
/** Workspace-relative, POSIX-separated, contained, non-reserved path. */
export type WorkspacePath = string & { readonly [brand]: "WorkspacePath" };

export type PathErrorCode =
  | "EMPTY"
  | "NUL_BYTE"
  | "OUTSIDE_WORKSPACE"
  | "RESERVED"
  | "SYMLINK"
  | "NOT_A_FILE";

export class PathRejected extends Error {
  readonly code: PathErrorCode;
  readonly input: string;
  constructor(code: PathErrorCode, input: string, detail?: string) {
    super(`path rejected (${code}): ${JSON.stringify(input)}${detail ? ` — ${detail}` : ""}`);
    this.name = "PathRejected";
    this.code = code;
    this.input = input;
  }
}

/** Top-level names no agent action may touch. Journal dir is added by the caller. */
export const DEFAULT_RESERVED = [".git", ".zoanthrope", ".synapser"] as const;
/** Temp files of in-flight actions; an agent must never address one. */
export const TMP_PREFIX = ".synapser-tmp-";

export interface ResolveOptions {
  reserved?: readonly string[];
  /** Existing files must be regular files (default true). Missing files are allowed (new files). */
  requireRegularIfExists?: boolean;
}

/**
 * Canonicalize `input` against `workspaceRoot` and reject anything that escapes it,
 * touches a reserved top-level name, or passes through a symlink (MVP: no symlinks).
 * The workspace root itself must already be a real directory path.
 */
export function resolveInWorkspace(
  workspaceRoot: string,
  input: string,
  opts: ResolveOptions = {},
): WorkspacePath {
  if (input.length === 0) throw new PathRejected("EMPTY", input);
  if (input.includes("\0")) throw new PathRejected("NUL_BYTE", input);

  const root = realpathSync(workspaceRoot);
  const abs = resolve(root, input);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathRejected("OUTSIDE_WORKSPACE", input);
  }
  const parts = rel.split(sep);
  const reserved = opts.reserved ?? DEFAULT_RESERVED;
  if (parts.some((p) => reserved.includes(p) || p.startsWith(TMP_PREFIX))) throw new PathRejected("RESERVED", input);

  // Walk every component: no symlinks anywhere on the path (parents included).
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i] as string);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break; // new file/dir: nothing further to check
      throw e;
    }
    if (st.isSymbolicLink()) throw new PathRejected("SYMLINK", input, parts.slice(0, i + 1).join("/"));
    const last = i === parts.length - 1;
    if (last && (opts.requireRegularIfExists ?? true) && !st.isFile()) {
      throw new PathRejected("NOT_A_FILE", input);
    }
  }
  return parts.join("/") as WorkspacePath;
}

/** Resolve a whole set; returns a stable, de-duplicated, sorted list (trace-friendly, design §14). */
export function resolveSet(
  workspaceRoot: string,
  inputs: readonly string[],
  opts?: ResolveOptions,
): WorkspacePath[] {
  const out = new Set<WorkspacePath>();
  for (const p of inputs) out.add(resolveInWorkspace(workspaceRoot, p, opts));
  return [...out].sort();
}
