// A stand-in agent CLI for tests: behaves like a one-shot tool that edits its cwd and prints
// codex-style JSONL. First arg = behavior, second = prompt (ignored).
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const ok = (text = "done") => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 } }));
};

switch (mode) {
  case "write":
    writeFileSync("app/new_mod.py", "x = 1\n");
    appendFileSync("README.md", "\nmore docs\n");
    unlinkSync("tests/test_basic.py");
    ok("wrote files");
    break;
  case "edit-schema":
    appendFileSync("app/schema.py", "\n# edited by the agent\n");
    ok();
    break;
  case "slow-edit-schema":
    await new Promise((r) => setTimeout(r, 500));
    appendFileSync("app/schema.py", "\n# edited by the agent\n");
    ok();
    break;
  case "noop":
    ok("reviewed; nothing to change");
    break;
  case "edit-readme":
    appendFileSync("README.md", "\nrelease notes\n");
    ok();
    break;
  case "edit-client":
    appendFileSync("app/client.py", "\n# client edit\n");
    ok();
    break;
  case "outside-scope":
    appendFileSync("app/schema.py", "\n# in scope\n");
    writeFileSync("secrets.txt", "not allowed\n");
    ok();
    break;
  case "binary":
    writeFileSync("blob.bin", Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    ok();
    break;
  case "metadata":
    mkdirSync(".claude", { recursive: true });
    writeFileSync(".claude/session.json", "{}");
    writeFileSync("app/real.py", "y = 2\n");
    ok();
    break;
  case "error-exit0":
    console.log(JSON.stringify({ type: "error", sessionID: "s1", error: { name: "APIError", data: { message: "Insufficient account balance", statusCode: 402 } } }));
    break; // exit code 0 on purpose
  case "env":
    writeFileSync("env.txt", JSON.stringify(process.env));
    ok();
    break;
  case "hang":
    setTimeout(() => ok(), 60_000);
    break;
  default:
    console.error("unknown mode", mode);
    process.exit(2);
}
