import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// Plan 18 E7: a client that speaks only the MCP protocol over stdio. Shared by the end-to-end tests.
const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;

export class StdioClient {
  readonly #child: ChildProcessWithoutNullStreams;
  #buf = "";
  readonly #waiting = new Map<number, (m: Record<string, unknown>) => void>();
  #id = 0;
  constructor(cwd: string, args: string[] = ["mcp"], env: Record<string, string> = {}) {
    this.#child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buf += chunk;
      for (let i = this.#buf.indexOf("\n"); i >= 0; i = this.#buf.indexOf("\n")) {
        const line = this.#buf.slice(0, i).trim();
        this.#buf = this.#buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const resolve = this.#waiting.get(msg["id"] as number);
        if (resolve) {
          this.#waiting.delete(msg["id"] as number);
          resolve(msg);
        }
      }
    });
  }
  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 20 s`)), 20_000);
      this.#waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }
  notify(method: string): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
  async close(): Promise<number | null> {
    this.#child.stdin.end();
    return new Promise((resolve) => this.#child.on("exit", (code) => resolve(code)));
  }
}
