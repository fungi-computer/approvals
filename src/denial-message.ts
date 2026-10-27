import type { ApprovalRecord } from "./contract.js";

/** Host-supplied human identity; the bounded reason remains quoted user text. */
export function denialFeedbackOpening(
  record: ApprovalRecord,
  person: string,
): string | null {
  return record.state === "denied" &&
    record.by?.kind === "human" &&
    record.denialNote !== undefined
    ? `Denied by ${JSON.stringify(person)}: ${JSON.stringify(record.denialNote)}`
    : null;
}
