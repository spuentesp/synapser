// JSON-RPC 2.0 over newline-delimited stdio against the REAL zoanthrope binary
// (design §13, §3 "adaptador serializa llamadas"). One request in flight at a time.
//
// Timeout policy (S13): a timed-out call may or may not have mutated state. We
// SIGKILL the child and wait for its exit; only after exit is confirmed does the
// transport enter `quarantined`, and only an explicit `restart()` (which the
// adapter couples to state reconciliation) makes it usable again. If exit cannot
// be confirmed the transport is `halted`: the executor must pause.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ZooError, type WireRecord } from "./types.ts";

export type TransportState = "new" | "ready" | "quarantined" | "halted" | "closed";

export interface TransportOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  callTimeoutMs?: number; // default 10_000
  killGraceMs?: number; // default 3_000
  onWire?: (r: WireRecord) => void;
}

interface Pending {
  id: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ZooTransport {
  readonly #opts: Required<Omit<TransportOptions, "onWire" | "cwd" | "env">> &
    Pick<TransportOptions, "onWire" | "cwd" | "env">;
  #child: ChildProcessWithoutNullStreams | null = null;
  #exited: Promise<void> = Promise.resolve();
  #state: TransportState = "new";
  #nextId = 1;
  #pending: Pending | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #buf = "";
  #stderrTail = "";
  generation = 0; // increments on every (re)spawn

  constructor(opts: TransportOptions) {
    this.#opts = { callTimeoutMs: 10_000, killGraceMs: 3_000, ...opts };
  }

  get state(): TransportState {
    return this.#state;
  }
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** Spawn and perform the MCP handshake. Returns the `initialize` result. */
  async start(): Promise<unknown> {
    if (this.#state === "ready") throw new ZooError("MALFORMED", "already started");
    if (this.#state === "halted") throw new ZooError("HALTED", "previous child exit unconfirmed");
    this.#spawn();
    const init = await this.#rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synapser", version: "0.0.1" },
    });
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.#state = "ready";
    return init;
  }

  /** Send a request and await its response, strictly one at a time. */
  call(method: string, params: unknown): Promise<unknown> {
    if (this.#state !== "ready") {
      const kind = this.#state === "halted" ? "HALTED" : "QUARANTINED";
      return Promise.reject(new ZooError(kind, `transport is ${this.#state}; reconcile before calling`));
    }
    const run = () => {
      if (this.#state !== "ready") {
        throw new ZooError(this.#state === "halted" ? "HALTED" : "QUARANTINED", `transport is ${this.#state}`);
      }
      return this.#rpc(method, params);
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  /** Restart after quarantine. Fails if the previous child's exit was never confirmed. */
  async restart(): Promise<unknown> {
    if (this.#state === "halted") throw new ZooError("HALTED", "previous child exit unconfirmed");
    if (this.#state === "ready") await this.#killAndConfirm();
    if ((this.state as TransportState) === "halted") throw new ZooError("HALTED", "previous child exit unconfirmed");
    this.#state = "new";
    return this.start();
  }

  async stop(): Promise<void> {
    if (this.#state === "closed") return;
    await this.#killAndConfirm();
    if (this.#state !== "halted") this.#state = "closed";
  }

  // ---- internals -----------------------------------------------------

  #spawn(): void {
    this.generation++;
    this.#buf = "";
    this.#stderrTail = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#opts.command, this.#opts.args, {
        cwd: this.#opts.cwd,
        env: this.#opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      throw new ZooError("SPAWN_FAILED", String(e));
    }
    this.#child = child;
    this.#exited = new Promise<void>((res) => child.once("exit", () => res()));
    child.once("error", (e) => this.#failPending(new ZooError("SPAWN_FAILED", String(e))));
    child.once("exit", (code, sig) => {
      if (this.#child !== child) return;
      if (this.#state === "ready" || this.#state === "new") this.#state = "quarantined";
      this.#failPending(new ZooError("TRANSPORT_CLOSED", `child exited code=${code} signal=${sig}`, this.#stderrTail));
    });
    child.stdin.on("error", () => undefined); // EPIPE surfaces via exit/timeout
    child.stderr.on("data", (d: Buffer) => {
      this.#stderrTail = (this.#stderrTail + d.toString("utf8")).slice(-4096);
    });
    child.stdout.on("data", (d: Buffer) => this.#onData(d.toString("utf8")));
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 1);
      if (line.trim() === "") continue;
      this.#opts.onWire?.({ t: Date.now(), dir: "in", line });
      let msg: { id?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        this.#failPending(new ZooError("MALFORMED", "non-JSON line from server", line));
        continue;
      }
      const p = this.#pending;
      if (!p || msg.id !== p.id) continue; // unsolicited / stale: ignore, it is on the wire log
      clearTimeout(p.timer);
      this.#pending = null;
      if (msg.error) p.reject(new ZooError("JSONRPC_ERROR", `${msg.error.code} ${msg.error.message}`, msg.error));
      else p.resolve(msg.result);
    }
  }

  #write(obj: unknown): void {
    const line = JSON.stringify(obj);
    this.#opts.onWire?.({ t: Date.now(), dir: "out", line });
    this.#child?.stdin.write(line + "\n");
  }

  #rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#child) return reject(new ZooError("TRANSPORT_CLOSED", "no child process"));
      const id = this.#nextId++;
      const timer = setTimeout(() => void this.#onTimeout(id, method), this.#opts.callTimeoutMs);
      this.#pending = { id, resolve, reject, timer };
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async #onTimeout(id: number, method: string): Promise<void> {
    const p = this.#pending;
    if (!p || p.id !== id) return;
    this.#pending = null;
    // Quarantine first so nothing can be admitted while we confirm the exit.
    this.#state = "quarantined";
    await this.#killAndConfirm();
    p.reject(
      new ZooError(
        "TIMEOUT",
        `no response to ${method} in ${this.#opts.callTimeoutMs}ms; effect unknown, state is ${this.#state}`,
      ),
    );
  }

  async #killAndConfirm(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    const confirmed = await Promise.race([
      this.#exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), this.#opts.killGraceMs)),
    ]);
    if (!confirmed) this.#state = "halted";
    else if (this.#state === "ready") this.#state = "quarantined";
  }

  #failPending(err: Error): void {
    const p = this.#pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending = null;
    p.reject(err);
  }
}
