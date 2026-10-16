import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalFuturePath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(ancestor);
      return resolve(realpathSync(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
  }
}

export function resolveExternalDirectory(rootPath: string, configuredPath: string, name: string): string {
  if (!isAbsolute(configuredPath)) throw new Error(`${name} must be an absolute path`);
  const root = realpathSync(rootPath);
  const requested = resolve(configuredPath);
  const physical = canonicalFuturePath(requested);
  if (physical !== requested) throw new Error(`${name} must not traverse symlinks`);
  if (isWithin(root, physical)) throw new Error(`${name} must be outside the repository`);
  return physical;
}

export function resolveEvidenceRoot(rootPath: string, configuredPath: string | undefined): string {
  if (configuredPath === undefined) return resolve(rootPath, "evidence");
  return resolveExternalDirectory(rootPath, configuredPath, "SYNAPSER_EVIDENCE_DIR");
}
