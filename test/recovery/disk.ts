import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { WorkspaceDurability } from "../../src/executor/fs-applier.ts";
import { NODE_WORKSPACE_DURABILITY } from "../../src/executor/fs-applier.ts";

/** Test-only disk model with distinct durable inode contents and directory entries. */
export function simulatedWorkspaceDurability(workspace: string, durableSnapshot: string, fault: string, tracePath: string): WorkspaceDurability {
  let fileSyncs = 0;
  let directorySyncs = 0;
  const durableInodes = new Map<string, { bytes: Buffer; mode: number }>();
  const inodeId = (path: string) => {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}`;
  };
  const regularFiles = (root: string) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => relative(root, join(d.parentPath, d.name)))
      .filter((rel) => rel !== ".zoanthrope" && !rel.startsWith(`.zoanthrope${sep}`));
  const persistDirectory = (syncedDirectory: string) => {
    const relativeDirectory = relative(workspace, syncedDirectory);
    const sourceDirectory = relativeDirectory ? join(workspace, relativeDirectory) : workspace;
    const durableDirectory = relativeDirectory ? join(durableSnapshot, relativeDirectory) : durableSnapshot;
    const previous = new Map(regularFiles(durableDirectory).map((rel) => [rel, {
      bytes: readFileSync(join(durableDirectory, rel)),
      mode: statSync(join(durableDirectory, rel)).mode & 0o777,
    }]));
    mkdirSync(dirname(durableDirectory), { recursive: true });
    rmSync(durableDirectory, { recursive: true, force: true });
    cpSync(sourceDirectory, durableDirectory, { recursive: true, force: true });
    for (const rel of regularFiles(durableDirectory)) {
      const source = join(sourceDirectory, rel);
      const target = join(durableDirectory, rel);
      const durable = durableInodes.get(inodeId(source));
      const old = previous.get(rel);
      if (durable) {
        writeFileSync(target, durable.bytes);
        chmodSync(target, durable.mode);
      } else if (old) {
        writeFileSync(target, old.bytes);
        chmodSync(target, old.mode);
      } else {
        // The directory entry is durable but the inode has no durable data image; model the
        // resulting file as empty rather than accidentally preserving page-cache contents.
        writeFileSync(target, Buffer.alloc(0));
        chmodSync(target, 0o600);
      }
    }
  };
  return {
    syncFile(fd, path) {
      fileSyncs++;
      if (fault === `file:${fileSyncs}`) {
        appendFileSync(tracePath, `file:${fileSyncs}:lost:${path}\n`);
        return;
      }
      NODE_WORKSPACE_DURABILITY.syncFile(fd, path);
      durableInodes.set(inodeId(path), { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 });
      appendFileSync(tracePath, `file:${fileSyncs}:durable:${path}\n`);
    },
    syncDirectory(path) {
      directorySyncs++;
      if (fault === `directory:${directorySyncs}`) {
        appendFileSync(tracePath, `directory:${directorySyncs}:lost:${path}\n`);
        return;
      }
      NODE_WORKSPACE_DURABILITY.syncDirectory(path);
      persistDirectory(path);
      appendFileSync(tracePath, `directory:${directorySyncs}:durable:${path}\n`);
    },
  };
}

export function restoreDurableWorkspace(workspace: string, durableSnapshot: string): void {
  if (!existsSync(durableSnapshot)) throw new Error(`durable snapshot missing: ${durableSnapshot}`);
  for (const name of readdirSync(workspace)) {
    if (name !== ".zoanthrope") rmSync(join(workspace, name), { recursive: true, force: true });
  }
  copyWorkspaceSnapshot(durableSnapshot, workspace);
}

export function copyWorkspaceSnapshot(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (path) => {
      const rel = relative(source, path);
      return rel === "" || (basename(rel) !== ".zoanthrope" && !rel.startsWith(`.zoanthrope${sep}`));
    },
  });
}
