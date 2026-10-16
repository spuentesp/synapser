// Skill injection is a runner boundary, not an adapter convenience. This module validates the
// frozen library payload, renders prompt injection and materialises adapter files without ever
// following a symlink out of either disposable root.

import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDigest, sha256Bytes } from "../digest/file.ts";
import type { AdapterDirectory, AdapterFile, AgentInvocation, InjectedSkill, InjectedSkills, SkillMechanism, SkillSelection } from "./adapter.ts";

export interface RecordedSkill {
  id: string;
  digest: string;
  mechanism: Exclude<SkillMechanism, "none">;
  reason?: string;
}

const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function validateInjectedSkills(injected: InjectedSkills, mechanism: SkillMechanism): RecordedSkill[] {
  if (injected.skills.length > 0 && mechanism === "none") throw new Error("adapter does not support skill injection");
  const seen = new Set<string>();
  return injected.skills.map((skill) => {
    if (skill.source !== "library") throw new Error(`skill ${JSON.stringify(skill.id)} is not from the library`);
    if (!SKILL_ID.test(skill.id)) throw new Error(`invalid skill id ${JSON.stringify(skill.id)}`);
    if (seen.has(skill.id)) throw new Error(`duplicate skill id ${JSON.stringify(skill.id)}`);
    seen.add(skill.id);
    if (!isDigest(skill.digest)) throw new Error(`skill ${skill.id} has an invalid digest`);
    const observed = sha256Bytes(Buffer.from(skill.content, "utf8"));
    if (observed !== skill.digest) throw new Error(`skill ${skill.id} digest does not match its content`);
    const reason = skill.selectionReason ?? "operator-default";
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 300) throw new Error(`skill ${skill.id} has an invalid selection reason`);
    return { id: skill.id, digest: skill.digest, mechanism: mechanism as Exclude<SkillMechanism, "none">, reason };
  });
}

/** A task may choose only from the operator-authorized snapshot. Missing required skills fail closed. */
export function selectAuthorizedSkills(authorized: readonly InjectedSkill[], selection?: readonly SkillSelection[]): InjectedSkill[] {
  if (selection === undefined) return authorized.map((skill) => ({ ...skill, selectionReason: skill.selectionReason ?? "operator-default" }));
  const byId = new Map(authorized.map((skill) => [skill.id, skill]));
  return selection.flatMap((choice) => {
    const skill = byId.get(choice.id);
    if (!skill) {
      if (choice.required) throw new Error(`required skill ${choice.id} is not operator-authorized for this profile`);
      return [];
    }
    return [{ ...skill, selectionReason: choice.reason }];
  });
}

export function skillFiles(skills: readonly InjectedSkill[], root: AdapterFile["root"], base: string): AdapterFile[] {
  return skills.map((skill) => ({ root, path: `${base}/${skill.id}/SKILL.md`, content: skill.content }));
}

export function prependSkills(prompt: string, skills: readonly InjectedSkill[]): string {
  if (skills.length === 0) return prompt;
  const rendered = skills.map((skill) => `## Skill: ${skill.id}\nDigest: ${skill.digest}\n\n${skill.content}`).join("\n\n");
  return `<synapser-skills>\n${rendered}\n</synapser-skills>\n\n${prompt}`;
}

/** Deliberate falsification boundary for L1: invalid provenance/digest is rejected before files exist. */
export function assertSkillPolicyUnchanged(baseline: AgentInvocation, candidate: AgentInvocation): void {
  const protectedFlags = new Set([
    "--allowedTools", "--disallowedTools", "--permission-mode", "--max-budget-usd", "-s", "--sandbox",
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "--yolo", "--plan",
  ]);
  const policy = (argv: readonly string[]) => argv.flatMap((arg, index) => {
    if (!protectedFlags.has(arg)) return [];
    const next = argv[index + 1];
    return [next && !next.startsWith("-") ? `${arg}=${next}` : arg];
  });
  if (JSON.stringify(policy(baseline.argv)) !== JSON.stringify(policy(candidate.argv))) {
    throw new Error("skill injection changed the adapter permission, sandbox or budget policy");
  }
}

export function materializeAdapterFiles(
  resetDirs: readonly AdapterDirectory[],
  files: readonly AdapterFile[],
  roots: { worktree: string; home: string },
): void {
  for (const dir of resetDirs) {
    const { target } = safeTarget(dir, roots);
    ensureDirectoryWithoutSymlinks(resolve(roots[dir.root]), dirname(target));
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`adapter reset target is not a safe directory: ${dir.path}`);
      rmSync(target, { recursive: true });
    }
    mkdirSync(target, { mode: 0o700 });
  }
  const targets = new Set<string>();
  for (const file of files) {
    const { root, target } = safeTarget(file, roots);
    if (targets.has(target)) throw new Error(`adapter returned duplicate file ${file.root}:${file.path}`);
    targets.add(target);
    ensureDirectoryWithoutSymlinks(root, dirname(target));
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`adapter file target is a symlink: ${file.path}`);
    writeFileSync(target, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}

function safeTarget(entry: AdapterFile | AdapterDirectory, roots: { worktree: string; home: string }): { root: string; target: string } {
  if (!entry.path || isAbsolute(entry.path) || entry.path.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new Error(`adapter returned unsafe path ${JSON.stringify(entry.path)}`);
  }
  const root = resolve(roots[entry.root]);
  const target = resolve(root, entry.path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`adapter path escapes ${entry.root}`);
  return { root, target };
}

function ensureDirectoryWithoutSymlinks(root: string, targetDir: string): void {
  const rel = relative(root, targetDir);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`adapter file parent is not a safe directory: ${cursor}`);
    } else {
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
}
