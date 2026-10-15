// Plan 18 E10 (H10.4): runs TLC on the formal models. The tools jar is not in the repository; it is pinned by digest in
// formal/tla2tools.sha256 and read from SYNAPSER_TLA_JAR or the user's cache. The check fails on a wrong digest, on any
// counterexample, and on a run that does not finish.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const jar = process.env["SYNAPSER_TLA_JAR"] ?? join(homedir(), ".cache", "synapser-tools", "tla2tools.jar");
if (!existsSync(jar)) {
  console.error(`✖ no TLA+ tools at ${jar} (set SYNAPSER_TLA_JAR)`);
  process.exit(1);
}
const pinned = readFileSync(new URL("../formal/tla2tools.sha256", import.meta.url), "utf8").split(/\s+/)[0];
const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (actual !== pinned) {
  console.error(`✖ tla2tools digest ${actual.slice(0, 12)}… does not match the pin ${pinned.slice(0, 12)}…`);
  process.exit(1);
}
const formal = new URL("../formal/", import.meta.url);
const r = spawnSync("java", ["-cp", jar, "tlc2.TLC", "-workers", "1", "-deadlock", "-config", "JournalLock.cfg", "JournalLock.tla"], { cwd: formal.pathname, encoding: "utf8" });
const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
if (r.status !== 0 || !out.includes("Model checking completed. No error has been found.")) {
  console.error(out.split("\n").filter((l) => /Error|violated|counter/i.test(l)).slice(0, 10).join("\n") || "✖ TLC did not finish");
  console.error("✖ formal check failed");
  process.exit(1);
}
console.log("✔ JournalLock: MutualExclusion and EventualEntry hold under the stated fairness");
