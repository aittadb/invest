import type { AmountConfiguration } from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationParsingOptions,
  RejectedInvestmentIndication,
} from "../domain/investment-indication.ts";
import {
  StorageFailure,
  parseStorageKey,
  type StorageAdapter,
  type StorageKey,
} from "../domain/storage-adapter.ts";
import type {
  OwnerIndicationModerationItem,
  OwnerIndicationNotificationSnapshot,
  OwnerIndicationReviewDetailRepository,
} from "../services/owner-indication-moderation.ts";
import {
  OWNER_INDICATION_REJECTION_NOTIFICATION_SUBJECT,
  ownerIndicationRejectionNotificationBody,
  ownerIndicationRejectionNotificationId,
  ownerIndicationRejectionNotificationPurposeId,
} from "../services/owner-indication-notification-identity.ts";
import { DevelopmentInMemoryManualNotificationRepository } from "./in-memory-audit-notification-repositories.ts";
import { DevelopmentInMemoryIndicationRepository } from "./in-memory-indication-repository.ts";

const MAX_REVIEW_ID_LENGTH = 192;
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const CURRENT_KEY_PATTERN = /^indication-current:[0-9a-f]{64}$/u;

/** Narrow bridge to the deployment-key-backed opaque review token boundary. */
export interface OwnerIndicationReviewIdResolver {
  currentKeyForReviewId(
    reviewId: unknown,
    ownerSubject: ActorSubject,
  ): Promise<StorageKey>;
}

/** Persistent owner-only projection for one opaque indication review resource. */
export class StorageOwnerIndicationReviewDetailRepository
  implements OwnerIndicationReviewDetailRepository {
  readonly #storage: StorageAdapter;
  readonly #configuredOwnerSubject: ActorSubject | null;
  readonly #reviewIds: OwnerIndicationReviewIdResolver;
  readonly #indications: DevelopmentInMemoryIndicationRepository;
  readonly #notifications: DevelopmentInMemoryManualNotificationRepository;
  readonly #permitted: boolean;

  constructor(
    storage: StorageAdapter,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject | null,
    amountConfiguration: AmountConfiguration,
    reviewIds: OwnerIndicationReviewIdResolver,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#storage = requiredStorage(storage);
    const actor = optionalSubject(authenticatedSubject);
    this.#configuredOwnerSubject = optionalSubject(configuredOwnerSubject);
    this.#reviewIds = requiredReviewIdResolver(reviewIds);
    this.#permitted = actor !== null &&
      actor === this.#configuredOwnerSubject;
    this.#indications = new DevelopmentInMemoryIndicationRepository(
      this.#storage,
      actor,
      this.#configuredOwnerSubject,
      amountConfiguration,
      parsingOptions,
    );
    this.#notifications = new DevelopmentInMemoryManualNotificationRepository(
      this.#storage,
    );
    Object.freeze(this);
  }

  async get(reviewId: unknown): Promise<OwnerIndicationModerationItem | null> {
    if (!this.#permitted || this.#configuredOwnerSubject === null) return null;
    const token = optionalReviewId(reviewId);
    if (token === null) return null;
    let resolved: StorageKey;
    try {
      resolved = await this.#reviewIds.currentKeyForReviewId(
        token,
        this.#configuredOwnerSubject,
      );
    } catch (error) {
      if (isInvalidTokenFailure(error)) return null;
      throw new StorageFailure("UNAVAILABLE");
    }
    let key: StorageKey;
    try {
      key = requiredCurrentKey(resolved);
    } catch {
      throw new StorageFailure("UNAVAILABLE");
    }

    try {
      const projection = await this.#indications
        .getOwnerProjectionByCurrentKey(key);
      if (projection === null) return null;
      const notification = await this.#notificationFor(
        projection.indication,
        projection.terminalOperationId,
      );
      return Object.freeze({
        reviewId: token,
        indication: projection.indication,
        notification,
      });
    } catch {
      throw new StorageFailure("UNAVAILABLE");
    }
  }

  async #notificationFor(
    indication: InvestmentIndication,
    terminalOperationId: unknown,
  ): Promise<OwnerIndicationNotificationSnapshot | null> {
    if (indication.lifecycle.status !== "rejected") return null;
    const rejected = indication as RejectedInvestmentIndication;
    const history = rejected.history.at(-1);
    if (
      history === undefined ||
      history.transition !== "rejected" ||
      history.revision !== rejected.revision
    ) unavailable();
    const id = await ownerIndicationRejectionNotificationId(
      terminalOperationId,
    );
    const purposeId = await ownerIndicationRejectionNotificationPurposeId(
      terminalOperationId,
    );
    const notification = await this.#notifications.get(id);
    if (notification === null) unavailable();
    const configuredOwnerSubject = this.#configuredOwnerSubject;
    if (configuredOwnerSubject === null) unavailable();
    requireMatchingNotification(
      rejected,
      notification,
      id,
      purposeId,
      configuredOwnerSubject,
    );
    return notification;
  }
}

function requireMatchingNotification(
  indication: RejectedInvestmentIndication,
  notification: OwnerIndicationNotificationSnapshot,
  expectedId: string,
  expectedPurposeId: string,
  configuredOwnerSubject: ActorSubject,
): void {
  const template = notification.record.template;
  const rejection = indication.lifecycle.rejection;
  const permittedActivitySubjects = new Set([
    rejection.rejectedBy.subject,
    configuredOwnerSubject,
  ]);
  if (
    template.id !== expectedId ||
    template.purposeId !== expectedPurposeId ||
    template.recipientSubject !== indication.participantSubject ||
    template.relatedResource.type !== "investment-indication" ||
    String(template.relatedResource.id) !== String(indication.id) ||
    template.subjectLine !== OWNER_INDICATION_REJECTION_NOTIFICATION_SUBJECT ||
    template.body !==
      ownerIndicationRejectionNotificationBody(rejection.reason) ||
    template.generatedAt !== rejection.rejectedAt ||
    template.generatedBy.type !== "owner" ||
    template.generatedBy.subject !== rejection.rejectedBy.subject ||
    notification.record.copyEvidence.some((evidence) =>
      evidence.copiedBy.type !== "owner" ||
      !permittedActivitySubjects.has(evidence.copiedBy.subject)
    ) ||
    notification.record.sentMarker !== null &&
      (notification.record.sentMarker.sentBy.type !== "owner" ||
        !permittedActivitySubjects.has(
          notification.record.sentMarker.sentBy.subject,
        ))
  ) unavailable();
}

function requiredStorage(value: unknown): StorageAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as StorageAdapter).read !== "function" ||
    typeof (value as StorageAdapter).list !== "function" ||
    typeof (value as StorageAdapter).transact !== "function"
  ) invalid();
  return value as StorageAdapter;
}

function requiredReviewIdResolver(
  value: unknown,
): OwnerIndicationReviewIdResolver {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as OwnerIndicationReviewIdResolver)
        .currentKeyForReviewId !== "function"
  ) invalid();
  return value as OwnerIndicationReviewIdResolver;
}

function optionalSubject(value: unknown): ActorSubject | null {
  if (value === null) return null;
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function optionalReviewId(value: unknown): string | null {
  return typeof value === "string" &&
      value.length >= 1 &&
      value.length <= MAX_REVIEW_ID_LENGTH &&
      /^[A-Za-z0-9._-]+$/u.test(value)
    ? value
    : null;
}

function requiredCurrentKey(value: unknown): StorageKey {
  const source = exactRecord(value, STORAGE_KEY_KEYS);
  const parsed = parseStorageKey(source.collection, source.id);
  if (
    !parsed.ok ||
    parsed.value.collection !== "investment-indications" ||
    !CURRENT_KEY_PATTERN.test(parsed.value.id)
  ) invalid();
  return parsed.value;
}

function isInvalidTokenFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, "code");
  } catch {
    return false;
  }
  return descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.value === "INVALID_TOKEN";
}

function exactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) invalid();
  const prototype = Reflect.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null ||
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) invalid();
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function invalid(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
