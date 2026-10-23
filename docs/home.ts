import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { ApprovalLedger } from "@fungi.computer/approvals";

const database = new DatabaseSync(":memory:");
try {
  const ledger = new ApprovalLedger({
    owner: fromNodeSqlite(database),
    home: { kind: "team", id: "example-team" },
    now: Date.now,
  });
  const staged = await ledger.request({
    requester: {
      principalId: "agent:example",
      agentId: "example-agent",
      sessionId: "example-session",
      displayName: "Example",
    },
    module: "notes",
    operation: "saveNote",
    access: "write",
    reversibility: "reversible",
    authorityFence: "grant-generation:1",
    idempotencyKey: "turn:1/tool:1/operation:0",
    inputJson: '{"text":"hello"}',
  });
  if (staged.kind !== "record") throw new Error(staged.reason);
  console.log(staged.record.state); // "pending": no operation has run.
} finally {
  database.close();
}
