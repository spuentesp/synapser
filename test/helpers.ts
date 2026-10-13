import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZooAdapter } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";
import type { WireRecord } from "../src/zoo/types.ts";
import type { WorkspacePath } from "../src/workspace/paths.ts";

export function tempWorkspace(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synapser-ws-")));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

export async function openZoo(
  workspace: string,
  wire?: WireRecord[],
  env?: NodeJS.ProcessEnv,
): Promise<ZooAdapter> {
  return ZooAdapter.open(loadPin(), workspace, {
    onWire: wire ? (r) => wire.push(r) : undefined,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

/** Test-only: paths in these fixtures are literal and already contained. */
export const wp = (...p: string[]) => p as WorkspacePath[];
