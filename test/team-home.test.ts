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

const app = { displayName: "Notes", operationLabel: "Replace the note" };
const appRequest: ApprovalRequest = { ...request, app };
const ownerAnswerer: ApprovalAnswerer = {
  kind: "human",
  memberId: "owner-1",
  role: "owner",
  actingForAgent: false,
  mayUseOperation: true,
};
const noHost: ApprovalApplyHost = {
  recheck: () =>
    Promise.resolve({ kind: "authorized", authorityFence: "fence-1" }),
  dispatch: () =>
    Promise.resolve({ kind: "completed", output: { saved: true } }),
};

async function stage(
  ledger: ApprovalLedger,
  overrides: Partial<ApprovalRequest> = {},
) {
  const pending = await ledger.submit({ ...appRequest, ...overrides }, noHost);
  if (pending.kind !== "pending_approval") throw new Error("not pending");
  return pending.recordId;
}

it("asking again for the same open App write joins its record instead of stacking a card", async () => {
  const { ledger } = teamLedger();
  const first = await stage(ledger);
  const second = await stage(ledger, {
    idempotencyKey: "[session-a,cmd-b,call-b,0]",
  });
  expect(second).toBe(first);
  // Another input, another Session or another operation is its own request.
  expect(
    await stage(ledger, {
      idempotencyKey: "k3",
      inputJson: '{"text":"other"}',
    }),
  ).not.toBe(first);
  expect(
    await stage(ledger, {
      idempotencyKey: "k4",
      requester: { ...request.requester, sessionId: "session-b" },
    }),
  ).not.toBe(first);
  expect(
    await stage(ledger, { idempotencyKey: "k5", operation: "other" }),
  ).not.toBe(first);
});

it("once the open request is answered and applied, the same write asks again", async () => {
  const { ledger } = teamLedger();
  const first = await stage(ledger);
  ledger.answer(
    { recordId: first, decision: "deny", expectedRevision: 1 },
    ownerAnswerer,
  );
  expect(await stage(ledger, { idempotencyKey: "later" })).not.toBe(first);
});

it("a request past its deadline is not open: the same write gets a fresh record", async () => {
  let now = 10;
  const { ledger } = teamLedger(() => now);
  const first = await stage(ledger, { expiresAt: 100 });
  now = 200;
  expect(await stage(ledger, { idempotencyKey: "later" })).not.toBe(first);
});

it("withdrawing a Session's requests ends only its own unanswered ones up to the cutoff", async () => {
  let now = 10;
  const { ledger } = teamLedger(() => now);
  const old = await stage(ledger, { idempotencyKey: "a" });
  const other = await stage(ledger, {
    idempotencyKey: "b",
    inputJson: '{"text":"two"}',
    requester: { ...request.requester, sessionId: "session-b" },
  });
  now = 50;
  const newer = await stage(ledger, {
    idempotencyKey: "c",
    inputJson: '{"text":"three"}',
  });
  ledger.expectDelivery(old, "command-old");
  expect(ledger.withdrawForSession("session-a", 20)).toBe(1);
  expect(ledger.get(old)?.state).toBe("expired");
  expect(ledger.get(other)?.state).toBe("pending");
  expect(ledger.get(newer)?.state).toBe("pending");
  // Approving after the withdrawal is refused, and no follow-up is owed.
  expect(
    ledger.answer(
      { recordId: old, decision: "approve", expectedRevision: 1 },
      ownerAnswerer,
    ),
  ).toEqual({ kind: "refused", reason: "expired" });
  expect(ledger.dueDeliveries(10)).toEqual([]);
  expect(ledger.nextDeliveryAt()).toBeNull();
});

it("withdrawing an Agent's requests ends every unanswered one it made", async () => {
  const { ledger } = teamLedger();
  const mine = await stage(ledger, { idempotencyKey: "a" });
  const approved = await stage(ledger, {
    idempotencyKey: "b",
    inputJson: '{"text":"two"}',
  });
  ledger.answer(
    { recordId: approved, decision: "approve", expectedRevision: 1 },
    ownerAnswerer,
  );
  const theirs = await stage(ledger, {
    idempotencyKey: "c",
    inputJson: '{"text":"three"}',
    requester: {
      ...request.requester,
      principalId: "agent-b",
      agentId: "agent-b",
    },
  });
  expect(ledger.withdrawForAgent("agent-a")).toBe(2);
  expect(ledger.get(mine)?.state).toBe("expired");
  expect(ledger.get(approved)?.state).toBe("expired");
  expect(ledger.get(theirs)?.state).toBe("pending");
  expect(ledger.withdrawForAgent("agent-a")).toBe(0);
});

it("a follow-up is owed once, only after the record ends, and retries until it is finished", async () => {
  let now = 10;
  const { ledger } = teamLedger(() => now);
  const id = await stage(ledger);
  ledger.expectDelivery(id, null);
  ledger.expectDelivery(id, null);
  // Nothing is due while the request still waits.
  expect(ledger.dueDeliveries(10)).toEqual([]);
  expect(ledger.nextDeliveryAt()).toBeNull();
  ledger.answer(
    { recordId: id, decision: "deny", expectedRevision: 1 },
    ownerAnswerer,
  );
  expect(ledger.dueDeliveries(10)).toMatchObject([
    { record: { recordId: id, state: "denied" }, attempts: 0 },
  ]);
  expect(ledger.nextDeliveryAt()).toBe(0);
  ledger.deferDelivery(id, now + 5_000);
  expect(ledger.dueDeliveries(10)).toEqual([]);
  expect(ledger.nextDeliveryAt()).toBe(5_010);
  now = 6_000;
  expect(ledger.dueDeliveries(10)).toMatchObject([{ attempts: 1 }]);
  ledger.finishDelivery(id, "delivered");
  expect(ledger.dueDeliveries(10)).toEqual([]);
  expect(ledger.nextDeliveryAt()).toBeNull();
});

it("a request that expires by time owes its follow-up like any other ending", async () => {
  let now = 10;
  const { ledger } = teamLedger(() => now);
  const id = await stage(ledger, { expiresAt: 100 });
  ledger.expectDelivery(id, null);
  now = 200;
  ledger.expirePending();
  expect(ledger.dueDeliveries(10)).toMatchObject([
    { record: { recordId: id, state: "expired" } },
  ]);
});

it("cancelling one command withdraws only its own cards, not another command's in the same Session", async () => {
  const { ledger } = teamLedger();
  const first = await stage(ledger, {
    idempotencyKey: "a",
    commandId: "command-1",
  });
  const second = await stage(ledger, {
    idempotencyKey: "b",
    inputJson: '{"text":"two"}',
    commandId: "command-2",
  });
  ledger.expectDelivery(first, "command-1");
  ledger.expectDelivery(second, "command-2");
  expect(ledger.withdrawForCommand("session-a", "command-1")).toBe(1);
  expect(ledger.get(first)?.state).toBe("expired");
  expect(ledger.get(second)?.state).toBe("pending");
  // Its follow-up is cancelled; the other command's is still owed.
  ledger.answer(
    { recordId: second, decision: "deny", expectedRevision: 1 },
    ownerAnswerer,
  );
  expect(ledger.dueDeliveries(10).map(({ record }) => record.recordId)).toEqual(
    [second],
  );
  expect(ledger.withdrawForCommand("session-a", "unknown")).toBe(0);
});

it("a policy-approved record in flight is never joined by a later identical request", async () => {
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
  const staged = await ledger.request(appRequest);
  if (staged.kind !== "record") throw new Error(staged.reason);
  expect(staged.record.state).toBe("approved");
  const again = await ledger.request({
    ...appRequest,
    idempotencyKey: "other",
  });
  if (again.kind !== "record") throw new Error(again.reason);
  expect(again.record.recordId).not.toBe(staged.record.recordId);
});

it("the App's own words for a lost write are kept with the delivery row", async () => {
  const { ledger } = teamLedger();
  const id = await stage(ledger);
  ledger.expectDelivery(id, null);
  ledger.recordDeliveryCause(id, "socket closed");
  ledger.answer(
    { recordId: id, decision: "deny", expectedRevision: 1 },
    ownerAnswerer,
  );
  expect(ledger.dueDeliveries(10)[0]?.cause).toBe("socket closed");
});

it("a card two commands asked for survives the first's cancel and ends with the last", async () => {
  const { ledger } = teamLedger();
  const id = await stage(ledger, { commandId: "command-1" });
  ledger.expectDelivery(id, "command-1");
  // A second command asks for the same open write and joins the card.
  const joined = await stage(ledger, {
    idempotencyKey: "second",
    commandId: "command-2",
  });
  expect(joined).toBe(id);
  ledger.expectDelivery(joined, "command-2");
  expect(ledger.withdrawForCommand("session-a", "command-1")).toBe(1);
  expect(ledger.get(id)?.state).toBe("pending");
  expect(ledger.withdrawForCommand("session-a", "command-2")).toBe(1);
  expect(ledger.get(id)?.state).toBe("expired");
  expect(ledger.withdrawForCommand("session-a", "command-2")).toBe(0);
  expect(ledger.dueDeliveries(10)).toEqual([]);
});
