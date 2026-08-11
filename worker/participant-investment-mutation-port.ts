import type {
  AuditAppendIntent,
  AuditEvent,
} from "../domain/audit-notification.ts";
import type { StoredInvestmentAggregateSnapshot } from "../domain/investment-aggregate.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import type {
  CreateIndicationRequest,
  EditIndicationRequest,
  IndicationMutationResult,
  ReactivateIndicationRequest,
  WithdrawIndicationRequest,
} from "../repositories/in-memory-indication-repository.ts";

export const PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY =
  "atomic-indication-aggregate-audit" as const;

/** Subject-bound reads stay independent from the stronger mutation capability. */
export interface ParticipantInvestmentInterestReader {
  get(id: InvestmentIndicationId): Promise<InvestmentIndication | null>;
  listOwned(): Promise<readonly InvestmentIndication[]>;
  /**
   * Return only whether a fresh mutation can use the configured currency.
   * Implementations must not expose the private aggregate snapshot.
   */
  freshMutationCurrencyCompatible(): Promise<boolean>;
}

type AtomicMutationCommandBase = Readonly<{
  auditIntent: AuditAppendIntent;
}>;

export type AtomicCreateInvestmentInterestCommand =
  AtomicMutationCommandBase &
    Readonly<{
      kind: "create";
      request: CreateIndicationRequest;
      acknowledgmentContext: TrustedPackageAcknowledgmentContext;
    }>;

export type AtomicEditInvestmentInterestCommand =
  AtomicMutationCommandBase &
    Readonly<{
      kind: "edit";
      request: EditIndicationRequest;
      acknowledgmentContext: TrustedPackageAcknowledgmentContext;
    }>;

export type AtomicWithdrawInvestmentInterestCommand =
  AtomicMutationCommandBase &
    Readonly<{
      kind: "withdraw";
      request: WithdrawIndicationRequest;
    }>;

export type AtomicReactivateInvestmentInterestCommand =
  AtomicMutationCommandBase &
    Readonly<{
      kind: "reactivate";
      request: ReactivateIndicationRequest;
      acknowledgmentContext: TrustedPackageAcknowledgmentContext;
    }>;

export type AtomicParticipantInvestmentInterestCommand =
  | AtomicCreateInvestmentInterestCommand
  | AtomicEditInvestmentInterestCommand
  | AtomicWithdrawInvestmentInterestCommand
  | AtomicReactivateInvestmentInterestCommand;

export type AtomicParticipantInvestmentInterestResult = Readonly<{
  indication: IndicationMutationResult;
  aggregate: StoredInvestmentAggregateSnapshot;
  auditEvent: AuditEvent;
}>;

/**
 * Strong write capability consumed by the participant service. An
 * implementation must commit all three returned facts or none of them.
 */
export interface AtomicParticipantInvestmentInterestMutationPort {
  readonly mutationConsistency:
    typeof PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY;
  commit(
    command: AtomicParticipantInvestmentInterestCommand,
  ): Promise<AtomicParticipantInvestmentInterestResult>;
}
