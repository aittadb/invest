import {
  parseStableId,
  type StableId,
} from "../domain/foundation.ts";
import { parseStorageOperationId } from "../domain/storage-adapter.ts";

const NOTIFICATION_ID_NAMESPACE = "indication-rejection-notification";

/** Stable identity shared by the atomic rejection and owner detail lanes. */
export async function ownerIndicationRejectionNotificationId(
  value: unknown,
): Promise<StableId<"manual-notification">> {
  const operationId = parseStorageOperationId(value);
  if (!operationId.ok) failure();
  const digest = await sha256Hex(
    `${NOTIFICATION_ID_NAMESPACE}\u0000${operationId.value}`,
  );
  const parsed = parseStableId<"manual-notification">(
    `indication-rejection-notification:${digest}`,
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
