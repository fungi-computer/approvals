import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  ApprovalLedger,
  type ApprovalAnswerer,
  type ApprovalApplyHost,
  type ApprovalRequest,
  type ApprovalRuleSetter,
  type AutoApproveInput,
} from "../src/index.js";

function teamLedger(now = () => 10) {
  const database = new DatabaseSync(":memory:");
  onTestFinished(() => {
    database.close();
  });
  const owner = fromNodeSqlite(database);
  return {
    owner,
    ledger: new ApprovalLedger({
      owner,
      home: { kind: "team", id: "team-a" },
      now,
    }),
  };
}

const narrow: AutoApproveInput = {
  scope: { agentId: "agent-a" },
  family: { module: "attachment-notes", access: "write" },
  enabled: true,
};
const wide: AutoApproveInput = {
  scope: { agentId: null },
  family: { module: null, access: "write" },
  enabled: true,
};

function setter(
  role: "owner" | "admin" | "member",
  authority: Partial<
    Readonly<{
      mayUseOperation: boolean;
      mayManageAgent: boolean;
      actingForAgent: boolean;
    }>
  > = {},
): ApprovalRuleSetter {
  return {
    kind: "human",
    memberId: role + "-1",
    role,
    actingForAgent: false,
    mayUseOperation: true,
    mayManageAgent: role !== "member",
    ...authority,
  };
}

const refused = { kind: "refused", reason: "not-eligible" };

it("a plain member without agent.manage cannot enable a narrow Team rule", () => {
  const { ledger } = teamLedger();
  expect(ledger.setAutoApprove(narrow, setter("member"))).toEqual(refused);
  expect(
    ledger.selectAutoApprove({
      agentId: "agent-a",
      module: "attachment-notes",
      access: "write",
    }),
  ).toBe(false);
});

it("only the Team owner may enable a rule for every Agent or every module", () => {
  const { ledger } = teamLedger();
  expect(ledger.setAutoApprove(wide, setter("admin"))).toEqual(refused);
  expect(
    ledger.setAutoApprove(
      { ...wide, scope: { agentId: "agent-a" } },
      setter("admin"),
    ),
  ).toEqual(refused);
  expect(
    ledger.setAutoApprove(wide, setter("owner", { actingForAgent: true })),
  ).toEqual(refused);
  expect(ledger.setAutoApprove(wide, setter("owner"))).toMatchObject({
    kind: "updated",
  });
});

it("a narrow Team rule needs live use of that exact family", () => {
  const { ledger } = teamLedger();
  expect(
    ledger.setAutoApprove(narrow, setter("admin", { mayUseOperation: false })),
  ).toEqual(refused);
  expect(
    ledger.setAutoApprove(narrow, setter("member", { mayManageAgent: true })),
  ).toMatchObject({ kind: "updated" });
});

it("an owner's narrow rule is recorded with its setter and time", () => {
  const { ledger, owner } = teamLedger(() => 42);
  expect(ledger.setAutoApprove(narrow, setter("owner"))).toEqual({
    kind: "updated",
    rule: narrow,
  });
  expect(
    owner.sql
      .exec("SELECT set_by, set_at, enabled FROM approval_rules")
      .toArray(),
  ).toEqual([{ set_by: "owner-1", set_at: 42, enabled: 1 }]);
});

it("the Team capability resolves the setter against the exact rule", async () => {
  const { ledger } = teamLedger();
  const resolve = vi.fn((rule: AutoApproveInput) => {
    expect(rule).toEqual(narrow);
    return Promise.resolve(setter("member"));
  });
  const control = ledger.capability({
    actor: () => Promise.resolve(setter("owner")),
    decision: () => Promise.resolve(),
    setter: resolve,
  });
  expect(await control.setAutoApprove(narrow)).toEqual(refused);
  expect(resolve).toHaveBeenCalledOnce();
});

const request: ApprovalRequest = {
  requester: {
    principalId: "agent-a",
    agentId: "agent-a",
    sessionId: "session-a",
    displayName: "Agent A",
  },
  module: "attachment-notes",
  operation: "saveNote",
  access: "write",
  reversibility: "reversible",
  authorityFence: "fence-1",
  idempotencyKey: "[session-a,command-a,call-a,0]",
  inputJson: '{"text":"first"}',
};

it("a retried submit after a human approval never applies or returns output", async () => {
  const { ledger } = teamLedger();
  const dispatch = vi.fn<ApprovalApplyHost["dispatch"]>(() =>
    Promise.resolve({ kind: "completed", output: { saved: true } }),
  );
  const host: ApprovalApplyHost = {
    recheck: () =>
      Promise.resolve({ kind: "authorized", authorityFence: "fence-1" }),
    dispatch,
  };
  const pending = await ledger.submit(request, host);
  expect(pending).toMatchObject({ kind: "pending_approval" });
  if (pending.kind !== "pending_approval") throw new Error("not pending");
  const member: ApprovalAnswerer = {
    kind: "human",
    memberId: "owner-1",
    role: "owner",
    actingForAgent: false,
    mayUseOperation: true,
  };
  expect(
    ledger.answer(
      { recordId: pending.recordId, decision: "approve", expectedRevision: 1 },
      member,
    ),
  ).toMatchObject({ kind: "answered" });
  expect(await ledger.submit(request, host)).toEqual(pending);
  expect(dispatch).not.toHaveBeenCalled();
  expect(ledger.get(pending.recordId)?.state).toBe("approved");
  // The home's work loop is the only apply; the retried call never answered.
  expect(await ledger.apply(pending.recordId, host)).toMatchObject({
    kind: "applied",
  });
  expect(await ledger.submit(request, host)).toEqual({
    kind: "refused",
    reason: "already-answered",
  });
  expect(dispatch).toHaveBeenCalledOnce();
});

it("a policy-approved record applied by the work loop applies once", async () => {
  const { ledger } = teamLedger();
  expect(
    ledger.setAutoApprove(
      {
        scope: { agentId: "agent-a" },
        family: { module: "attachment-notes", access: "write" },
        enabled: true,
      },
      setter("owner"),
    ),
  ).toMatchObject({ kind: "updated" });
  // Staged by policy, but the inline apply never ran (the isolate stopped).
  const staged = await ledger.request(request);
  if (staged.kind !== "record") throw new Error(staged.reason);
  expect(staged.record).toMatchObject({
    state: "approved",
    by: { kind: "policy" },
  });
  const host: ApprovalApplyHost = {
    recheck: () =>
      Promise.resolve({ kind: "authorized", authorityFence: "fence-1" }),
    dispatch: () =>
      Promise.resolve({ kind: "completed", output: { saved: true } }),
  };
  expect(await ledger.apply(staged.record.recordId, host)).toMatchObject({
    kind: "applied",
  });
});

it("an inline policy apply returns the output in the call", async () => {
  const { ledger } = teamLedger();
  ledger.setAutoApprove(
    {
      scope: { agentId: "agent-a" },
      family: { module: "attachment-notes", access: "write" },
      enabled: true,
    },
    setter("owner"),
  );
  const host: ApprovalApplyHost = {
    recheck: () =>
      Promise.resolve({ kind: "authorized", authorityFence: "fence-1" }),
    dispatch: () =>
      Promise.resolve({ kind: "completed", output: { saved: true } }),
  };
  expect(await ledger.submit(request, host)).toMatchObject({
    kind: "applied",
    output: { saved: true },
  });
});
