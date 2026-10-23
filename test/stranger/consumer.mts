import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  ApprovalLedger,
  ApprovalRefusalSchema,
  ApprovalViewSchema,
  DEFAULT_APPROVAL_EXPIRY_MS,
  PendingApprovalSchema,
  type ApprovalAnswerer,
  type ApprovalApplyHost,
  type ApprovalApplyResult,
  type ApprovalHandoffResult,
  type ApprovalHome,
  type ApprovalRequest,
  type ApprovalResultNotice,
  type PendingApproval,
} from "@fungi.computer/approvals";

const home: ApprovalHome = { kind: "team", id: "stranger-team" };
const ledger: ApprovalLedger = new ApprovalLedger({
  owner: fromNodeSqlite(new DatabaseSync(":memory:")),
  home,
  now: () => 1,
  resultDelivery: { retryDelay: () => 1, attemptLimit: 3 },
});
const request: ApprovalRequest = {
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
  inputJson: "{}",
};
const host: ApprovalApplyHost = {
  recheck: () =>
    Promise.resolve({ kind: "authorized", authorityFence: "fence:1" }),
  dispatch: () => Promise.resolve({ kind: "completed", output: null }),
};
const answerer: ApprovalAnswerer = {
  kind: "human",
  memberId: "member-1",
  role: "owner",
  actingForAgent: false,
  mayUseOperation: true,
};
const expiry: number = DEFAULT_APPROVAL_EXPIRY_MS;
const submitted: Promise<PendingApproval | ApprovalApplyResult> = ledger.submit(
  request,
  host,
);
const applied: Promise<ApprovalApplyResult> = ledger.apply("record", host);
const handoff: Promise<ApprovalHandoffResult> = ledger.handoff(
  "record",
  (notice: ApprovalResultNotice) =>
    Promise.resolve({ commandId: notice.deliveryId }),
);
const undeliverable: ApprovalHandoffResult = { kind: "undeliverable" };
const pendingFields = Object.keys(PendingApprovalSchema.fields);
const refusalFields = Object.keys(ApprovalRefusalSchema.fields);
const viewFields = Object.keys(ApprovalViewSchema.fields);
void { answerer, expiry, submitted, applied, handoff, undeliverable };
void { pendingFields, refusalFields, viewFields };
