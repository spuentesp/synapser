import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, test } from "node:test";
import { env, seededRandom, withEnv } from "../../src/sim/env.ts";

// Plan 18 E11 (H11.1, H11.3). H11.1: the recovery core takes time, randomness and identifiers only from src/sim/env.ts.
// H11.3: a simulated environment with a seed reproduces the same values, so a failing sequence can be replayed.
const CORE = ["journal", "executor", "recovery"];
// A reference counts as much as a call: `opts.now ?? Date.now` takes the real clock just as `Date.now()` does.
const FORBIDDEN = [/Date\.now\b/, /new Date\(\)/, /Math\.random\b/, /randomUUID\b/, /randomBytes\b/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

describe("H11.1 the recovery core reads no clock or randomness of its own", () => {
  test("no direct call in journal, executor or recovery", () => {
    const offenders: string[] = [];
    for (const area of CORE) {
      for (const file of files(new URL(`../../src/${area}`, import.meta.url).pathname)) {
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (FORBIDDEN.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}`);
        });
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe("H11.3 a seeded environment reproduces the same values", () => {
  const sample = () =>
    withEnv({ now: () => 1_000, random: seededRandom(7), uuid: () => `u-${Math.floor(seededRandom(9)() * 1e9)}` }, () => [env.now(), env.random(), env.random(), env.uuid()]);

  test("the same seed gives the same sequence, and another seed does not", () => {
    assert.deepEqual(sample(), sample());
    const other = withEnv({ random: seededRandom(8) }, () => [env.random(), env.random()]);
    assert.notDeepEqual(other, withEnv({ random: seededRandom(7) }, () => [env.random(), env.random()]));
  });

  test("outside withEnv the real system is in charge again", () => {
    withEnv({ now: () => 5 }, () => assert.equal(env.now(), 5));
    assert.notEqual(env.now(), 5);
  });
});
