import {
  createFounderApplication,
  editFounderApplication,
  withdrawFounderApplication,
  type ContributionAreaChoice,
  type FounderApplication,
  type FounderApplicationId,
  type ReceivedFounderApplication,
  type WithdrawnFounderApplication,
} from "../../domain/founder-application.ts";
import type { ActorSubject } from "../../domain/foundation.ts";
import { StorageFailure } from "../../domain/storage-adapter.ts";
import type {
  CreateFounderApplicationRequest,
  EditFounderApplicationRequest,
  FounderApplicationMutationResult,
  FounderApplicationRepository,
  WithdrawFounderApplicationRequest,
} from "../../repositories/in-memory-founder-application-repository.ts";

type StoredOperation = Readonly<{
  fingerprint: string;
  result: FounderApplicationMutationResult;
}>;

export class FounderApplicationRepositoryFixtureState {
  readonly applications = new Map<string, FounderApplication>();
  readonly operations = new Map<string, StoredOperation>();
  readonly requests: Array<
    Readonly<{
      kind: "create" | "edit" | "withdraw";
      subject: ActorSubject;
      request:
        | CreateFounderApplicationRequest
        | EditFounderApplicationRequest
        | WithdrawFounderApplicationRequest;
    }>
  > = [];
}

/** Small deterministic repository used only by route/use-case tests. */
export class FounderApplicationRepositoryFixture
  implements FounderApplicationRepository
{
  readonly #state: FounderApplicationRepositoryFixtureState;
  readonly #subject: ActorSubject;
  readonly #choices: readonly ContributionAreaChoice[];

  constructor(
    state: FounderApplicationRepositoryFixtureState,
    subject: ActorSubject,
    choices: readonly ContributionAreaChoice[],
  ) {
    this.#state = state;
    this.#subject = subject;
    this.#choices = choices;
  }

  async create(
    request: CreateFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>> {
    this.#record("create", request);
    const replay = this.#replay(request);
    if (replay) return received(replay);

    const key = applicationKey(this.#subject, request.id);
    if (this.#state.applications.has(key)) conflict();
    const created = createFounderApplication(
      {
        id: request.id,
        applicantSubject: this.#subject,
        occurredAt: request.occurredAt,
        historyEntryId: request.historyEntryId,
        fields: request.fields,
      },
      this.#choices,
    );
    if (!created.ok) invalid();
    const result = mutationResult(created.value, false);
    this.#state.applications.set(key, created.value);
    this.#remember(request, result);
    return result;
  }

  async get(id: FounderApplicationId): Promise<FounderApplication | null> {
    return this.#state.applications.get(applicationKey(this.#subject, id)) ?? null;
  }

  async edit(
    request: EditFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>> {
    this.#record("edit", request);
    const replay = this.#replay(request);
    if (replay) return received(replay);

    const key = applicationKey(this.#subject, request.id);
    const current = this.#state.applications.get(key);
    if (!current) notFound();
    if (current.revision !== request.expectedRevision) precondition();
    const edited = editFounderApplication(
      current,
      {
        actorSubject: this.#subject,
        occurredAt: request.occurredAt,
        historyEntryId: request.historyEntryId,
        fields: request.fields,
      },
      this.#choices,
    );
    if (!edited.ok) invalid();
    const result = mutationResult(edited.value, false);
    this.#state.applications.set(key, edited.value);
    this.#remember(request, result);
    return result;
  }

  async withdraw(
    request: WithdrawFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<WithdrawnFounderApplication>> {
    this.#record("withdraw", request);
    const replay = this.#replay(request);
    if (replay) return withdrawn(replay);

    const key = applicationKey(this.#subject, request.id);
    const current = this.#state.applications.get(key);
    if (!current) notFound();
    if (current.revision !== request.expectedRevision) precondition();
    const withdrawnApplication = withdrawFounderApplication(current, {
      actorSubject: this.#subject,
      occurredAt: request.occurredAt,
      historyEntryId: request.historyEntryId,
    });
    if (!withdrawnApplication.ok) invalid();
    const result = mutationResult(withdrawnApplication.value, false);
    this.#state.applications.set(key, withdrawnApplication.value);
    this.#remember(request, result);
    return result;
  }

  #record(
    kind: "create" | "edit" | "withdraw",
    request:
      | CreateFounderApplicationRequest
      | EditFounderApplicationRequest
      | WithdrawFounderApplicationRequest,
  ): void {
    this.#state.requests.push(Object.freeze({ kind, subject: this.#subject, request }));
  }

  #replay(
    request:
      | CreateFounderApplicationRequest
      | EditFounderApplicationRequest
      | WithdrawFounderApplicationRequest,
  ): FounderApplicationMutationResult | null {
    const prior = this.#state.operations.get(String(request.operationId));
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint(request)) conflict();
    return mutationResult(prior.result.snapshot, true);
  }

  #remember(
    request:
      | CreateFounderApplicationRequest
      | EditFounderApplicationRequest
      | WithdrawFounderApplicationRequest,
    result: FounderApplicationMutationResult,
  ): void {
    this.#state.operations.set(String(request.operationId), {
      fingerprint: fingerprint(request),
      result,
    });
  }
}

function applicationKey(subject: ActorSubject, id: unknown): string {
  if (typeof id !== "string") invalid();
  return `${subject}\u0000${id}`;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function mutationResult<Application extends FounderApplication>(
  snapshot: Application,
  replayed: boolean,
): FounderApplicationMutationResult<Application> {
  return Object.freeze({ revision: snapshot.revision, snapshot, replayed });
}

function received(
  result: FounderApplicationMutationResult,
): FounderApplicationMutationResult<ReceivedFounderApplication> {
  if (result.snapshot.status !== "received") invalid();
  return result as FounderApplicationMutationResult<ReceivedFounderApplication>;
}

function withdrawn(
  result: FounderApplicationMutationResult,
): FounderApplicationMutationResult<WithdrawnFounderApplication> {
  if (result.snapshot.status !== "withdrawn") invalid();
  return result as FounderApplicationMutationResult<WithdrawnFounderApplication>;
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
