// Helper process for cross-process journal/lock tests. Usage: node journal-child.ts <mode> <args…>
import { Journal } from "../../src/journal/journal.ts";
import { acquireWorkspaceLock, LockBusy } from "../../src/journal/lock.ts";

const [mode, stateDir, ws, runId, actionId] = process.argv.slice(2) as string[];
if (mode === "hold-lock") {
  const lock = acquireWorkspaceLock(stateDir!, ws!);
  console.log(`HELD generation=${lock.generation}`);
  process.stdin.resume(); // stay alive until killed
} else if (mode === "try-lock") {
  try {
    const lock = acquireWorkspaceLock(stateDir!, ws!);
    console.log(`ACQUIRED generation=${lock.generation}`);
    lock.release();
  } catch (e) {
    console.log(e instanceof LockBusy ? "BUSY" : `ERROR ${String(e)}`);
  }
} else if (mode === "cas") {
  const j = Journal.open(stateDir!, runId!);
  try {
    j.tx((t) => t.transition(runId!, actionId!, "PREPARED", "CLAIMING"));
    console.log("WON");
  } catch (e) {
    console.log(`LOST ${(e as Error).name}`);
  }
  j.close();
}
