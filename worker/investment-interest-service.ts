import {
  parseAmountAggregateConfiguration,
  parseConfiguredAmount,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseAuditAppendIntent,
  type AuditAppendIntent,
  type AuditEvent,
  type ResourceTransition,
} from "../domain/audit-notification.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  participantVisibleIndicationLifecycle,
  type ActiveInvestmentIndication,
  type InvestmentIndication,
  type InvestmentIndicationHistoryEntryId,
  type InvestmentIndicationId,
  type ParticipantInvestmentIndicationSummary,
  type ParticipantVisibleIndicationTransition,
  type TrustedPackageAcknowledgmentContext,
  type WithdrawnInvestmentIndication,
} from "../domain/investment-indication.ts";
import type { StoredInvestmentAggregateSnapshot } from "../domain/investment-aggregate.ts";
import { requiresRenewedAcceptance } from "../domain/package-content.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import type {
  CreateIndicationRequest,
  EditIndicationRequest,
  IndicationMutationResult,
  ReactivateIndicationRequest,
  WithdrawIndicationRequest,
} from "../repositories/in-memory-indication-repository.ts";
import {
  MAX_PARTICIPANT_INVESTMENT_INTERESTS,
} from "../domain/participant-investment-interest-resource.ts";
import {
  PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY,
  type AtomicParticipantInvestmentInterestCommand,
  type AtomicParticipantInvestmentInterestMutationPort,
  type AtomicParticipantInvestmentInterestResult,
  type ParticipantInvestmentInterestReader,
} from "./participant-investment-mutation-port.ts";

export const MAX_PARTICIPANT_INTERESTS =
  MAX_PARTICIPANT_INVESTMENT_INTERESTS;

export type InvestmentInterestKind = InvestmentIndication["kind"];

export type InvestmentInterestPermissions = Readonly<{
  createPersonal: boolean;
  createCompany: boolean;
  reactivatePersonal: boolean;
  reactivateCompany: boolean;
}>;

export type InvestmentInterestCollectionState = Readonly<{
  indications: readonly ParticipantInvestmentIndicationSummary[];
  amountConfiguration: AmountConfiguration;
  acknowledgmentCurrent: boolean;
  canCreatePersonal: boolean;
  canCreateCompany: boolean;
}>;

export type InvestmentInterestItemState = Readonly<{
  indication: InvestmentIndication;
  amountConfiguration: AmountConfiguration;
  acknowledgmentCurrent: boolean;
  canEdit: boolean;
  canWithdraw: boolean;
  canReactivate: boolean;
}>;

export type CreateInvestmentInterestInput = Readonly<{
  operationId: unknown;
  fields: unknown;
}>;

export type EditInvestmentInterestInput = Readonly<{
  operationId: unknown;
  indicationId: unknown;
  expectedRevision: number;
  fields: unknown;
}>;

export type WithdrawInvestmentInterestInput = Readonly<{
  operationId: unknown;
  indicationId: unknown;
  expectedRevision: number;
}>;

export type ReactivateInvestmentInterestInput = Readonly<{
  operationId: unknown;
  indicationId: unknown;
  expectedRevision: number;
}>;

export interface ParticipantInvestmentInterestService {
  getCollectionState(): Promise<InvestmentInterestCollectionState>;
  getItemState(
    indicationId: unknown,
  ): Promise<InvestmentInterestItemState | null>;
  create(
    input: CreateInvestmentInterestInput,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>>;
  edit(
    input: EditInvestmentInterestInput,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>>;
  withdraw(
    input: WithdrawInvestmentInterestInput,
  ): Promise<IndicationMutationResult<WithdrawnInvestmentIndication>>;
  reactivate(
    input: ReactivateInvestmentInterestInput,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>>;
}

export type ParticipantInvestmentInterestServiceFactory = (
  actorSubject: ActorSubject,
) => ParticipantInvestmentInterestService;

export type InvestmentInterestServiceOptions = Readonly<{
  actorSubject: ActorSubject;
  amountConfiguration: AmountConfiguration;
  reader: ParticipantInvestmentInterestReader;
  mutations: AtomicParticipantInvestmentInterestMutationPort;
  loadAcknowledgmentContext: () =>
    | TrustedPackageAcknowledgmentContext
    | null
    | Promise<TrustedPackageAcknowledgmentContext | null>;
  loadPermissions: () =>
    | InvestmentInterestPermissions
    | Promise<InvestmentInterestPermissions>;
  indicationIdForOperation: (
    operationId: StorageOperationId,
  ) => InvestmentIndicationId;
  now?: () => Date;
}>;

type MutationMetadata = Readonly<{
  operationId: StorageOperationId;
  historyEntryId: InvestmentIndicationHistoryEntryId;
  occurredAt: Timestamp;
  replayKnown: boolean;
}>;

/**
 * Compose one participant's investment use case from request-scoped,
 * deployment-supplied repositories and policy. No runtime state is retained.
 */
export function createParticipantInvestmentInterestService(
  options: InvestmentInterestServiceOptions,
): ParticipantInvestmentInterestService {
  const actorSubject = requiredActorSubject(options.actorSubject);
  const amountConfiguration = requiredAmountConfiguration(
    options.amountConfiguration,
  );
  const now = options.now ?? (() => new Date());

  if (
    typeof options.reader !== "object" ||
    options.reader === null ||
    typeof options.reader.get !== "function" ||
    typeof options.reader.listOwned !== "function" ||
    typeof options.reader.freshMutationCurrencyCompatible !== "function" ||
    typeof options.mutations !== "object" ||
    options.mutations === null ||
    options.mutations.mutationConsistency !==
      PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY ||
    typeof options.mutations.commit !== "function" ||
    typeof options.loadAcknowledgmentContext !== "function" ||
    typeof options.loadPermissions !== "function" ||
    typeof options.indicationIdForOperation !== "function" ||
    typeof now !== "function"
  ) {
    invalidConfiguration();
  }

  const loadOwned = async (
    id: InvestmentIndicationId,
  ): Promise<InvestmentIndication | null> => {
    const indication = await options.reader.get(id);
    if (indication === null) return null;
    if (indication.id !== id) unavailable();
    if (indication.participantSubject !== actorSubject) return null;
    return indication;
  };

  const listOwned = async ():
    Promise<readonly ParticipantInvestmentIndicationSummary[]> => {
    let values: unknown;
    try {
      values = await options.reader.listOwned();
    } catch (error) {
      if (error instanceof StorageFailure) throw error;
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    if (
      !Array.isArray(values) ||
      values.length > MAX_PARTICIPANT_INTERESTS
    ) {
      unavailable();
    }

    const seen = new Set<string>();
    const indications: ParticipantInvestmentIndicationSummary[] = [];
    for (
      const candidate of values as readonly ParticipantInvestmentIndicationSummary[]
    ) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        candidate.participantSubject !== actorSubject ||
        typeof candidate.id !== "string" ||
        seen.has(candidate.id)
      ) {
        unavailable();
      }
      seen.add(candidate.id);
      indications.push(candidate);
    }

    indications.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      String(left.id).localeCompare(String(right.id))
    );
    return Object.freeze(indications);
  };

  const loadPermissions = async (): Promise<InvestmentInterestPermissions> => {
    let value: unknown;
    try {
      value = await options.loadPermissions();
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    return requiredPermissions(value);
  };

  const loadFreshMutationCurrencyCompatibility = async (): Promise<boolean> => {
    let value: unknown;
    try {
      value = await options.reader.freshMutationCurrencyCompatible();
    } catch (error) {
      if (error instanceof StorageFailure) throw error;
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    if (typeof value !== "boolean") unavailable();
    return value;
  };

  const loadAcknowledgmentContext = async ():
    Promise<TrustedPackageAcknowledgmentContext | null> => {
    let value: TrustedPackageAcknowledgmentContext | null;
    try {
      value = await options.loadAcknowledgmentContext();
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    if (value !== null && (typeof value !== "object" || value === null)) {
      unavailable();
    }
    return value;
  };

  const acknowledgmentIsCurrent = (
    context: TrustedPackageAcknowledgmentContext | null,
  ): boolean => {
    if (
      context === null ||
      context.latestAcceptance === null ||
      context.latestAcceptance.participantSubject !== actorSubject
    ) {
      return false;
    }
    try {
      return !requiresRenewedAcceptance(
        context.currentVersion,
        context.latestAcceptance,
      );
    } catch {
      unavailable();
    }
  };

  const requiredMutationContext = async (
    replayKnown: boolean,
  ): Promise<TrustedPackageAcknowledgmentContext> => {
    const context = await loadAcknowledgmentContext();
    if (context === null || (!replayKnown && !acknowledgmentIsCurrent(context))) {
      preconditionFailed();
    }
    return context;
  };

  const mutationMetadata = async (
    operation: unknown,
    current: InvestmentIndication | null,
  ): Promise<MutationMetadata> => {
    const operationId = parseStorageOperationId(operation);
    const historyEntryId =
      parseStableId<"investment-indication-history-entry">(operation);
    if (!operationId.ok || !historyEntryId.ok) invalidRequest();

    const priorEntry = current?.history.find(
      (entry) => entry.id === historyEntryId.value,
    );
    if (priorEntry) {
      return Object.freeze({
        operationId: operationId.value,
        historyEntryId: historyEntryId.value,
        occurredAt: priorEntry.occurredAt,
        replayKnown: true,
      });
    }

    let date: Date;
    try {
      date = now();
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) unavailable();
    const occurredAt = parseTimestamp(date.toISOString());
    if (
      !occurredAt.ok ||
      (current !== null && occurredAt.value < current.updatedAt)
    ) {
      unavailable();
    }

    return Object.freeze({
      operationId: operationId.value,
      historyEntryId: historyEntryId.value,
      occurredAt: occurredAt.value,
      replayKnown: false,
    });
  };

  const idForOperation = (
    operationId: StorageOperationId,
  ): InvestmentIndicationId => {
    let value: unknown;
    try {
      value = options.indicationIdForOperation(operationId);
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    const parsed = parseStableId<"investment-indication">(value);
    if (!parsed.ok) unavailable();
    return parsed.value;
  };

  const commitAtomic = async (
    command: AtomicParticipantInvestmentInterestCommand,
    historicalCurrencyAllowed: boolean,
  ): Promise<AtomicParticipantInvestmentInterestResult> => {
    let result: AtomicParticipantInvestmentInterestResult;
    try {
      result = await options.mutations.commit(command);
    } catch (error) {
      if (error instanceof StorageFailure) throw error;
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    return requireAtomicMutationResult(
      result,
      command.auditIntent.event,
      amountConfiguration,
      historicalCurrencyAllowed,
    );
  };

  return Object.freeze({
    async getCollectionState() {
      const [
        indications,
        context,
        permissions,
        freshCurrencyCompatible,
      ] = await Promise.all([
        listOwned(),
        loadAcknowledgmentContext(),
        loadPermissions(),
        loadFreshMutationCurrencyCompatibility(),
      ]);
      const acknowledgmentCurrent = acknowledgmentIsCurrent(context);
      const activePersonal = indications.some(
        (indication) =>
          indication.kind === "personal" &&
          indication.lifecycle.status === "active",
      );
      const hasCapacity = indications.length < MAX_PARTICIPANT_INTERESTS;
      return Object.freeze({
        indications,
        amountConfiguration,
        acknowledgmentCurrent,
        canCreatePersonal:
          hasCapacity &&
          acknowledgmentCurrent &&
          freshCurrencyCompatible &&
          permissions.createPersonal &&
          !activePersonal,
        canCreateCompany:
          hasCapacity &&
          acknowledgmentCurrent &&
          freshCurrencyCompatible &&
          permissions.createCompany,
      });
    },

    async getItemState(indicationId: unknown) {
      const id = requiredIndicationId(indicationId);
      const indication = await loadOwned(id);
      if (indication === null) return null;
      const [context, permissions, freshCurrencyCompatible] = await Promise.all([
        loadAcknowledgmentContext(),
        loadPermissions(),
        loadFreshMutationCurrencyCompatibility(),
      ]);
      const acknowledgmentCurrent = acknowledgmentIsCurrent(context);
      const editAvailable = transitionAvailable(indication, "edit");
      const withdrawAvailable = transitionAvailable(indication, "withdraw");
      const reactivateAvailable = transitionAvailable(indication, "reactivate");
      const fieldsUseCurrentCurrency =
        indication.fields.currency === amountConfiguration.currency;
      const fieldsMeetCurrentAmountPolicy = indicationFieldsMeetAmountPolicy(
        indication,
        amountConfiguration,
      );
      return Object.freeze({
        indication,
        amountConfiguration,
        acknowledgmentCurrent,
        canEdit:
          editAvailable &&
          fieldsUseCurrentCurrency &&
          freshCurrencyCompatible &&
          acknowledgmentCurrent,
        canWithdraw: withdrawAvailable,
        canReactivate:
          reactivateAvailable &&
          fieldsMeetCurrentAmountPolicy &&
          freshCurrencyCompatible &&
          acknowledgmentCurrent &&
          (indication.kind === "personal"
            ? permissions.reactivatePersonal
            : permissions.reactivateCompany),
      });
    },

    async create(input: CreateInvestmentInterestInput) {
      const operationId = requiredOperationId(input.operationId);
      const id = idForOperation(operationId);
      const current = await loadOwned(id);
      const metadata = await mutationMetadata(operationId, current);
      const kind = requiredFieldsKind(input.fields);
      if (!metadata.replayKnown) {
        const [permissions, freshCurrencyCompatible] = await Promise.all([
          loadPermissions(),
          loadFreshMutationCurrencyCompatibility(),
        ]);
        if (
          !freshCurrencyCompatible ||
          (kind === "personal" && !permissions.createPersonal) ||
          (kind === "company" && !permissions.createCompany)
        ) {
          preconditionFailed();
        }
      }
      const acknowledgmentContext = await requiredMutationContext(
        metadata.replayKnown,
      );
      const request = createRequest(id, metadata, input.fields);
      const auditIntent = participantAuditIntent(
        metadata,
        actorSubject,
        id,
        "created",
      );
      const result = await commitAtomic(Object.freeze({
        kind: "create",
        request,
        acknowledgmentContext,
        auditIntent,
      }), metadata.replayKnown);
      return requireOwnedActiveResult(
        result.indication,
        actorSubject,
        id,
      );
    },

    async edit(input: EditInvestmentInterestInput) {
      const id = requiredIndicationId(input.indicationId);
      const current = await loadOwned(id);
      if (current === null) notFound();
      const metadata = await mutationMetadata(input.operationId, current);
      if (!metadata.replayKnown) {
        if (
          !transitionAvailable(current, "edit") ||
          current.fields.currency !== amountConfiguration.currency ||
          !(await loadFreshMutationCurrencyCompatibility())
        ) {
          preconditionFailed();
        }
      }
      const acknowledgmentContext = await requiredMutationContext(
        metadata.replayKnown,
      );
      const request = editRequest(
        id,
        metadata,
        input.expectedRevision,
        input.fields,
      );
      const auditIntent = participantAuditIntent(
        metadata,
        actorSubject,
        id,
        "updated",
      );
      const result = await commitAtomic(Object.freeze({
        kind: "edit",
        request,
        acknowledgmentContext,
        auditIntent,
      }), metadata.replayKnown);
      return requireOwnedActiveResult(
        result.indication,
        actorSubject,
        id,
      );
    },

    async withdraw(input: WithdrawInvestmentInterestInput) {
      const id = requiredIndicationId(input.indicationId);
      const current = await loadOwned(id);
      if (current === null) notFound();
      const metadata = await mutationMetadata(input.operationId, current);
      if (!metadata.replayKnown && !transitionAvailable(current, "withdraw")) {
        preconditionFailed();
      }
      const request = transitionRequest(
        id,
        metadata,
        input.expectedRevision,
      );
      const auditIntent = participantAuditIntent(
        metadata,
        actorSubject,
        id,
        "withdrawn",
      );
      const result = await commitAtomic(Object.freeze({
        kind: "withdraw",
        request,
        auditIntent,
      }), true);
      return requireOwnedWithdrawnResult(
        result.indication,
        actorSubject,
        id,
      );
    },

    async reactivate(input: ReactivateInvestmentInterestInput) {
      const id = requiredIndicationId(input.indicationId);
      const current = await loadOwned(id);
      if (current === null) notFound();
      const metadata = await mutationMetadata(input.operationId, current);
      if (!metadata.replayKnown) {
        if (!transitionAvailable(current, "reactivate")) preconditionFailed();
        if (!indicationFieldsMeetAmountPolicy(current, amountConfiguration)) {
          preconditionFailed();
        }
        const [permissions, freshCurrencyCompatible] = await Promise.all([
          loadPermissions(),
          loadFreshMutationCurrencyCompatibility(),
        ]);
        if (
          !freshCurrencyCompatible ||
          (current.kind === "personal" && !permissions.reactivatePersonal) ||
          (current.kind === "company" && !permissions.reactivateCompany)
        ) {
          preconditionFailed();
        }
      }
      const acknowledgmentContext = await requiredMutationContext(
        metadata.replayKnown,
      );
      const request = transitionRequest(
        id,
        metadata,
        input.expectedRevision,
      );
      const auditIntent = participantAuditIntent(
        metadata,
        actorSubject,
        id,
        "reactivated",
      );
      const result = await commitAtomic(Object.freeze({
        kind: "reactivate",
        request,
        acknowledgmentContext,
        auditIntent,
      }), metadata.replayKnown);
      return requireOwnedActiveResult(
        result.indication,
        actorSubject,
        id,
      );
    },
  });
}

function createRequest(
  id: InvestmentIndicationId,
  metadata: MutationMetadata,
  fields: unknown,
): CreateIndicationRequest {
  return Object.freeze({
    operationId: metadata.operationId,
    expectedRevision: null,
    id,
    occurredAt: metadata.occurredAt,
    historyEntryId: metadata.historyEntryId,
    fields,
  });
}

function editRequest(
  id: InvestmentIndicationId,
  metadata: MutationMetadata,
  expectedRevision: number,
  fields: unknown,
): EditIndicationRequest {
  return Object.freeze({
    operationId: metadata.operationId,
    expectedRevision,
    id,
    occurredAt: metadata.occurredAt,
    historyEntryId: metadata.historyEntryId,
    fields,
  });
}

function transitionRequest(
  id: InvestmentIndicationId,
  metadata: MutationMetadata,
  expectedRevision: number,
): WithdrawIndicationRequest & ReactivateIndicationRequest {
  return Object.freeze({
    operationId: metadata.operationId,
    expectedRevision,
    id,
    occurredAt: metadata.occurredAt,
    historyEntryId: metadata.historyEntryId,
  });
}

function participantAuditIntent(
  metadata: MutationMetadata,
  actorSubject: ActorSubject,
  indicationId: InvestmentIndicationId,
  transition: Extract<
    ResourceTransition,
    "created" | "updated" | "withdrawn" | "reactivated"
  >,
): AuditAppendIntent {
  const eventId = parseStableId<"audit-event">(metadata.operationId);
  const auditOperationId = parseStableId<"audit-operation">(
    metadata.operationId,
  );
  const resourceId = parseStableId<"audit-resource">(indicationId);
  if (!eventId.ok || !auditOperationId.ok || !resourceId.ok) unavailable();

  const parsed = parseAuditAppendIntent({
    type: "append-audit-event",
    event: {
      id: eventId.value,
      operationId: auditOperationId.value,
      occurredAt: metadata.occurredAt,
      actor: { type: "participant", subject: actorSubject },
      detail: {
        kind: "resource-transition",
        resource: {
          type: "investment-indication",
          id: resourceId.value,
        },
        transition,
      },
    },
  });
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function requireAtomicMutationResult(
  value: unknown,
  expectedAudit: AuditEvent,
  amountConfiguration: AmountConfiguration,
  historicalCurrencyAllowed: boolean,
): AtomicParticipantInvestmentInterestResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const source = value as Record<string, unknown>;
  if (
    !hasExactKeys(source, ["indication", "aggregate", "auditEvent"]) ||
    typeof source.indication !== "object" ||
    source.indication === null ||
    typeof source.aggregate !== "object" ||
    source.aggregate === null ||
    typeof source.auditEvent !== "object" ||
    source.auditEvent === null
  ) {
    unavailable();
  }

  const indication = source.indication as IndicationMutationResult;
  if (
    typeof indication.replayed !== "boolean" ||
    !Number.isSafeInteger(indication.revision) ||
    indication.revision < 1 ||
    typeof indication.snapshot !== "object" ||
    indication.snapshot === null ||
    indication.snapshot.revision !== indication.revision
  ) {
    unavailable();
  }
  const indicationCurrency = requiredResultCurrency(indication);
  if (
    !historicalCurrencyAllowed &&
    indicationCurrency !== amountConfiguration.currency
  ) unavailable();

  const aggregate = source.aggregate as StoredInvestmentAggregateSnapshot;
  if (
    !hasExactKeys(aggregate as unknown as Record<string, unknown>, [
      "revision",
      "totalAmount",
      "currency",
      "contributingIndicationCount",
    ]) ||
    !isNonNegativeSafeInteger(aggregate.revision) ||
    !isNonNegativeSafeInteger(aggregate.totalAmount) ||
    aggregate.currency !== indicationCurrency ||
    !isNonNegativeSafeInteger(aggregate.contributingIndicationCount)
  ) {
    unavailable();
  }

  const parsedAudit = parseAuditAppendIntent({
    type: "append-audit-event",
    event: source.auditEvent,
  });
  if (!parsedAudit.ok) unavailable();
  const auditEvent = parsedAudit.value.event;
  if (!sameAuditEvent(auditEvent, expectedAudit)) unavailable();

  return Object.freeze({ indication, aggregate, auditEvent });
}

function indicationFieldsMeetAmountPolicy(
  indication: InvestmentIndication,
  amountConfiguration: AmountConfiguration,
): boolean {
  return indication.fields.currency === amountConfiguration.currency &&
    parseConfiguredAmount(indication.fields.amount, amountConfiguration).ok;
}

function transitionAvailable(
  indication: InvestmentIndication,
  type: ParticipantVisibleIndicationTransition["type"],
): boolean {
  return participantVisibleIndicationLifecycle(indication).transitions.some(
    (transition) => transition.type === type,
  );
}

function requiredResultCurrency(
  indication: IndicationMutationResult,
): string {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: indication.snapshot.fields?.currency,
      minimum: 0,
      increment: 1,
      maximum: null,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) unavailable();
  return parsed.value.amount.currency;
}

function sameAuditEvent(left: AuditEvent, right: AuditEvent): boolean {
  if (
    left.id !== right.id ||
    left.operationId !== right.operationId ||
    left.occurredAt !== right.occurredAt ||
    left.actor.type !== "participant" ||
    right.actor.type !== "participant" ||
    left.actor.subject !== right.actor.subject ||
    left.detail.kind !== "resource-transition" ||
    right.detail.kind !== "resource-transition"
  ) {
    return false;
  }
  return left.detail.resource.type === "investment-indication" &&
    right.detail.resource.type === "investment-indication" &&
    left.detail.resource.id === right.detail.resource.id &&
    left.detail.transition === right.detail.transition;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function requireOwnedActiveResult(
  result: IndicationMutationResult,
  actorSubject: ActorSubject,
  id: InvestmentIndicationId,
): IndicationMutationResult<ActiveInvestmentIndication> {
  if (
    result.snapshot.id !== id ||
    result.snapshot.participantSubject !== actorSubject ||
    result.snapshot.lifecycle.status !== "active"
  ) {
    notFound();
  }
  return result as IndicationMutationResult<ActiveInvestmentIndication>;
}

function requireOwnedWithdrawnResult(
  result: IndicationMutationResult,
  actorSubject: ActorSubject,
  id: InvestmentIndicationId,
): IndicationMutationResult<WithdrawnInvestmentIndication> {
  if (
    result.snapshot.id !== id ||
    result.snapshot.participantSubject !== actorSubject ||
    result.snapshot.lifecycle.status !== "withdrawn"
  ) {
    notFound();
  }
  return result as IndicationMutationResult<WithdrawnInvestmentIndication>;
}

function requiredPermissions(value: unknown): InvestmentInterestPermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const source = value as Record<string, unknown>;
  const keys = [
    "createPersonal",
    "createCompany",
    "reactivatePersonal",
    "reactivateCompany",
  ] as const;
  if (
    Object.keys(source).length !== keys.length ||
    keys.some((key) => typeof source[key] !== "boolean")
  ) {
    unavailable();
  }
  return Object.freeze({
    createPersonal: source.createPersonal as boolean,
    createCompany: source.createCompany as boolean,
    reactivatePersonal: source.reactivatePersonal as boolean,
    reactivateCompany: source.reactivateCompany as boolean,
  });
}

function requiredFieldsKind(value: unknown): InvestmentInterestKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidRequest();
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind !== "personal" && kind !== "company") invalidRequest();
  return kind;
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredIndicationId(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) notFound();
  return parsed.value;
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidConfiguration();
  return parsed.value;
}

function requiredAmountConfiguration(value: unknown): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: value,
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) invalidConfiguration();
  return Object.freeze({ ...parsed.value.amount });
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function preconditionFailed(): never {
  throw new StorageFailure("PRECONDITION_FAILED");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}

function invalidConfiguration(): never {
  throw new Error("Invalid investment-interest service configuration.");
}
