// Serve the UI/API over an existing state directory (one subdirectory per run).
//   node scripts/serve.ts --state <dir> [--port 4173]
import { createApi } from "../src/api/server.ts";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] as string) : d;
};
const state = arg("state");
if (!state) {
  console.error("usage: node scripts/serve.ts --state <dir> [--port 4173]");
  process.exit(2);
}
const api = createApi({ stateDir: state });
const port = await api.listen(Number(arg("port", "4173")));
console.log(`Synapser UI → http://127.0.0.1:${port}/  (state: ${state})`);
