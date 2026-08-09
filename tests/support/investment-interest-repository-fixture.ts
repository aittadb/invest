import type { AmountConfiguration } from "../../domain/amount-aggregate-configuration.ts";
import {
  parseAuditAppendIntent,
  type AuditEvent,
  type ResourceTransition,
} from "../../domain/audit-notification.ts";
import { DomainError, type ActorSubject } from "../../domain/foundation.ts";
import {
  calculateInvestmentAggregateSummary,
  projectInvestmentIndicationForAggregation,
  type StoredInvestmentAggregateSnapshot,
} from "../../domain/investment-aggregate.ts";
import {
  assertNoActiveIndicationConflict,
  createInvestmentIndication,
  editInvestmentIndication,
  reactivateInvestmentIndication,
  withdrawInvestmentIndication,
  type ActiveInvestmentIndication,
  type InvestmentIndication,
  type InvestmentIndicationId,
  type ParticipantIndicationActor,
} from "../../domain/investment-indication.ts";
import { StorageFailure } from "../../domain/storage-adapter.ts";
import type {
  IndicationMutationResult,
} from "../../repositories/in-memory-indication-repository.ts";
import {
  PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY,
  type AtomicParticipantInvestmentInterestCommand,
  type AtomicParticipantInvestmentInterestMutationPort,
  type AtomicParticipantInvestmentInterestResult,
  type ParticipantInvestmentInterestReader,
} from "../../worker/participant-investment-mutation-port.ts";

type StoredOperation = Readonly<{
  fingerprint: string;
  result: AtomicParticipantInvestmentInterestResult;
}>;

export type InvestmentInterestAtomicEvidence = Readonly<{
  indications: readonly InvestmentIndication[];
  aggregate: StoredInvestmentAggregateSnapshot;
  auditEvents: readonly AuditEvent[];
}>;

export class InvestmentInterestRepositoryFixtureState {
  readonly indications = new Map<string, InvestmentIndication>();
  readonly operations = new Map<string, StoredOperation>();
  readonly requests: AtomicParticipantInvestmentInterestCommand[] = [];
  readonly auditEvents: AuditEvent[] = [];
  aggregate: StoredInvestmentAggregateSnapshot | null = null;
  failNextAtomicMutation = false;

  forceNextAtomicFailure(): void {
    this.failNextAtomicMutation = true;
  }

  evidence(): InvestmentInterestAtomicEvidence {
    if (this.aggregate === null) unavailable();
    return Object.freeze({
      indications: Object.freeze([...this.indications.values()]),
      aggregate: this.aggregate,
      auditEvents: Object.freeze([...this.auditEvents]),
    });
  }
}

/** Deterministic atomic port used only by participant service and route tests. */
export class InvestmentInterestRepositoryFixture
  implements
    ParticipantInvestmentInterestReader,
    AtomicParticipantInvestmentInterestMutationPort
{
  readonly mutationConsistency =
    PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY;

  readonly #state: InvestmentInterestRepositoryFixtureState;
  readonly #subject: ActorSubject;
  readonly #amount: AmountConfiguration;

  constructor(
    state: InvestmentInterestRepositoryFixtureState,
    subject: ActorSubject,
    amount: AmountConfiguration,
  ) {
    this.#state = state;
    this.#subject = subject;
    this.#amount = amount;
    if (state.aggregate === null) {
      state.aggregate = Object.freeze({
        revision: 0,
        totalAmount: 0 as AmountConfiguration["minimum"],
        currency: amount.currency,
        contributingIndicationCount: 0,
      });
    } else if (state.aggregate.currency !== amount.currency) {
      unavailable();
    }
  }

  async listOwned(): Promise<readonly InvestmentIndication[]> {
    return Object.freeze(
      [...this.#state.indications.values()].filter(
        (indication) => indication.participantSubject === this.#subject,
      ),
    );
  }

  async get(id: InvestmentIndicationId): Promise<InvestmentIndication | null> {
    const indication = this.#state.indications.get(String(id));
    return indication?.participantSubject === this.#subject ? indication : null;
  }

  async commit(
    command: AtomicParticipantInvestmentInterestCommand,
  ): Promise<AtomicParticipantInvestmentInterestResult> {
    this.#state.requests.push(command);
    const operationKey = String(command.request.operationId);
    const fingerprintValue = fingerprint(command);
    const prior = this.#state.operations.get(operationKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprintValue) conflict();
      return atomicResult(
        mutationResult(prior.result.indication.snapshot, true),
        prior.result.aggregate,
        prior.result.auditEvent,
      );
    }

    const next = this.#applyIndication(command);
    const auditEvent = requiredAuditEvent(command, next, this.#subject);
    const nextIndications = new Map(this.#state.indications);
    nextIndications.set(String(next.id), next);
    const aggregate = nextAggregate(
      requiredAggregate(this.#state),
      [...nextIndications.values()],
      this.#amount,
    );
    const result = atomicResult(
      mutationResult(next, false),
      aggregate,
      auditEvent,
    );

    if (this.#state.failNextAtomicMutation) {
      this.#state.failNextAtomicMutation = false;
      unavailable();
    }

    this.#state.indications.set(String(next.id), next);
    this.#state.aggregate = aggregate;
    this.#state.auditEvents.push(auditEvent);
    this.#state.operations.set(operationKey, {
      fingerprint: fingerprintValue,
      result,
    });
    return result;
  }

  #applyIndication(
    command: AtomicParticipantInvestmentInterestCommand,
  ): InvestmentIndication {
    if (command.kind === "create") {
      if (this.#state.indications.has(String(command.request.id))) conflict();
      const created = domainMutation(() =>
        createInvestmentIndication(
          {
            id: command.request.id,
            occurredAt: command.request.occurredAt,
            historyEntryId: command.request.historyEntryId,
            fields: command.request.fields,
          },
          actor(this.#subject),
          this.#amount,
          command.acknowledgmentContext,
        )
      );
      requireNoConflict(created, this.#state.indications.values());
      return created;
    }

    const current = this.#owned(command.request.id);
    if (current.revision !== command.request.expectedRevision) precondition();
    if (command.kind === "edit") {
      const edited = domainMutation(() =>
        editInvestmentIndication(
          current,
          {
            occurredAt: command.request.occurredAt,
            historyEntryId: command.request.historyEntryId,
            fields: command.request.fields,
          },
          actor(this.#subject),
          this.#amount,
          command.acknowledgmentContext,
        )
      );
      requireNoConflict(edited, this.#state.indications.values());
      return edited;
    }
    if (command.kind === "withdraw") {
      return domainMutation(() =>
        withdrawInvestmentIndication(
          current,
          {
            occurredAt: command.request.occurredAt,
            historyEntryId: command.request.historyEntryId,
          },
          actor(this.#subject),
        )
      );
    }

    const reactivated = domainMutation(() =>
      reactivateInvestmentIndication(
        current,
        {
          occurredAt: command.request.occurredAt,
          historyEntryId: command.request.historyEntryId,
        },
        actor(this.#subject),
        command.acknowledgmentContext,
      )
    );
    requireNoConflict(reactivated, this.#state.indications.values());
    return reactivated;
  }

  #owned(id: unknown): InvestmentIndication {
    if (typeof id !== "string") invalid();
    const indication = this.#state.indications.get(id);
    if (
      indication === undefined ||
      indication.participantSubject !== this.#subject
    ) {
      notFound();
    }
    return indication;
  }
}

function requiredAuditEvent(
  command: AtomicParticipantInvestmentInterestCommand,
  indication: InvestmentIndication,
  subject: ActorSubject,
): AuditEvent {
  const parsed = parseAuditAppendIntent(command.auditIntent);
  if (!parsed.ok) invalid();
  const event = parsed.value.event;
  const detail = event.detail;
  if (
    event.operationId !== command.request.operationId ||
    event.occurredAt !== command.request.occurredAt ||
    event.actor.type !== "participant" ||
    event.actor.subject !== subject ||
    detail.kind !== "resource-transition" ||
    detail.resource.type !== "investment-indication" ||
    String(detail.resource.id) !== String(indication.id) ||
    detail.transition !== transitionFor(command.kind)
  ) {
    invalid();
  }
  return event;
}

function transitionFor(
  kind: AtomicParticipantInvestmentInterestCommand["kind"],
): Extract<
  ResourceTransition,
  "created" | "updated" | "withdrawn" | "reactivated"
> {
  if (kind === "create") return "created";
  if (kind === "edit") return "updated";
  if (kind === "withdraw") return "withdrawn";
  return "reactivated";
}

function nextAggregate(
  current: StoredInvestmentAggregateSnapshot,
  indications: readonly InvestmentIndication[],
  amount: AmountConfiguration,
): StoredInvestmentAggregateSnapshot {
  const calculated = domainCall(() =>
    calculateInvestmentAggregateSummary(
      indications.map(projectInvestmentIndicationForAggregation),
      amount.currency,
    )
  );
  if (current.revision >= Number.MAX_SAFE_INTEGER) unavailable();
  return Object.freeze({
    revision: current.revision + 1,
    totalAmount: calculated.totalAmount,
    currency: calculated.currency,
    contributingIndicationCount: calculated.contributingIndicationCount,
  });
}

function requiredAggregate(
  state: InvestmentInterestRepositoryFixtureState,
): StoredInvestmentAggregateSnapshot {
  if (state.aggregate === null) unavailable();
  return state.aggregate;
}

function requireNoConflict(
  candidate: ActiveInvestmentIndication,
  existing: Iterable<InvestmentIndication>,
): void {
  domainCall(() => assertNoActiveIndicationConflict(candidate, [...existing]));
}

function actor(subject: ActorSubject): ParticipantIndicationActor {
  return Object.freeze({ type: "participant", subject });
}

function domainMutation<Value>(
  operation: () => Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false }>,
): Value {
  return domainCall(() => {
    const result = operation();
    if (!result.ok) invalid();
    return result.value;
  });
}

function domainCall<Value>(operation: () => Value): Value {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DomainError) mapDomainError(error);
    throw error;
  }
}

function mapDomainError(error: DomainError): never {
  if (error.code === "RESOURCE_CONFLICT") conflict();
  if (error.code === "PRECONDITION_FAILED") precondition();
  if (
    error.code === "RESOURCE_NOT_FOUND" ||
    error.code === "ACCESS_DENIED" ||
    error.code === "AUTHENTICATION_REQUIRED"
  ) {
    notFound();
  }
  invalid();
}

function fingerprint(command: AtomicParticipantInvestmentInterestCommand): string {
  return JSON.stringify({
    kind: command.kind,
    request: command.request,
    auditIntent: command.auditIntent,
  });
}

function mutationResult<Indication extends InvestmentIndication>(
  snapshot: Indication,
  replayed: boolean,
): IndicationMutationResult<Indication> {
  return Object.freeze({ revision: snapshot.revision, snapshot, replayed });
}

function atomicResult(
  indication: IndicationMutationResult,
  aggregate: StoredInvestmentAggregateSnapshot,
  auditEvent: AuditEvent,
): AtomicParticipantInvestmentInterestResult {
  return Object.freeze({ indication, aggregate, auditEvent });
}

function invalid(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function conflict(): never {
  throw new StorageFailure("CONFLICT");
}

function precondition(): never {
  throw new StorageFailure("PRECONDITION_FAILED");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
