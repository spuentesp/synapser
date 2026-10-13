// G0: pinned real binary, version and SHA-256 recorded (design §17).
import { mkdirSync, writeFileSync } from "node:fs";
import { verifyBinary } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";

const pin = loadPin();
const id = await verifyBinary(pin);
mkdirSync("evidence", { recursive: true });
const record = { gate: "G0", at: new Date().toISOString(), commit: pin.commit, ...id };
writeFileSync("evidence/g0.json", JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
