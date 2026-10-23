import * as Schema from "effect/Schema";

const Identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

/** The effect class is independent of reversibility; ON includes both. */
export const ApprovalAccessSchema = Schema.Literals(["write", "external"]);
/** One operation module, or every module when module is null. */
export const ApprovalFamilySchema = Schema.Struct({
  module: Schema.NullOr(Identity),
  access: ApprovalAccessSchema,
});
/** One requesting Agent, or the entire home when agentId is null. */
export const ApprovalScopeSchema = Schema.Struct({
  agentId: Schema.NullOr(Identity),
});
/** Stable requester identity supplied by the host, never by tool arguments. */
export const ApprovalRequesterSchema = Schema.Struct({
  principalId: Identity,
  agentId: Schema.NullOr(Identity),
  sessionId: Schema.NullOr(Identity),
  displayName: Identity,
});
/** A renderer sees metadata and a byte digest, never the proposed input. */
export const ApprovalDescriptionSchema = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  inputBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inputSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
/** Immediate normal tool result: no effect ran and no Agent turn is suspended. */
export const PendingApprovalSchema = Schema.Struct({
  kind: Schema.Literal("pending_approval"),
  recordId: Identity,
  description: ApprovalDescriptionSchema,
});
/** Deferred apply is delivered later through the existing Agent new-message path. */
export type PendingApproval = typeof PendingApprovalSchema.Type;
/** All renderers use these same durable lifecycle states. */
export const ApprovalStateSchema = Schema.Literals([
  "requested",
  "pending",
  "approved",
  "claimed",
  "applied",
  "denied",
  "expired",
  "outcome_unknown",
]);
/** Why a decision or apply was refused; unknown dispatch is never a denial. */
export const ApprovalRefusalReasonSchema = Schema.Literals([
  "not-found",
  "not-eligible",
  "already-answered",
  "stale-revision",
  "expired",
  "declined",
  "fenced",
  "not-granted",
  "read-only",
  "pending",
  "in-flight",
  "outcome-unknown",
  "identity-conflict",
]);
/** Defensive display limits, not authority to fetch or interpret image content. */
export const MAX_APPROVAL_EVIDENCE = 4;
/** Maximum attested PNG byte length in one evidence descriptor. */
export const MAX_APPROVAL_EVIDENCE_BYTES = 5 * 1024 * 1024;
/** Capability-attested content address; image bytes remain untrusted display-only data. */
export const ApprovalEvidenceSchema = Schema.Array(
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    ref: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
    mediaType: Schema.Literal("image/png"),
    bytes: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_APPROVAL_EVIDENCE_BYTES),
    ),
  }),
).check(Schema.isMaxLength(MAX_APPROVAL_EVIDENCE));
/** Metadata only: never raw image bytes, prose, URLs or executable content. */
export type ApprovalEvidence = typeof ApprovalEvidenceSchema.Type;

/** Public record. Effect input, output and executable continuations stay host-private. */
export const ApprovalRecordSchema = Schema.Struct({
  recordId: Identity,
  requester: ApprovalRequesterSchema,
  module: Identity,
  operation: Identity,
  access: ApprovalAccessSchema,
  description: ApprovalDescriptionSchema,
  evidence: Schema.optionalKey(ApprovalEvidenceSchema),
  authorityFence: Identity,
  reversibility: Schema.Literals(["reversible", "irreversible-external"]),
  state: ApprovalStateSchema,
  by: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("human"), memberId: Identity }),
      Schema.Struct({ kind: Schema.Literal("policy") }),
    ]),
  ),
  reason: Schema.NullOr(ApprovalRefusalReasonSchema),
  requestedAt: Timestamp,
  expiresAt: Timestamp,
  updatedAt: Timestamp,
  revision: Revision,
});
/** Rights are recomputed for the holder on each read, not persisted on the record. */
export const ApprovalViewSchema = Schema.Struct({
  record: ApprovalRecordSchema,
  canAnswer: Schema.Boolean,
  canSetAutoApprove: Schema.Boolean,
});
/** Bounded reads with an opaque storage cursor. */
export const ApprovalListInputSchema = Schema.Struct({
  state: Schema.optionalKey(ApprovalStateSchema),
  cursor: Schema.optionalKey(Identity),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
});
/** Locate one public view without carrying actor identity in request data. */
export const ApprovalGetInputSchema = Schema.Struct({ recordId: Identity });
/** An answer is a decision, never a confirm-labelled write itself. */
export const ApprovalAnswerInputSchema = Schema.Struct({
  recordId: Identity,
  decision: Schema.Literals(["approve", "deny"]),
  expectedRevision: Revision,
});
/** Explicit policy mutation. A false rule narrows a broader true rule. */
export const AutoApproveInputSchema = Schema.Struct({
  scope: ApprovalScopeSchema,
  family: ApprovalFamilySchema,
  enabled: Schema.Boolean,
});

/** Durable approval visible to every renderer. */
export type ApprovalRecord = typeof ApprovalRecordSchema.Type;
/** Current holder's projection. A disabled button is not an authorization check. */
export type ApprovalView = typeof ApprovalViewSchema.Type;
/** Bounded listing request. */
export type ApprovalListInput = typeof ApprovalListInputSchema.Type;
/** Revision-pinned answer. No actor identity is accepted on the wire. */
export type ApprovalAnswerInput = typeof ApprovalAnswerInputSchema.Type;
/** One per-home or per-Agent module/access rule. */
export type AutoApproveInput = typeof AutoApproveInputSchema.Type;
/** One typed refusal shared by answer/apply/policy entrypoints. */
export type ApprovalRefusal = Readonly<{
  kind: "refused";
  reason: typeof ApprovalRefusalReasonSchema.Type;
}>;
/** The member-bound capability. Host authentication supplies the actor. */
export type Approvals = Readonly<{
  /** List a bounded page of this home's records for the current member. */
  list(
    input: ApprovalListInput,
  ): Promise<
    Readonly<{ items: readonly ApprovalView[]; nextCursor: string | null }>
  >;
  /** Read a member-scoped record view, or null when inaccessible. */
  get(input: Readonly<{ recordId: string }>): Promise<ApprovalView | null>;
  /** Record one current-member decision against the supplied record revision. */
  answer(
    input: ApprovalAnswerInput,
  ): Promise<
    Readonly<{ kind: "answered"; view: ApprovalView }> | ApprovalRefusal
  >;
  /** Update family policy without granting operation authority. */
  setAutoApprove(
    input: AutoApproveInput,
  ): Promise<
    Readonly<{ kind: "updated"; rule: AutoApproveInput }> | ApprovalRefusal
  >;
}>;
