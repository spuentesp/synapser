// Versioned operator library. The _server journal is authoritative; state/library is a durable,
// human-inspectable projection that can always be reconstructed from hash-verified artifacts.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../digest/canonical.ts";
import { type Digest, isDigest, sha256Bytes } from "../digest/file.ts";
import { fsyncDir, writeFileDurable } from "../journal/artifacts.ts";
import type { EventRow, Journal } from "../journal/journal.ts";

export const LIBRARY_KINDS = ["providers", "skills", "templates", "agents"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export type LibraryDocument = Record<string, unknown>;

export interface LibraryEntry {
  kind: LibraryKind;
  id: string;
  digest: Digest;
  document: LibraryDocument;
  seq: number;
  actor: string;
}

const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export class LibraryStore {
  readonly root: string;
  readonly #journal: Journal;

  constructor(stateDir: string, serverJournal: Journal) {
    if (serverJournal.runId !== "_server") throw new Error("library changes must use the _server journal");
    this.root = join(stateDir, "library");
    this.#journal = serverJournal;
    mkdirSync(this.root, { recursive: true });
    this.sync();
  }

  put(kind: LibraryKind, id: string, document: LibraryDocument, actor: string): { entry: LibraryEntry; changed: boolean } {
    checkIdentity(kind, id, actor);
    if (!document || Array.isArray(document) || Object.getPrototypeOf(document) !== Object.prototype) throw new Error("library document must be a plain object");
    if (document["id"] !== undefined && document["id"] !== id) throw new Error(`document id does not match ${id}`);
    const normalized = { ...document, id };
    const bytes = Buffer.from(canonicalJson(normalized), "utf8");
    const digest = sha256Bytes(bytes);
    const current = this.get(kind, id);
    if (current?.digest === digest) {
      this.#materialize(current);
      return { entry: current, changed: false };
    }
    const blob = this.#journal.artifacts.put(bytes);
    let seq = 0;
    this.#journal.tx((tx) => {
      seq = tx.event("_server", "library_change", `${kind}:${id}`, current?.digest ?? null, "PUT", {
        kind, id, digest, blob, actor,
      });
    });
    const entry = { kind, id, digest, document: normalized, seq, actor };
    this.#materialize(entry);
    return { entry, changed: true };
  }

  remove(kind: LibraryKind, id: string, actor: string): boolean {
    checkIdentity(kind, id, actor);
    const current = this.get(kind, id);
    if (!current) {
      this.#removeCurrent(kind, id);
      return false;
    }
    this.#journal.tx((tx) => tx.event("_server", "library_change", `${kind}:${id}`, current.digest, "DELETE", {
      kind, id, digest: current.digest, actor,
    }));
    this.#removeCurrent(kind, id);
    return true;
  }

  get(kind: LibraryKind, id: string): LibraryEntry | null {
    checkKindAndId(kind, id);
    const event = this.#latest().get(`${kind}:${id}`);
    return event?.toState === "PUT" ? this.#entry(event) : null;
  }

  list(kind?: LibraryKind): LibraryEntry[] {
    if (kind !== undefined && !LIBRARY_KINDS.includes(kind)) throw new Error(`unknown library kind ${String(kind)}`);
    return [...this.#latest().values()]
      .filter((event) => event.toState === "PUT")
      .map((event) => this.#entry(event))
      .filter((entry) => kind === undefined || entry.kind === kind)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  history(kind: LibraryKind, id: string): { seq: number; operation: "PUT" | "DELETE"; digest: Digest; actor: string }[] {
    checkKindAndId(kind, id);
    return this.#events().filter((event) => event.entityId === `${kind}:${id}`).map((event) => {
      const data = event.data as Record<string, unknown>;
      return { seq: event.seq, operation: event.toState as "PUT" | "DELETE", digest: data["digest"] as Digest, actor: data["actor"] as string };
    });
  }

  /** Rebuild current files from the authoritative ledger; immutable versions are retained. */
  sync(): void {
    for (const event of this.#latest().values()) {
      const data = event.data as Record<string, unknown>;
      if (event.toState === "DELETE") this.#removeCurrent(data["kind"] as LibraryKind, data["id"] as string);
      else this.#materialize(this.#entry(event));
    }
  }

  #events(): EventRow[] {
    return this.#journal.listEvents().filter((event) => event.entity === "library_change");
  }

  #latest(): Map<string, EventRow> {
    const out = new Map<string, EventRow>();
    for (const event of this.#events()) if (event.toState === "DELETE" || event.toState === "PUT") out.set(event.entityId, event);
    return out;
  }

  #entry(event: EventRow): LibraryEntry {
    const data = event.data as Record<string, unknown>;
    const kind = data["kind"] as LibraryKind;
    const id = data["id"] as string;
    const digest = data["digest"];
    const blob = data["blob"];
    if (!LIBRARY_KINDS.includes(kind) || !ID.test(id) || !isDigest(digest) || !isDigest(blob)) throw new Error(`invalid library event at seq ${event.seq}`);
    const bytes = this.#journal.artifacts.get(blob);
    if (sha256Bytes(bytes) !== digest) throw new Error(`library digest mismatch at seq ${event.seq}`);
    const document = JSON.parse(bytes.toString("utf8")) as LibraryDocument;
    return { kind, id, digest, document, seq: event.seq, actor: String(data["actor"] ?? "") };
  }

  #materialize(entry: LibraryEntry): void {
    const base = join(this.root, entry.kind, entry.id);
    const hex = entry.digest.slice("sha256:".length);
    mkdirSync(join(base, "versions"), { recursive: true });
    const bytes = Buffer.from(canonicalJson(entry.document), "utf8");
    durableOnce(join(base, "versions", `${hex}.json`), bytes);
    durableReplace(join(base, "current.json"), bytes);
    if (entry.kind === "skills") {
      const content = entry.document["content"];
      if (typeof content !== "string") throw new Error(`skill ${entry.id} needs string content`);
      const versionDir = join(base, "versions", hex);
      mkdirSync(versionDir, { recursive: true });
      const meta = { ...entry.document, content: undefined, digest: entry.digest };
      delete meta.content;
      durableOnce(join(versionDir, "SKILL.md"), Buffer.from(content, "utf8"));
      durableOnce(join(versionDir, "meta.json"), Buffer.from(canonicalJson(meta), "utf8"));
      durableReplace(join(base, "SKILL.md"), Buffer.from(content, "utf8"));
      durableReplace(join(base, "meta.json"), Buffer.from(canonicalJson(meta), "utf8"));
    }
  }

  #removeCurrent(kind: LibraryKind, id: string): void {
    const base = join(this.root, kind, id);
    for (const name of ["current.json", ...(kind === "skills" ? ["SKILL.md", "meta.json"] : [])]) {
      const path = join(base, name);
      if (existsSync(path)) unlinkSync(path);
    }
    if (existsSync(base)) fsyncDir(base);
  }
}

function checkIdentity(kind: LibraryKind, id: string, actor: string): void {
  checkKindAndId(kind, id);
  if (!actor.trim() || actor.length > 128) throw new Error("library actor is required");
}

function checkKindAndId(kind: LibraryKind, id: string): void {
  if (!LIBRARY_KINDS.includes(kind)) throw new Error(`unknown library kind ${String(kind)}`);
  if (!ID.test(id)) throw new Error(`invalid library id ${JSON.stringify(id)}`);
}

function durableOnce(path: string, bytes: Uint8Array): void {
  if (existsSync(path) && readFileSync(path).equals(Buffer.from(bytes))) return;
  writeFileDurable(path, bytes, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function durableReplace(path: string, bytes: Uint8Array): void {
  writeFileDurable(path, bytes, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
