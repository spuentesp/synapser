// Effect kinds (plan 13 §5.3): the side effects an agent may ASK for and Synapser — never the agent —
// performs. Each kind computes, from the REAL world, a human-readable summary and a digest binding the
// approval to the exact thing that will happen; at execution time it is recomputed, so an approval
// cannot be spent on anything else (G2).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { digestOfJson } from "../digest/canonical.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, timeout: o.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface KindCtx {
  repoRoot: string;
  exec: Exec;
  /** The BROKER's environment (the user's credentials live here, never in an agent). */
  env: NodeJS.ProcessEnv;
  identity: { name: string; email: string };
  fetch?: typeof fetch;
}

export interface Prepared {
  /** What the approval is bound to. Hashed into the effect digest. */
  material: Record<string, unknown>;
  /** Computed by Synapser from the real world; the agent's own description never enters here. */
  summary: string;
  details: Record<string, unknown>;
}

export class EffectFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EffectFailure";
    this.code = code;
  }
}

export interface EffectKind {
  readonly kind: string;
  validate(params: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; errors: string[] };
  prepare(params: Record<string, unknown>, ctx: KindCtx): Promise<Prepared>;
  execute(params: Record<string, unknown>, prepared: Prepared, ctx: KindCtx): Promise<Record<string, unknown>>;
}

export const effectDigest = (kind: string, prepared: Prepared): string => digestOfJson(JSON.parse(JSON.stringify({ kind, ...prepared.material })));

/** Synapser's own working files and caches are never part of a change set. */
const OWN = [":(exclude).zoanthrope", ":(exclude).synapser", ":(exclude).synapser-state", ":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/.synapser-tmp-*"];

const SENSITIVE = /(^|\/)(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|p12|pfx|key)|\.npmrc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml))$/i;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const str = (v: unknown, max = 300): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

async function git(ctx: KindCtx, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return ctx.exec("git", args, { cwd: ctx.repoRoot, env: ctx.env, timeoutMs });
}
async function must(ctx: KindCtx, args: string[], what: string): Promise<string> {
  const r = await git(ctx, args);
  if (r.code !== 0) throw new EffectFailure("GIT_FAILED", `${what}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout.trim();
}

// ---- git.commit ------------------------------------------------------------------------------------

const gitCommit: EffectKind = {
  kind: "git.commit",
  validate(p) {
    const x = p as { message?: unknown; branch?: unknown; paths?: unknown } | null;
    const errors: string[] = [];
    if (!x || !str(x.message, 500)) errors.push("message is required (≤500 chars)");
    if (x?.branch !== undefined && (!str(x.branch, 100) || !BRANCH.test(x.branch))) errors.push("branch is not a valid branch name");
    if (x?.paths !== undefined && (!Array.isArray(x.paths) || x.paths.some((q) => !str(q, 300) || q.startsWith("/") || q.includes("..")))) errors.push("paths must be repository-relative");
    return errors.length ? { ok: false, errors } : { ok: true, params: { message: x!.message as string, ...(x!.branch ? { branch: x!.branch as string } : {}), ...(x!.paths ? { paths: x!.paths as string[] } : {}) } };
  },
  async prepare(params, ctx) {
    const paths = (params["paths"] as string[] | undefined) ?? [];
    const cur = await must(ctx, ["rev-parse", "--abbrev-ref", "HEAD"], "current branch");
    const branch = (params["branch"] as string | undefined) ?? cur;
    // NOT trimmed: porcelain v1 starts with a status column that may be a space (" M path")
    const stRaw = await git(ctx, ["status", "--porcelain=v1", "-z", "--", ...(paths.length ? paths : ["."]), ...OWN]);
    if (stRaw.code !== 0) throw new EffectFailure("GIT_FAILED", `status: ${(stRaw.stderr || stRaw.stdout).trim().slice(0, 300)}`);
    const st = stRaw.stdout;
    const files = st
      .split("\0")
      .filter(Boolean)
      .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
    if (files.length === 0) throw new EffectFailure("NOTHING_TO_COMMIT", "the working tree has no changes to commit");
    const sensitive = files.filter((f) => SENSITIVE.test(f.path));
    if (sensitive.length) throw new EffectFailure("SENSITIVE_PATH", `refusing to commit credential-looking files: ${sensitive.map((f) => f.path).join(", ")}`);
    const entries: { path: string; status: string; hash: string }[] = [];
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const h = await git(ctx, ["hash-object", "--", f.path]);
      entries.push({ path: f.path, status: f.status, hash: h.code === 0 ? h.stdout.trim() : "deleted" });
    }
    const head = (await git(ctx, ["rev-parse", "HEAD"])).stdout.trim();
    return {
      material: { branch, message: params["message"], base_head: head, files: entries },
      summary: `Commit ${entries.length} file(s) on branch "${branch}": "${String(params["message"]).slice(0, 120)}" — ${entries.map((e) => `${e.status} ${e.path}`).join(", ").slice(0, 400)}`,
      details: { branch, files: entries, base_head: head },
    };
  },
  async execute(params, prepared, ctx) {
    const branch = String(prepared.material["branch"]);
    const cur = await must(ctx, ["rev-parse", "--abbrev-ref", "HEAD"], "current branch");
    if (cur !== branch) {
      const exists = (await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      await must(ctx, exists ? ["switch", branch] : ["switch", "-c", branch], `switch to ${branch}`);
    }
    const paths = (params["paths"] as string[] | undefined) ?? [];
    await must(ctx, ["add", "-A", "--", ...(paths.length ? paths : ["."]), ...OWN], "stage");
    await must(
      ctx,
      ["-c", `user.name=${ctx.identity.name}`, "-c", `user.email=${ctx.identity.email}`, "commit", "-q", "-m", String(params["message"])],
      "commit",
    );
    const sha = await must(ctx, ["rev-parse", "HEAD"], "resulting commit");
    return { commit: sha, branch };
  },
};

// ---- git.push --------------------------------------------------------------------------------------

const gitPush: EffectKind = {
  kind: "git.push",
  validate(p) {
    const x = p as { remote?: unknown; branch?: unknown; force?: unknown } | null;
    const errors: string[] = [];
    const remote = x?.remote ?? "origin";
    if (!str(remote, 60) || !/^[A-Za-z0-9._-]+$/.test(remote)) errors.push("remote must be a configured remote name");
    if (!x || !str(x.branch, 100) || !BRANCH.test(x.branch)) errors.push("branch is required and must be a valid branch name");
    if (x?.force !== undefined && typeof x.force !== "boolean") errors.push("force must be a boolean");
    return errors.length ? { ok: false, errors } : { ok: true, params: { remote: remote as string, branch: x!.branch as string, force: x!.force === true } };
  },
  async prepare(params, ctx) {
    const remote = String(params["remote"]);
    const branch = String(params["branch"]);
    const url = (await git(ctx, ["remote", "get-url", remote]));
    if (url.code !== 0) throw new EffectFailure("NO_SUCH_REMOTE", `remote "${remote}" is not configured`);
    const head = await must(ctx, ["rev-parse", "HEAD"], "HEAD");
    const remoteRef = await git(ctx, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], 30_000);
    const remoteTip = remoteRef.code === 0 ? (remoteRef.stdout.split(/\s+/)[0] ?? "") : "";
    const range = remoteTip ? `${remoteTip}..${head}` : `-n20 ${head}`;
    const log = await git(ctx, ["log", "--format=%h %s", ...range.split(" ")], 30_000);
    const commits = log.stdout.trim().split("\n").filter(Boolean);
    const files = remoteTip ? (await git(ctx, ["diff", "--stat", "--format=", `${remoteTip}..${head}`])).stdout.trim().split("\n").filter(Boolean) : [];
    return {
      material: { remote, remote_url: url.stdout.trim(), branch, head_sha: head, remote_tip: remoteTip || null, force: params["force"] === true },
      summary: `${params["force"] === true ? "FORCE " : ""}push ${head.slice(0, 10)} to ${remote}/${branch} (${url.stdout.trim()}): ${commits.length} commit(s)${commits.length ? ` — ${commits.slice(0, 5).join(" | ")}` : ""}${remoteTip ? "" : " [branch does not exist remotely yet]"}`,
      details: { remote, url: url.stdout.trim(), branch, head, remote_tip: remoteTip || null, commits, files },
    };
  },
  async execute(params, prepared, ctx) {
    const remote = String(params["remote"]);
    const branch = String(params["branch"]);
    const sha = String(prepared.material["head_sha"]);
    const r = await git(ctx, ["push", ...(params["force"] === true ? ["--force-with-lease"] : []), remote, `${sha}:refs/heads/${branch}`], 120_000);
    if (r.code !== 0) throw new EffectFailure("PUSH_FAILED", (r.stderr || r.stdout).trim().slice(0, 400));
    // postcondition: the remote now has EXACTLY what was approved
    const ls = await git(ctx, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], 30_000);
    const tip = ls.stdout.split(/\s+/)[0] ?? "";
    if (tip !== sha) throw new EffectFailure("POSTCONDITION", `remote ${remote}/${branch} is at ${tip || "(absent)"}, expected ${sha}`);
    return { remote, branch, pushed: sha, remote_tip: tip };
  },
};

// ---- gh.pr -----------------------------------------------------------------------------------------

const ghPr: EffectKind = {
  kind: "gh.pr",
  validate(p) {
    const x = p as { title?: unknown; body?: unknown; base?: unknown; head?: unknown } | null;
    const errors: string[] = [];
    if (!x || !str(x.title, 200)) errors.push("title is required");
    if (x?.body !== undefined && (typeof x.body !== "string" || x.body.length > 5000)) errors.push("body must be a string ≤5000");
    if (!x || !str(x.base, 100) || !BRANCH.test(x.base)) errors.push("base is required");
    if (!x || !str(x.head, 100) || !BRANCH.test(x.head)) errors.push("head is required");
    return errors.length ? { ok: false, errors } : { ok: true, params: { title: x!.title as string, body: (x!.body as string | undefined) ?? "", base: x!.base as string, head: x!.head as string } };
  },
  async prepare(params) {
    const bodyHash = createHash("sha256").update(String(params["body"])).digest("hex").slice(0, 16);
    return {
      material: { title: params["title"], body_sha: bodyHash, base: params["base"], head: params["head"] },
      summary: `Open a pull request "${String(params["title"]).slice(0, 120)}": ${String(params["head"])} → ${String(params["base"])} (body ${String(params["body"]).length} chars)`,
      details: { title: params["title"], base: params["base"], head: params["head"] },
    };
  },
  async execute(params, _p, ctx) {
    const r = await ctx.exec("gh", ["pr", "create", "--title", String(params["title"]), "--body", String(params["body"]), "--base", String(params["base"]), "--head", String(params["head"])], { cwd: ctx.repoRoot, env: ctx.env, timeoutMs: 60_000 });
    if (r.code !== 0) throw new EffectFailure("GH_FAILED", (r.stderr || r.stdout).trim().slice(0, 300));
    const url = r.stdout.trim().split("\n").at(-1) ?? "";
    if (!/^https:\/\//.test(url)) throw new EffectFailure("POSTCONDITION", `gh did not return a pull request URL: ${url.slice(0, 120)}`);
    return { url };
  },
};

// ---- http.request ----------------------------------------------------------------------------------

const httpRequest: EffectKind = {
  kind: "http.request",
  validate(p) {
    const x = p as { method?: unknown; url?: unknown; body?: unknown } | null;
    const errors: string[] = [];
    if (!x || !["POST", "PUT", "PATCH", "DELETE"].includes(String(x.method))) errors.push("method must be POST, PUT, PATCH or DELETE (reads are not effects)");
    let u: URL | null = null;
    try {
      u = new URL(String(x?.url));
    } catch {
      errors.push("url must be an absolute URL");
    }
    if (u && u.protocol !== "https:" && u.protocol !== "http:") errors.push("url must be http(s)");
    if (u && (u.username || u.password)) errors.push("credentials in the URL are not allowed");
    if (x?.body !== undefined && (typeof x.body !== "string" || x.body.length > 20_000)) errors.push("body must be a string ≤20000");
    return errors.length ? { ok: false, errors } : { ok: true, params: { method: x!.method as string, url: u!.toString(), body: (x!.body as string | undefined) ?? "" } };
  },
  async prepare(params) {
    const u = new URL(String(params["url"]));
    const bodySha = createHash("sha256").update(String(params["body"])).digest("hex").slice(0, 16);
    return {
      material: { method: params["method"], url: u.toString(), body_sha: bodySha },
      summary: `${String(params["method"])} ${u.host}${u.pathname} (${String(params["body"]).length}-char body, sha ${bodySha})`,
      details: { host: u.host, path: u.pathname },
    };
  },
  async execute(params, _p, ctx) {
    const f = ctx.fetch ?? fetch;
    const res = await f(String(params["url"]), { method: String(params["method"]), body: String(params["body"]) || null, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new EffectFailure("HTTP_FAILED", `HTTP ${res.status}`);
    return { status: res.status };
  },
};

export const BUILTIN_KINDS: readonly EffectKind[] = [gitCommit, gitPush, ghPr, httpRequest];
