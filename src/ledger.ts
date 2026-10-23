import * as Schema from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  ApprovalRecordSchema,
  ApprovalEvidenceSchema,
  type ApprovalEvidence,
  ApprovalRefusalReasonSchema,
  ApprovalGetInputSchema,
  ApprovalListInputSchema,
  ApprovalAnswerInputSchema,
  AutoApproveInputSchema,
  type ApprovalRecord,
  type Approvals,
  type ApprovalView,
  type ApprovalRefusal,
  type ApprovalAnswerInput,
  type AutoApproveInput,
  type PendingApproval,
} from "./contract.js";

/** Canonical zero-effect or lifecycle refusal at a tool result boundary. */
export const ApprovalRefusalSchema = Schema.Struct({
  kind: Schema.Literal("refused"),
  reason: ApprovalRefusalReasonSchema,
});

/** Native owner of this ledger; the Local runtime supplies its own SQLite owner. */
export type ApprovalHome = Readonly<{
  kind: "team" | "oyster" | "local";
  id: string;
}>;

const defaultAutoApprove = {
  team: false,
  oyster: true,
  local: true,
} satisfies Readonly<Record<ApprovalHome["kind"], boolean>>;

/** A request is host-attested metadata and JSON bytes, never renderer-provided identity. */
export type ApprovalRequest = Readonly<{
  requester: ApprovalRecord["requester"];
  module: string;
  operation: string;
  access: ApprovalRecord["access"];
  reversibility: ApprovalRecord["reversibility"];
  authorityFence: string;
  /** Persisted turn/tool identity and operation ordinal; never random on retry. */
  idempotencyKey: string;
  inputJson: string;
}>;

/** Host-only policy read for an admitted Agent/module/access selection, not execution authority. */
export type AutoApproveQuery = Readonly<{
  agentId: ApprovalRequest["requester"]["agentId"];
  module: ApprovalRequest["module"];
  access: ApprovalRequest["access"];
}>;

/** Host-attested human identity and current authority over this exact operation. */
export type ApprovalAnswerer =
  | Readonly<{
      kind: "human";
      memberId: string;
      role: "owner" | "admin" | "member";
      actingForAgent: boolean;
      mayUseOperation: boolean;
    }>
  | Readonly<{ kind: "agent" | "key" }>;

/**
 * Host-attested authority to write one auto-approve rule. A Team home
 * resolves it against the exact rule: mayUseOperation for that family and
 * mayManageAgent (agent.manage on that Agent; owners and admins hold it
 * Team-wide). An answerer without mayManageAgent never manages an Agent.
 * Oyster and Local homes are owner-only.
 */
export type ApprovalRuleSetter =
  | ApprovalAnswerer
  | (Extract<ApprovalAnswerer, { kind: "human" }> &
      Readonly<{ mayManageAgent: boolean }>);

/** Mycelium owns admission; the ledger compares its opaque fence, never grant grammar. */
export type ApprovalAdmission =
  | Readonly<{ kind: "authorized"; authorityFence: string }>
  | Readonly<{ kind: "refused"; reason: "not-granted" | "read-only" }>;
/** Host verdict outside App JSON: only an attested zero-effect refusal is denied. */
export type ApprovalDispatchCompletion =
  | Readonly<{ kind: "completed"; output: typeof Schema.Json.Type }>
  | Readonly<{ kind: "refused"; reason: "not-granted" | "read-only" }>;
/** Host-only adapter to the existing operation door; not an Agent continuation. */
export type ApprovalApplyHost = Readonly<{
  /** Re-read requester grants and the operation fence immediately before dispatch. */
  recheck: (record: ApprovalRecord) => Promise<ApprovalAdmission>;
  /** Attempt the admitted operation once through the existing host operation door. */
  dispatch: (
    request: Readonly<{
      record: ApprovalRecord;
      input: typeof Schema.Json.Type;
    }>,
  ) => Promise<ApprovalDispatchCompletion>;
}>;
/** Only the submitting capability may attach evidence; never spread tool input here. */
export type ApprovalSubmitHost = ApprovalApplyHost &
  Readonly<{
    evidence?: ApprovalEvidence;
  }>;
/** Private result for inline tool output or ordinary deferred new-message delivery. */
export type ApprovalApplyResult =
  | Readonly<{
      kind: "applied";
      record: ApprovalRecord;
      output: typeof Schema.Json.Type;
    }>
  | ApprovalRefusal;

/** Deferred result cargo; stored request input is not a field on this port. */
export type ApprovalResultNotice = Readonly<{
  deliveryId: string;
  record: ApprovalRecord;
  result: ApprovalApplyResult;
}>;
/** Ordinary new-message receipt, explicit no-delivery result, or typed refusal. */
export type ApprovalHandoffResult =
  | Readonly<{ kind: "delivered"; commandId: string }>
  | Readonly<{ kind: "not-required" }>
  /** The home's attempt limit was reached; the decided record is kept. */
  | Readonly<{ kind: "undeliverable" }>
  | ApprovalRefusal;

/** An unguessable recipient idempotency key; never part of any record view. */
function mintDeliveryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "approval-result:" +
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

/** The initial owner-controlled wait duration; passing the deadline never approves. */
export const DEFAULT_APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(ApprovalRecordSchema),
  { onExcessProperty: "error" },
);
const encodeRecord = Schema.encodeSync(
  Schema.fromJsonString(ApprovalRecordSchema),
);
const decodeRow = Schema.decodeUnknownSync(
  Schema.Struct({ record_json: Schema.String }),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodePayload = Schema.decodeUnknownSync(
  Schema.Struct({
    input_json: Schema.String,
    output_json: Schema.NullOr(Schema.String),
  }),
);

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** SQLite lifecycle beside Mycelium. Native owner transactions serialize every transition. */
export class ApprovalLedger {
  private readonly homeKey: string;
  constructor(
    private readonly options: Readonly<{
      owner: WatchdogSqliteOwner;
      home: ApprovalHome;
      now: () => number;
      /** Host-private dispatch target, committed in the same SQLite transaction as the record. */
      persistIntent?: (record: ApprovalRecord) => undefined;
      /**
       * Present when this home's wake sends result messages: its wake then
       * covers undelivered results, and a failed send waits retryDelay(attempt)
       * from the home's existing delivery policy before the next try. The
       * attemptLimit-th failure makes the result undeliverable: no more wakes.
       */
      resultDelivery?: Readonly<{
        retryDelay: (attempt: number) => number;
        attemptLimit: number;
      }>;
    }>,
  ) {
    this.homeKey = JSON.stringify([options.home.kind, options.home.id]);
    options.owner.sql.exec(
      "CREATE TABLE IF NOT EXISTS approval_rules (home_key TEXT NOT NULL, rule_key TEXT NOT NULL, agent_id TEXT, module_id TEXT, access_class TEXT NOT NULL, enabled INTEGER NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL, PRIMARY KEY (home_key, rule_key))",
    );
    options.owner.sql.exec(
      "CREATE TABLE IF NOT EXISTS approval_records (home_key TEXT NOT NULL, record_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (home_key, record_id))",
    );
    options.owner.sql.exec(
      "CREATE INDEX IF NOT EXISTS approval_records_by_state ON approval_records (home_key, json_extract(record_json, '$.state'), record_id)",
    );
    options.owner.sql.exec(
      "CREATE TABLE IF NOT EXISTS approval_payloads (home_key TEXT NOT NULL, record_id TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, PRIMARY KEY (home_key, record_id))",
    );
    options.owner.sql.exec(
      "CREATE TABLE IF NOT EXISTS approval_handoffs (home_key TEXT NOT NULL, record_id TEXT NOT NULL, delivery_id TEXT NOT NULL, command_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, undeliverable_at INTEGER, PRIMARY KEY (home_key, record_id))",
    );
    options.owner.sql.exec(
      "CREATE INDEX IF NOT EXISTS approval_handoffs_by_receipt ON approval_handoffs (home_key, command_id, record_id)",
    );
  }

  /** Bound control surface; null identity means membership is gone, never an impersonated key. */
  capability(
    host: Readonly<{
      actor: (
        record: ApprovalRecord | null,
      ) => Promise<ApprovalAnswerer | null>;
      decision: (recordId: string) => Promise<void>;
      /** Team homes: the setter's authority over this exact rule. Without it a Team rule write is refused. */
      setter?: (rule: AutoApproveInput) => Promise<ApprovalRuleSetter | null>;
    }>,
  ): Approvals {
    const requireMember = (actor: ApprovalAnswerer | null) => {
      if (actor?.kind !== "human")
        throw new Error("Approval read requires a current member");
    };
    const get: Approvals["get"] = async (raw) => {
      const { recordId } = Schema.decodeUnknownSync(ApprovalGetInputSchema, {
        onExcessProperty: "error",
      })(raw);
      const record = this.get(recordId);
      const actor = await host.actor(record);
      requireMember(actor);
      return record === null ? null : view(record, actor);
    };
    const ruleSetter = async (
      rule: AutoApproveInput,
    ): Promise<ApprovalRuleSetter | null> => {
      if (this.options.home.kind === "team")
        return host.setter === undefined ? null : host.setter(rule);
      return host.actor(null);
    };
    // Rights are recomputed for the holder: the narrow rule this record offers.
    const view = async (
      record: ApprovalRecord,
      actor: ApprovalAnswerer | null,
    ): Promise<ApprovalView> => {
      const rule: AutoApproveInput = {
        scope: { agentId: record.requester.agentId },
        family: { module: record.module, access: record.access },
        enabled: true,
      };
      return {
        record,
        canAnswer: record.state === "pending" && this.eligible(actor),
        canSetAutoApprove: this.canManagePolicy(rule, await ruleSetter(rule)),
      };
    };
    return {
      get,
      list: async (raw) => {
        const input = Schema.decodeUnknownSync(ApprovalListInputSchema, {
          onExcessProperty: "error",
        })(raw);
        requireMember(await host.actor(null));
        const limit = input.limit ?? 100;
        const rows = this.options.owner.sql
          .exec(
            "SELECT record_json FROM approval_records WHERE home_key = ? AND record_id > ? AND (? IS NULL OR CASE WHEN json_extract(record_json, '$.state') = 'pending' AND json_extract(record_json, '$.expiresAt') <= ? THEN 'expired' ELSE json_extract(record_json, '$.state') END = ?) ORDER BY record_id LIMIT ?",
            this.homeKey,
            input.cursor ?? "",
            input.state ?? null,
            this.options.now(),
            input.state ?? null,
            limit + 1,
          )
          .toArray()
          .map((raw) => decodeRecord(decodeRow(raw).record_json));
        const page = rows.slice(0, limit);
        const records = page.flatMap((record) => {
          const current = this.get(record.recordId);
          return current === null ||
            (input.state !== undefined && current.state !== input.state)
            ? []
            : [current];
        });
        const items = await Promise.all(
          records.map(async (record) => {
            const actor = await host.actor(record);
            requireMember(actor);
            return view(record, actor);
          }),
        );
        const last = page.at(-1);
        return {
          items,
          nextCursor:
            rows.length > limit && last !== undefined ? last.recordId : null,
        };
      },
      answer: async (raw) => {
        const input = Schema.decodeUnknownSync(ApprovalAnswerInputSchema, {
          onExcessProperty: "error",
        })(raw);
        const result = this.answer(
          input,
          await host.actor(this.get(input.recordId)),
        );
        if (result.kind === "refused") return result;
        // The native home must persist/wake its own apply and message work.
        // A missing or failed host callback is never treated as applied work.
        await host.decision(result.record.recordId);
        const view = await get({ recordId: result.record.recordId });
        if (view === null) throw new Error("Answered approval disappeared");
        return { kind: "answered", view };
      },
      setAutoApprove: async (raw) => {
        const rule = Schema.decodeUnknownSync(AutoApproveInputSchema, {
          onExcessProperty: "error",
        })(raw);
        return this.setAutoApprove(rule, await ruleSetter(rule));
      },
    };
  }

  private eligible(
    actor: ApprovalAnswerer | null,
  ): actor is Extract<ApprovalAnswerer, { kind: "human" }> {
    return (
      actor?.kind === "human" &&
      !actor.actingForAgent &&
      actor.mayUseOperation &&
      (this.options.home.kind !== "oyster" || actor.role === "owner")
    );
  }

  /** Normal tool admission returns pending immediately, or applies policy approval inline. */
  async submit(
    input: ApprovalRequest,
    host: ApprovalSubmitHost,
  ): Promise<PendingApproval | ApprovalApplyResult> {
    const staged = await this.request(input, host.evidence);
    if (staged.kind === "refused") return staged;
    const { record } = staged;
    // Only this call's own policy approval applies inline. Every other
    // approved record is applied by the home's work loop, never by a retry.
    if (staged.created && record.state === "approved")
      return this.applyInline(record.recordId, host);
    return this.outcome(record);
  }

  /** A retried request's current outcome, without claiming any work. */
  outcome(record: ApprovalRecord): PendingApproval | ApprovalApplyResult {
    switch (record.state) {
      case "requested":
      case "pending":
      case "approved":
      case "claimed":
        return {
          kind: "pending_approval",
          recordId: record.recordId,
          description: record.description,
        };
      case "applied": {
        // A human-approved result reaches the requester as its own message.
        if (record.by?.kind !== "policy")
          return { kind: "refused", reason: "already-answered" };
        const output = this.payload(record.recordId).output_json;
        if (output === null)
          throw new Error("Applied approval has no recorded output");
        return { kind: "applied", record, output: decodeJson(output) };
      }
      case "denied":
        return { kind: "refused", reason: record.reason ?? "declined" };
      case "expired":
        return { kind: "refused", reason: "expired" };
      case "outcome_unknown":
        return { kind: "refused", reason: "outcome-unknown" };
    }
  }

  /**
   * Stage one stable intended effect. Duplicate identities never create
   * another action; created says whether this call staged the record.
   */
  async request(
    input: ApprovalRequest,
    evidence?: ApprovalEvidence,
  ): Promise<
    | Readonly<{ kind: "record"; record: ApprovalRecord; created: boolean }>
    | ApprovalRefusal
  > {
    // Preserve the reviewed identity, authority and payload across the digest await.
    const request = structuredClone(input);
    const attachments =
      evidence === undefined
        ? {}
        : {
            evidence: Schema.decodeUnknownSync(ApprovalEvidenceSchema, {
              onExcessProperty: "error",
            })(structuredClone(evidence)),
          };
    decodeJson(request.inputJson);
    const bytes = new TextEncoder().encode(request.inputJson);
    const [recordId, inputSha256] = await Promise.all([
      sha256(
        new TextEncoder().encode(
          JSON.stringify([
            this.homeKey,
            request.requester.principalId,
            request.requester.sessionId,
            request.module,
            request.operation,
            request.idempotencyKey,
          ]),
        ),
      ),
      sha256(bytes),
    ]);
    return this.options.owner.transactionSync(() => {
      const existing = this.get(recordId);
      if (existing !== null) {
        if (
          existing.description.inputSha256 !== inputSha256 ||
          existing.authorityFence !== request.authorityFence ||
          JSON.stringify(existing.evidence ?? []) !==
            JSON.stringify(attachments.evidence ?? [])
        )
          return { kind: "refused", reason: "identity-conflict" };
        return { kind: "record", record: existing, created: false };
      }
      const now = this.options.now();
      const autoApproved = this.selectAutoApprove({
        agentId: request.requester.agentId,
        module: request.module,
        access: request.access,
      });
      const record = Schema.decodeUnknownSync(ApprovalRecordSchema, {
        onExcessProperty: "error",
      })({
        recordId,
        requester: request.requester,
        module: request.module,
        operation: request.operation,
        access: request.access,
        description: {
          title: (request.module + "." + request.operation).slice(0, 512),
          inputBytes: bytes.length,
          inputSha256,
        },
        ...attachments,
        authorityFence: request.authorityFence,
        reversibility: request.reversibility,
        state: autoApproved ? "approved" : "pending",
        by: autoApproved ? { kind: "policy" } : null,
        reason: null,
        requestedAt: now,
        expiresAt: now + DEFAULT_APPROVAL_EXPIRY_MS,
        updatedAt: now,
        revision: 1,
      });
      this.options.persistIntent?.(record);
      this.options.owner.sql.exec(
        "INSERT INTO approval_records (home_key, record_id, record_json) VALUES (?, ?, ?)",
        this.homeKey,
        recordId,
        encodeRecord(record),
      );
      this.options.owner.sql.exec(
        "INSERT INTO approval_payloads (home_key, record_id, input_json) VALUES (?, ?, ?)",
        this.homeKey,
        recordId,
        request.inputJson,
      );
      // Only a waiting, host-attested Agent Session needs an ordinary later message.
      // Policy-approved inline calls must not manufacture another Agent turn.
      if (
        !autoApproved &&
        record.requester.agentId !== null &&
        record.requester.sessionId !== null
      )
        this.options.owner.sql.exec(
          "INSERT INTO approval_handoffs (home_key, record_id, delivery_id) VALUES (?, ?, ?)",
          this.homeKey,
          recordId,
          mintDeliveryId(),
        );
      return { kind: "record", record, created: true };
    });
  }

  /** Answering is revision-pinned and never changes the requester's underlying grants. */
  answer(
    input: ApprovalAnswerInput,
    actor: ApprovalAnswerer | null,
  ): Readonly<{ kind: "answered"; record: ApprovalRecord }> | ApprovalRefusal {
    if (!this.eligible(actor))
      return { kind: "refused", reason: "not-eligible" };
    return this.options.owner.transactionSync(() => {
      const record = this.get(input.recordId);
      if (record === null) return { kind: "refused", reason: "not-found" };
      if (record.state === "expired")
        return { kind: "refused", reason: "expired" };
      if (record.state !== "pending")
        return { kind: "refused", reason: "already-answered" };
      if (record.revision !== input.expectedRevision)
        return { kind: "refused", reason: "stale-revision" };
      const answered: ApprovalRecord = {
        ...record,
        state: input.decision === "approve" ? "approved" : "denied",
        reason: input.decision === "approve" ? null : "declined",
        by: { kind: "human", memberId: actor.memberId },
        revision: record.revision + 1,
        updatedAt: this.options.now(),
      };
      this.save(answered);
      return { kind: "answered", record: answered };
    });
  }

  /** Policy changes are attributed; an Agent can never enable its own writes. */
  setAutoApprove(
    input: AutoApproveInput,
    setter: ApprovalRuleSetter | null,
  ): Readonly<{ kind: "updated"; rule: AutoApproveInput }> | ApprovalRefusal {
    const rule = Schema.decodeUnknownSync(AutoApproveInputSchema, {
      onExcessProperty: "error",
    })(input);
    if (!this.canManagePolicy(rule, setter) || setter?.kind !== "human")
      return { kind: "refused", reason: "not-eligible" };
    this.options.owner.sql.exec(
      "INSERT INTO approval_rules (home_key, rule_key, agent_id, module_id, access_class, enabled, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (home_key, rule_key) DO UPDATE SET enabled = excluded.enabled, set_by = excluded.set_by, set_at = excluded.set_at",
      this.homeKey,
      JSON.stringify([
        rule.scope.agentId,
        rule.family.module,
        rule.family.access,
      ]),
      rule.scope.agentId,
      rule.family.module,
      rule.family.access,
      rule.enabled ? 1 : 0,
      setter.memberId,
      this.options.now(),
    );
    return { kind: "updated", rule };
  }

  /**
   * Team: a rule for one Agent and one module needs live use of that family
   * and agent.manage on that Agent; any wider rule is the owner's alone.
   * Oyster and Local rules are owner-only.
   */
  private canManagePolicy(
    rule: AutoApproveInput,
    setter: ApprovalRuleSetter | null,
  ): boolean {
    if (setter?.kind !== "human" || setter.actingForAgent) return false;
    if (this.options.home.kind !== "team") return setter.role === "owner";
    const narrow = rule.scope.agentId !== null && rule.family.module !== null;
    return narrow
      ? setter.mayUseOperation &&
          "mayManageAgent" in setter &&
          setter.mayManageAgent
      : setter.role === "owner";
  }

  /** Pure policy selection: no record, claim, dispatch, grant widening or containment choice. */
  selectAutoApprove(query: AutoApproveQuery): boolean {
    // Agent-specific policy wins over the home; within a scope, a module narrows all modules.
    const raw = this.options.owner.sql
      .exec(
        "SELECT enabled FROM approval_rules WHERE home_key = ? AND access_class = ? AND (agent_id IS NULL OR agent_id = ?) AND (module_id IS NULL OR module_id = ?) ORDER BY (agent_id IS NOT NULL) DESC, (module_id IS NOT NULL) DESC LIMIT 1",
        this.homeKey,
        query.access,
        query.agentId,
        query.module,
      )
      .toArray()[0];
    if (raw === undefined) return defaultAutoApprove[this.options.home.kind];
    return (
      Schema.decodeUnknownSync(
        Schema.Struct({ enabled: Schema.Literals([0, 1]) }),
      )(raw).enabled === 1
    );
  }

  /** Expire one bounded home-local quantum without a member read or an approval. */
  expirePending(): void {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({
        record_id: ApprovalRecordSchema.fields.recordId,
      }),
    );
    const rows = this.options.owner.sql
      .exec(
        "SELECT record_id FROM approval_records WHERE home_key = ? AND json_extract(record_json, '$.state') = 'pending' AND json_extract(record_json, '$.expiresAt') <= ? ORDER BY record_id LIMIT 100",
        this.homeKey,
        this.options.now(),
      )
      .toArray();
    for (const row of rows) this.get(decode(row).record_id);
  }

  /** Earliest native wake for waiting or unfinished effects; no claim or dispatch. */
  nextWakeAt(): number | null {
    const row = this.options.owner.sql
      .exec(
        "SELECT MIN(CASE WHEN json_extract(record_json, '$.state') = 'pending' THEN json_extract(record_json, '$.expiresAt') ELSE ? END) AS wake_at FROM approval_records WHERE home_key = ? AND json_extract(record_json, '$.state') IN ('pending', 'approved', 'claimed')",
        this.options.now() + 250,
        this.homeKey,
      )
      .toArray()[0];
    const decodeWake = Schema.decodeUnknownSync(
      Schema.Struct({
        wake_at: Schema.NullOr(ApprovalRecordSchema.fields.expiresAt),
      }),
    );
    const effects = decodeWake(row).wake_at;
    if (this.options.resultDelivery === undefined) return effects;
    const now = this.options.now();
    const results = decodeWake(
      this.options.owner.sql
        .exec(
          "SELECT MIN(COALESCE(h.next_attempt_at, ?)) AS wake_at FROM approval_handoffs h JOIN approval_records r ON r.home_key = h.home_key AND r.record_id = h.record_id WHERE h.home_key = ? AND h.command_id IS NULL AND h.undeliverable_at IS NULL AND (json_extract(r.record_json, '$.state') IN ('applied', 'denied', 'expired', 'outcome_unknown') OR (json_extract(r.record_json, '$.state') = 'pending' AND json_extract(r.record_json, '$.expiresAt') <= ?))",
          now,
          this.homeKey,
          now,
        )
        .toArray()[0],
    ).wake_at;
    return effects === null
      ? results
      : results === null
        ? effects
        : Math.min(effects, results);
  }

  /** Bounded approved work for the native owner; selection never claims or dispatches. */
  pendingApplications(): readonly string[] {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({ record_id: ApprovalRecordSchema.fields.recordId }),
    );
    return this.options.owner.sql
      .exec(
        "SELECT record_id FROM approval_records WHERE home_key = ? AND json_extract(record_json, '$.state') = 'approved' ORDER BY record_id LIMIT 100",
        this.homeKey,
      )
      .toArray()
      .map((row) => decode(row).record_id);
  }

  /** Bounded, home-local terminal notices for the native owner's work loop. */
  pendingHandoffs(): readonly string[] {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({
        record_id: ApprovalRecordSchema.fields.recordId,
      }),
    );
    return this.options.owner.sql
      .exec(
        "SELECT h.record_id FROM approval_handoffs h JOIN approval_records r ON r.home_key = h.home_key AND r.record_id = h.record_id WHERE h.home_key = ? AND h.command_id IS NULL AND h.undeliverable_at IS NULL AND (h.next_attempt_at IS NULL OR h.next_attempt_at <= ?) AND (json_extract(r.record_json, '$.state') IN ('applied', 'denied', 'expired', 'outcome_unknown') OR (json_extract(r.record_json, '$.state') = 'pending' AND json_extract(r.record_json, '$.expiresAt') <= ?)) ORDER BY h.record_id LIMIT 100",
        this.homeKey,
        this.options.now(),
        this.options.now(),
      )
      .toArray()
      .map((row) => decode(row).record_id);
  }

  /**
   * Retry only the ordinary message, with the same recipient-side idempotency key.
   * A send rejection leaves the intent pending; it never reopens effect execution.
   * The host must return the real Session acceptance, not a success-shaped placeholder.
   */
  async handoff(
    recordId: string,
    send: (
      notice: ApprovalResultNotice,
    ) => Promise<Readonly<{ commandId: string }>>,
  ): Promise<ApprovalHandoffResult> {
    const record = this.get(recordId);
    if (record === null) return { kind: "refused", reason: "not-found" };
    const receipt = () => {
      const raw = this.options.owner.sql
        .exec(
          "SELECT command_id, delivery_id, attempts, undeliverable_at FROM approval_handoffs WHERE home_key = ? AND record_id = ?",
          this.homeKey,
          recordId,
        )
        .toArray()[0];
      return raw === undefined
        ? null
        : Schema.decodeUnknownSync(
            Schema.Struct({
              command_id: Schema.NullOr(Schema.String),
              delivery_id: Schema.String,
              attempts: Schema.Int,
              undeliverable_at: Schema.NullOr(Schema.Int),
            }),
          )(raw);
    };
    const previous = receipt();
    if (previous === null) return { kind: "not-required" };
    if (previous.command_id !== null)
      return { kind: "delivered", commandId: previous.command_id };
    if (previous.undeliverable_at !== null) return { kind: "undeliverable" };
    let result: ApprovalApplyResult;
    switch (record.state) {
      case "applied": {
        const output = this.payload(recordId).output_json;
        if (output === null)
          throw new Error("Applied approval has no recorded output");
        result = { kind: "applied", record, output: decodeJson(output) };
        break;
      }
      case "denied":
        result = { kind: "refused", reason: record.reason ?? "declined" };
        break;
      case "expired":
        result = { kind: "refused", reason: "expired" };
        break;
      case "outcome_unknown":
        result = { kind: "refused", reason: "outcome-unknown" };
        break;
      case "claimed":
        return { kind: "refused", reason: "in-flight" };
      case "requested":
      case "pending":
      case "approved":
        return { kind: "refused", reason: "pending" };
    }
    let accepted: Readonly<{ commandId: string }>;
    try {
      // The minted id is the recipient's idempotency key on every retry.
      accepted = await send({
        deliveryId: previous.delivery_id,
        record,
        result,
      });
    } catch (cause) {
      const delivery = this.options.resultDelivery;
      if (delivery !== undefined) {
        const attempt = previous.attempts + 1;
        // An absent or erased requester never accepts: stop, keep the record.
        if (attempt >= delivery.attemptLimit) {
          this.options.owner.sql.exec(
            "UPDATE approval_handoffs SET attempts = ?, next_attempt_at = NULL, undeliverable_at = ? WHERE home_key = ? AND record_id = ? AND command_id IS NULL",
            attempt,
            this.options.now(),
            this.homeKey,
            recordId,
          );
          return { kind: "undeliverable" };
        }
        this.options.owner.sql.exec(
          "UPDATE approval_handoffs SET attempts = ?, next_attempt_at = ? WHERE home_key = ? AND record_id = ? AND command_id IS NULL",
          attempt,
          this.options.now() + delivery.retryDelay(attempt),
          this.homeKey,
          recordId,
        );
      }
      throw cause;
    }
    return this.options.owner.transactionSync(() => {
      const current = receipt();
      if (current === null)
        throw new Error("Approval result delivery intent is missing");
      if (
        current.command_id !== null &&
        current.command_id !== accepted.commandId
      )
        throw new Error("Approval result delivery identity conflicted");
      this.options.owner.sql.exec(
        "UPDATE approval_handoffs SET command_id = ? WHERE home_key = ? AND record_id = ? AND command_id IS NULL",
        accepted.commandId,
        this.homeKey,
        recordId,
      );
      return { kind: "delivered", commandId: accepted.commandId };
    });
  }

  /**
   * The home's work loop: only a durable approved record claims the existing
   * host operation, and its result always reaches a waiting Agent as a message.
   */
  apply(
    recordId: string,
    host: ApprovalApplyHost,
  ): Promise<ApprovalApplyResult> {
    return this.run(recordId, host, true);
  }

  /**
   * Apply the caller's own just-staged policy approval inside its live tool
   * call; that call's result is the outcome, so no later message is owed.
   */
  applyInline(
    recordId: string,
    host: ApprovalApplyHost,
  ): Promise<ApprovalApplyResult> {
    return this.run(recordId, host, false);
  }

  private async run(
    recordId: string,
    host: ApprovalApplyHost,
    deferred: boolean,
  ): Promise<ApprovalApplyResult> {
    const claim = this.options.owner.transactionSync(() => {
      const record = this.get(recordId);
      if (record === null)
        return {
          kind: "refused",
          reason: "not-found",
        } satisfies ApprovalRefusal;
      if (record.state === "applied") {
        const output = this.payload(recordId).output_json;
        if (output === null)
          throw new Error("Applied approval has no recorded output");
        return {
          kind: "applied",
          record,
          output: decodeJson(output),
        } satisfies ApprovalApplyResult;
      }
      if (record.state === "expired")
        return { kind: "refused", reason: "expired" } satisfies ApprovalRefusal;
      if (record.state === "denied")
        return {
          kind: "refused",
          reason: record.reason ?? "declined",
        } satisfies ApprovalRefusal;
      if (record.state === "claimed")
        return {
          kind: "refused",
          reason: "in-flight",
        } satisfies ApprovalRefusal;
      if (record.state === "outcome_unknown")
        return {
          kind: "refused",
          reason: "outcome-unknown",
        } satisfies ApprovalRefusal;
      if (record.state !== "approved")
        return { kind: "refused", reason: "pending" } satisfies ApprovalRefusal;
      const input = decodeJson(this.payload(recordId).input_json);
      const claimed: ApprovalRecord = {
        ...record,
        state: "claimed",
        updatedAt: this.options.now(),
        revision: record.revision + 1,
      };
      this.save(claimed);
      // A deferred apply (even one policy approved) answers no live tool call.
      if (
        deferred &&
        claimed.requester.agentId !== null &&
        claimed.requester.sessionId !== null
      )
        this.options.owner.sql.exec(
          "INSERT OR IGNORE INTO approval_handoffs (home_key, record_id, delivery_id) VALUES (?, ?, ?)",
          this.homeKey,
          recordId,
          mintDeliveryId(),
        );
      return { kind: "claimed", record: claimed, input } satisfies Readonly<{
        kind: "claimed";
        record: ApprovalRecord;
        input: typeof Schema.Json.Type;
      }>;
    });
    if (claim.kind !== "claimed") return claim;
    try {
      const admission = await host.recheck(claim.record);
      const refusal =
        admission.kind === "refused"
          ? admission.reason
          : admission.authorityFence !== claim.record.authorityFence
            ? "fenced"
            : null;
      if (refusal !== null) return this.finishDenied(claim.record, refusal);
      const completion = await host.dispatch({
        record: claim.record,
        input: claim.input,
      });
      if (completion.kind === "refused")
        return this.finishDenied(claim.record, completion.reason);
      const output = completion.output;
      const outputJson = encodeJson(output);
      return this.options.owner.transactionSync(() => {
        const current = this.get(recordId);
        if (
          current?.state !== "claimed" ||
          current.revision !== claim.record.revision
        )
          return { kind: "refused", reason: "outcome-unknown" };
        this.options.owner.sql.exec(
          "UPDATE approval_payloads SET output_json = ? WHERE home_key = ? AND record_id = ?",
          outputJson,
          this.homeKey,
          recordId,
        );
        const applied: ApprovalRecord = {
          ...current,
          state: "applied",
          updatedAt: this.options.now(),
          revision: current.revision + 1,
        };
        this.save(applied);
        return { kind: "applied", record: applied, output };
      });
    } catch {
      // A failed authority read or dispatch cannot authorize a retry of a durable claim.
      return this.options.owner.transactionSync(() => {
        const current = this.get(recordId);
        if (
          current?.state === "claimed" &&
          current.revision === claim.record.revision
        ) {
          this.save({
            ...current,
            state: "outcome_unknown",
            reason: "outcome-unknown",
            updatedAt: this.options.now(),
            revision: current.revision + 1,
          });
        }
        return { kind: "refused", reason: "outcome-unknown" };
      });
    }
  }

  private finishDenied(
    claimed: ApprovalRecord,
    reason: "fenced" | "not-granted" | "read-only",
  ): ApprovalRefusal {
    return this.options.owner.transactionSync(() => {
      const current = this.get(claimed.recordId);
      if (current?.state !== "claimed" || current.revision !== claimed.revision)
        return { kind: "refused", reason: "outcome-unknown" };
      this.save({
        ...current,
        state: "denied",
        reason,
        updatedAt: this.options.now(),
        revision: current.revision + 1,
      });
      return { kind: "refused", reason };
    });
  }

  /** Native host boot only: orphaned durable claims must never be redispatched. */
  recoverClaims(): readonly ApprovalRecord[] {
    return this.options.owner.transactionSync(() => {
      const records = this.options.owner.sql
        .exec(
          "SELECT record_json FROM approval_records WHERE home_key = ? AND json_extract(record_json, '$.state') = 'claimed' ORDER BY record_id LIMIT 100",
          this.homeKey,
        )
        .toArray();
      return records.map((raw) => {
        const record = decodeRecord(decodeRow(raw).record_json);
        const unknown: ApprovalRecord = {
          ...record,
          state: "outcome_unknown",
          reason: "outcome-unknown",
          updatedAt: this.options.now(),
          revision: record.revision + 1,
        };
        this.save(unknown);
        return unknown;
      });
    });
  }

  private payload(recordId: string) {
    const raw = this.options.owner.sql
      .exec(
        "SELECT input_json, output_json FROM approval_payloads WHERE home_key = ? AND record_id = ?",
        this.homeKey,
        recordId,
      )
      .toArray()[0];
    if (raw === undefined)
      throw new Error("Approval has no persisted operation payload");
    return decodePayload(raw);
  }

  private save(record: ApprovalRecord): void {
    this.options.owner.sql.exec(
      "UPDATE approval_records SET record_json = ? WHERE home_key = ? AND record_id = ?",
      encodeRecord(record),
      this.homeKey,
      record.recordId,
    );
  }

  /** Read a record from this home only; the maintained decoder owns stored JSON. */
  get(recordId: string): ApprovalRecord | null {
    return this.options.owner.transactionSync(() => {
      const raw = this.options.owner.sql
        .exec(
          "SELECT record_json FROM approval_records WHERE home_key = ? AND record_id = ?",
          this.homeKey,
          recordId,
        )
        .toArray()[0];
      if (raw === undefined) return null;
      const record = decodeRecord(decodeRow(raw).record_json);
      const now = this.options.now();
      if (record.state !== "pending" || now < record.expiresAt) return record;
      const expired: ApprovalRecord = {
        ...record,
        state: "expired",
        reason: "expired",
        updatedAt: now,
        revision: record.revision + 1,
      };
      this.save(expired);
      return expired;
    });
  }
}
