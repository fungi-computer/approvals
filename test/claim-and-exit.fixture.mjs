import process from "node:process";
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { ApprovalLedger } from "../dist/index.js";

const ledger = new ApprovalLedger({
  owner: fromNodeSqlite(new DatabaseSync(process.argv[2])),
  home: { kind: "team", id: "team:one" },
  now: () => 10,
});
const staged = await ledger.request(JSON.parse(process.argv[3]));
if (staged.kind !== "record") throw new Error(staged.reason);
ledger.answer(
  {
    recordId: staged.record.recordId,
    decision: "approve",
    expectedRevision: 1,
  },
  {
    kind: "human",
    memberId: "member:owner",
    role: "owner",
    actingForAgent: false,
    mayUseOperation: true,
  },
);
writeSync(1, staged.record.recordId);
await ledger.apply(staged.record.recordId, {
  recheck: () =>
    Promise.resolve({
      kind: "authorized",
      authorityFence: "grant-generation:1",
    }),
  // A real process exit after claim: no finally/catch or in-memory state survives.
  dispatch: () => process.exit(0),
});
