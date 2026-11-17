# Approvals

One durable approval record, many renderers. Mycelium owns operation admission;
this package owns the decision lifecycle beside it. Team storage on the Hub and
the Oyster host supply the homes. Bonsai is not a ledger home.

## Install

```sh
npm install @fungi.computer/approvals @fungi.computer/watchdog
```

Approvals ships ESM and TypeScript declarations from its root entrypoint. The
example below uses Node.js 24's native SQLite adapter from Watchdog. Your host
owns the database, requester identity, current grants and dispatch.

## Quick start

Stage a proposed write without executing it. This disposable in-memory example
prints `pending`; use a persistent, host-owned database for real requests.

```ts
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
  console.log(staged.record.state); // "pending"
} finally {
  database.close();
}
```

The identities and fence here are illustrative host-attested values, not fields
to trust from an Agent or browser. Keep the same idempotency key when retrying
the same operation. `request` stages a record and records the home's
auto-approve decision without dispatching. `submit` additionally applies a newly
policy-approved request inline through the authority recheck.

## Examples

The home example stages one pending write using native SQLite. The packed
consumer in `test/stranger/runtime.mjs` continues through a human answer and
application. It observes one dispatch across sequential successful retries; it
is not a real Agent transport proof.

To integrate those steps, pass `answer` a freshly resolved human member and the
record's expected revision. Supply `apply` with an `ApprovalApplyHost`:
`recheck` reads the requester's current authority and fence, and `dispatch`
calls your existing operation door. Approval does not grant missing authority.
The result belongs to the call that asked: the host that staged the record waits
for the answer inside its own tool call, applies it there and returns the output
as that call's result. Nothing is sent as a message.

## Contract model

`submit` stages a write needing approval and returns a typed pending_approval
status with its recordId and description; the host keeps that tool call open
until the answer. A request staged with `expiresAt` (the waiting call's own
deadline) never outlives the call: `withdraw` expires an unclaimed record when
the call is cancelled or ends, and `withdrawWaiting` does so for every unclaimed
record at native boot. On approval the ledger durably claims, rechecks the exact
fence and requester's current Mycelium authority, dispatches the existing host
operation at most once, and stores applied/denied/outcome_unknown. Auto-approve
applies inline through the same record. No MuleTool.resume, Watchdog park/wake,
stored tool suspension, or unsafe execute replay belongs to this model.

The member-bound capability exposes approvals.list/get/answer/setAutoApprove.
Actors and live grants come from the host, never from request bodies. Reads are
bounded and project current answer/policy rights. Answering never grants the
requester authority over an operation.

Auto-approve matches a module (or all modules) and access class write/external,
optionally for one Agent. ON includes irreversible actions, still records the
decision, and never overrides revoked authority. Local and the solo Oyster owner
default ON; Teams default OFF. Only the Oyster owner answers on an Oyster. A
request with no `expiresAt` expires after 24 hours (the Oyster home, whose host
applies approved records from its own work loop). A call-owned request expires
with its call. Expiry never approves.

## Current implementation boundary

ApprovalLedger uses a host-supplied native SQLite owner. It stages a stable
intended effect, snapshots metadata before hashing yields, stores private
input/output separately, serializes answers and claims, and records typed
completion or unknown outcome without blindly redispatching. A known host
refusal is distinct from App JSON. recoverClaims transitions orphan claims in
bounded batches; the native host must call it only at boot, never during a live
dispatch.

ledger.capability({ actor, decision }) binds the four public methods. The host
must supply fresh member/operation facts on every call and actual durable apply
work after a decision; there is no success-shaped default hook. List reads are
bounded to at most 100 records with a continuation cursor. Request bodies cannot
select their actor. Policy is persisted by home and Agent/module/access family.

Private input bytes are never part of a result sent anywhere: a waiting call
receives the operation's own output or a typed refusal. The Local and Hub hosts
resolve the waiting call from their own answer hook; the ledger keeps one claim
and one effect attempt per record, so a duplicate waiter cannot dispatch twice.

Store tests and the page/RPC consumer fixture do not establish the production
behaviors of the hosts or the ten full-host laws.

## Host admission policy read

The runtime calls ledger.selectAutoApprove({ agentId, module, access }) to read
one effective boolean. This is the same selection request/submit uses: persisted
Agent rules win over home rules, then a module rule wins over all modules.
setAutoApprove persists the single enabled field in approval_rules; the read
neither stages an action nor dispatches it. A true policy value does not attest
to current grants, the authority fence, or containment.

Local is an explicit ledger home with default ON, like Oyster; Team defaults
OFF. The Local adapter supplies its native SQLite owner. Containment is owned by
the Local sandbox integration, not this policy read. Sandbox escapes set
`requireHumanApproval`, so general auto-approve cannot widen a sandboxed
command. After the Local host verifies a protected direct-argv prefix rule, it
sets `prefixPolicyApproved` for that one request; the ledger records a policy
decision and applies it inline through the ordinary authority recheck. The
ledger does not parse shell text, store prefixes, or let an Agent manage them.

## Capability-attached visual evidence

ApprovalRecord optionally carries evidence: an array of at most 4 descriptors,
each with kind artifact, ref sha256:<64 lowercase hex>, mediaType image/png and
bytes (integer 1 through 5 MiB). ApprovalEvidenceSchema is the maintained Effect
Schema decoder. These are defensive display ceilings, not execution authority.
The ref is a content address, not a URL or a release's opaque artifact: name.

Only the submitting capability supplies ApprovalSubmitHost.evidence to
ledger.submit(request, host). The host-only staging API request(request,
evidence?) uses the same decoder. ApprovalRequest and tool arguments do not gain
an evidence field. Never spread Agent/tool input into the host adapter. Metadata
is snapshotted before hashing yields and persisted with the record; get/list and
ApprovalView carry it. The immediate pending tool result remains unchanged.

Image content is untrusted display-only data, even when capture was performed by
a capability. Never OCR it into instructions, inject it as Agent text or treat
it as authority. This package stores metadata only: it does not capture, fetch
or validate PNG bytes. Producers/store adapters and display renderers own actual
bounded artifact reads, digest/length verification and maintained image
decoding. Screenshot capture, workflow result cards, Grove display and the TUI's
interactive open-screenshot link are separate owner work, not implemented by
this contract. An idempotent retry retains its original evidence: substituting,
adding or removing descriptors under the same effect identity returns
identity-conflict, never silently changes the reviewed image. Omitted and empty
lists both mean no evidence.
