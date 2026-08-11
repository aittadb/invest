import {
  parseStableId,
  type StableId,
} from "../domain/foundation.ts";
import { parseStorageOperationId } from "../domain/storage-adapter.ts";

const NOTIFICATION_ID_NAMESPACE = "indication-rejection-notification";
const NOTIFICATION_PURPOSE_ID_NAMESPACE = "indication-rejection-purpose";

export const OWNER_INDICATION_REJECTION_NOTIFICATION_SUBJECT =
  "Update about your investment indication";

/** Stable identity shared by the atomic rejection and owner detail lanes. */
export async function ownerIndicationRejectionNotificationId(
  value: unknown,
): Promise<StableId<"manual-notification">> {
  return derivedId<"manual-notification">(NOTIFICATION_ID_NAMESPACE, value);
}

/** Stable purpose identity produced by the atomic rejection transaction. */
export async function ownerIndicationRejectionNotificationPurposeId(
  value: unknown,
): Promise<StableId<"notification-purpose">> {
  return derivedId<"notification-purpose">(
    NOTIFICATION_PURPOSE_ID_NAMESPACE,
    value,
  );
}

/** Exact bounded body composed by the atomic rejection transaction. */
export function ownerIndicationRejectionNotificationBody(reason: string): string {
  return `Your investment indication was rejected.\n\nReason: ${reason}`;
}

async function derivedId<Entity extends string>(
  namespace: string,
  value: unknown,
): Promise<StableId<Entity>> {
  const operationId = parseStorageOperationId(value);
  if (!operationId.ok) failure();
  const digest = await sha256Hex(
    `${namespace}\u0000${operationId.value}`,
  );
  const parsed = parseStableId<Entity>(
    `${namespace}:${digest}`,
  );
  if (!parsed.ok) failure();
  return parsed.value;
}

async function sha256Hex(value: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return failure();
  }
}

function failure(): never {
  throw new Error("Owner indication notification identity is unavailable.");
}
