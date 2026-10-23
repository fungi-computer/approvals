import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { ApprovalLedger } from "@fungi.computer/approvals";

// A real packed run: a write is recorded pending, a human member answers it,
// the approved operation is dispatched exactly once, and its result reaches
// the requester through one ordinary handoff.
const database = new DatabaseSync(":memory:");
const ledger = new ApprovalLedger({
  owner: fromNodeSqlite(database),
  home: { kind: "team", id: "stranger-team" },
  now: () => 1_000,
  resultDelivery: { retryDelay: () => 1_000, attemptLimit: 3 },
});

const dispatched = [];
const host = {
  recheck: () =>
    Promise.resolve({ kind: "authorized", authorityFence: "fence:1" }),
  dispatch: ({ input }) => {
    dispatched.push(input);
    return Promise.resolve({ kind: "completed", output: { saved: true } });
  },
};
const request = {
  requester: {
    principalId: "agent:stranger",
    agentId: "stranger-agent",
    sessionId: "stranger-session",
    displayName: "Stranger",
  },
  module: "notes",
  operation: "saveNote",
  access: "write",
  reversibility: "reversible",
  authorityFence: "fence:1",
  idempotencyKey: "turn:1/tool:1/operation:0",
  inputJson: '{"text":"hello"}',
};

const pending = await ledger.submit(request, host);
if (pending.kind !== "pending_approval")
  throw new Error("A Team write must wait for a member's answer");
if (dispatched.length !== 0)
  throw new Error("A pending write must not reach the operation");
if (JSON.stringify(pending).includes("hello"))
  throw new Error("A pending notice must not carry the proposed input");

const answered = ledger.answer(
  { recordId: pending.recordId, decision: "approve", expectedRevision: 1 },
  {
    kind: "human",
    memberId: "member-1",
    role: "owner",
    actingForAgent: false,
    mayUseOperation: true,
  },
);
if (answered.kind !== "answered")
  throw new Error("A human member's answer must be recorded");

const applied = await ledger.apply(pending.recordId, host);
if (applied.kind !== "applied" || applied.output.saved !== true)
  throw new Error("An approved write must apply");
await ledger.apply(pending.recordId, host);
if (dispatched.length !== 1)
  throw new Error("An approved write must dispatch exactly once");

const sent = [];
const send = (notice) => {
  sent.push(notice);
  return Promise.resolve({ commandId: "command-1" });
};
const handoff = await ledger.handoff(pending.recordId, send);
if (handoff.kind !== "delivered" || handoff.commandId !== "command-1")
  throw new Error("The result must reach the requester as one message");
await ledger.handoff(pending.recordId, send);
if (sent.length !== 1)
  throw new Error("The result must be delivered exactly once");
if (!/^approval-result:[a-f0-9]{64}$/u.test(sent[0].deliveryId))
  throw new Error(
    "The delivery id must use the approval-result receipt format",
  );
database.close();
