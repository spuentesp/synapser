/** Local, content-addressed storage for operator-supplied MCP server trees. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export type McpArtifactDigest = `sha256:${string}`;
export interface ImportedMcpArtifact {
  digest: McpArtifactDigest;
  /** Absolute path of the verified, read-only artifact directory. */
  path: string;
}

const FORMAT = Buffer.from("synapser-mcp-artifact-v1\0", "utf8");
const HEX_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TREE_BYTES = 128 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const WRITE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

interface TreeFile {
  relativePath: string;
  sourcePath: string;
  executable: boolean;
  bytes: Buffer;
}

function assertPlainDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`MCP artifact path is not a regular directory: ${path}`);
}

function readRegularFile(path: string): { bytes: Buffer; executable: boolean } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`MCP artifact contains a non-regular file: ${path}`);
  if (before.size > MAX_FILE_BYTES) throw new Error(`MCP artifact file exceeds the ${MAX_FILE_BYTES}-byte import limit`);
  const fd = openSync(path, READ_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`MCP artifact source changed while opening: ${path}`);
    }
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`MCP artifact source changed while reading: ${path}`);
    }
    return { bytes: Buffer.concat(chunks), executable: (opened.mode & 0o111) !== 0 };
  } finally {
    closeSync(fd);
  }
}

function collectTree(root: string): TreeFile[] {
  assertPlainDirectory(root);
  const files: TreeFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || entry.name.includes("\\") || entry.name.includes("\0")) {
        throw new Error(`MCP artifact contains an unsupported path component: ${entry.name}`);
      }
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (Buffer.byteLength(relativePath, "utf8") > MAX_PATH_BYTES) throw new Error("MCP artifact path exceeds the import limit");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`MCP artifact contains a symlink: ${relativePath}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        const file = readRegularFile(absolute);
        totalBytes += file.bytes.length;
        if (files.length >= MAX_FILES || totalBytes > MAX_TREE_BYTES) throw new Error("MCP artifact tree exceeds the import limits");
        files.push({ relativePath, sourcePath: absolute, executable: file.executable, bytes: file.bytes });
      } else throw new Error(`MCP artifact contains a special file: ${relativePath}`);
    }
  };
  visit(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath)));
  return files;
}

function digestTree(files: readonly TreeFile[]): McpArtifactDigest {
  const hash = createHash("sha256");
  hash.update(FORMAT);
  for (const file of files) {
    const name = Buffer.from(file.relativePath, "utf8");
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32BE(name.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(nameLength).update(name).update(Buffer.from([file.executable ? 1 : 0])).update(contentLength).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function artifactPath(root: string, digest: McpArtifactDigest): string {
  return join(root, digest.slice("sha256:".length));
}

function makeReadOnlyTree(root: string): void {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      makeReadOnlyTree(path);
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fchmodSync(fd, 0o555); } finally { closeSync(fd); }
    } else {
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fchmodSync(fd, (lstatSync(path).mode & 0o111) !== 0 ? 0o555 : 0o444); } finally { closeSync(fd); }
    }
  }
  const fd = openSync(root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fchmodSync(fd, 0o555); } finally { closeSync(fd); }
}

function makeDirectoriesWritable(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    makeDirectoriesWritable(path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  }
  const fd = openSync(root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}

/**
 * Import a local directory into `artifactRoot/<sha256>`, rejecting links and special files.
 * The source is scanned again after staging and the staged copy is independently re-hashed;
 * mutation during import therefore fails closed rather than pinning a mixed snapshot.
 */
export function importMcpArtifact(sourceDirectory: string, artifactRoot: string): ImportedMcpArtifact {
  const source = resolve(sourceDirectory);
  const root = resolve(artifactRoot);
  assertPlainDirectory(source);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPlainDirectory(root);
  chmodSync(root, 0o700);
  const staging = mkdtempSync(join(root, ".import-"));
  const stagedTree = join(staging, "tree");
  mkdirSync(stagedTree, { mode: 0o700 });
  try {
    const sourceFiles = collectTree(source);
    for (const file of sourceFiles) {
      const target = join(stagedTree, ...file.relativePath.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const mode = file.executable ? 0o755 : 0o644;
      const fd = openSync(target, WRITE_NOFOLLOW, mode);
      try {
        writeFileSync(fd, file.bytes);
        fchmodSync(fd, mode);
      } finally { closeSync(fd); }
    }

    const sourceDigest = digestTree(collectTree(source));
    const stagedDigest = digestTree(collectTree(stagedTree));
    if (sourceDigest !== stagedDigest) throw new Error("MCP artifact source changed during import; no artifact was pinned");

    const destination = artifactPath(root, stagedDigest);
    try {
      const existing = lstatSync(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Pinned MCP artifact path is not a regular directory");
      verifyMcpArtifact(root, stagedDigest);
      return { digest: stagedDigest, path: destination };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try { renameSync(stagedTree, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      verifyMcpArtifact(root, stagedDigest);
    }
    if (existsDirectory(destination)) makeReadOnlyTree(destination);
    return { digest: stagedDigest, path: destination };
  } finally {
    makeDirectoriesWritable(staging);
    rmSync(staging, { recursive: true, force: true });
  }
}

function existsDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); }
  catch { return false; }
}

/** Parent-facing concise alias for operator import flows. */
export const importArtifact = importMcpArtifact;

/** Verify the exact pinned tree and return its absolute directory for an immediate trusted use. */
export function verifyMcpArtifact(artifactRoot: string, pinnedDigest: string): string {
  if (!HEX_DIGEST.test(pinnedDigest)) throw new Error("MCP artifact digest must be a lowercase sha256 pin");
  const root = resolve(artifactRoot);
  const artifact = artifactPath(root, pinnedDigest as McpArtifactDigest);
  assertPlainDirectory(root);
  assertPlainDirectory(artifact);
  const actual = digestTree(collectTree(artifact));
  if (actual !== pinnedDigest) throw new Error(`MCP artifact digest mismatch: expected ${pinnedDigest}, found ${actual}`);
  return artifact;
}

/**
 * Copy a verified pin into a fresh destination for an isolated invocation. Existing destinations
 * are rejected; callers should use a per-run temporary path and remove it after the process exits.
 */
export function materializePinnedArtifact(storeRoot: string, pinnedDigest: string, destination: string): string {
  const verifiedSource = verifyMcpArtifact(storeRoot, pinnedDigest);
  const target = resolve(destination);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPlainDirectory(parent);
  try { lstatSync(target); throw new Error("MCP artifact materialization destination already exists"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = mkdtempSync(join(parent, ".mcp-materialize-"));
  const stagedTree = join(staging, "tree");
  mkdirSync(stagedTree, { mode: 0o700 });
  try {
    for (const file of collectTree(verifiedSource)) {
      const output = join(stagedTree, ...file.relativePath.split("/"));
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      const mode = file.executable ? 0o755 : 0o644;
      const fd = openSync(output, WRITE_NOFOLLOW, mode);
      try { writeFileSync(fd, file.bytes); fchmodSync(fd, mode); } finally { closeSync(fd); }
    }
    const stagedDigest = digestTree(collectTree(stagedTree));
    if (stagedDigest !== pinnedDigest) throw new Error(`MCP artifact changed while materializing: expected ${pinnedDigest}, found ${stagedDigest}`);
    renameSync(stagedTree, target);
    makeReadOnlyTree(target);
    return target;
  } finally {
    makeDirectoriesWritable(staging);
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Remove a materialized snapshot after its supervised MCP process has exited. */
export function removeMaterializedArtifact(path: string, invocationRoot: string): void {
  const target = resolve(path);
  const owner = resolve(invocationRoot);
  const tempRoot = resolve(tmpdir());
  const ownerRelative = relative(tempRoot, owner);
  if (dirname(target) !== owner || basename(target) !== "artifact" || ownerRelative.startsWith("..") || isAbsolute(ownerRelative) ||
    !basename(owner).startsWith("synapser-mcp-invocation-")) {
    throw new Error("refusing to remove a path outside the owned MCP invocation snapshot");
  }
  makeDirectoriesWritable(target);
  rmSync(target, { recursive: true, force: true });
}
