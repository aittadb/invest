import { formatMinorUnits } from "@/app/minor-unit-format";
import type { PublicOversubscriptionDisplayData } from "@/domain/investment-aggregate";
import type { PublicAggregate } from "@/app/public-campaign/published-campaign-types";

export type PublicAggregateBandProps = Readonly<{
  publicAggregate: PublicAggregate;
}>;

export function PublicAggregateBand({
  publicAggregate,
}: PublicAggregateBandProps) {
  return (
    <section className="aggregate-band" aria-labelledby="aggregate-title">
      <div className="content-width aggregate-layout">
        <div>
          <p className="section-kicker">Current pre-registration</p>
          <h2 id="aggregate-title">{publicAggregate.label}</h2>
          <p>{publicAggregate.qualifier}</p>
        </div>
        <div className="aggregate-total">
          <strong>
            {formatMinorUnits(publicAggregate.amount, publicAggregate.currency)}
          </strong>
          <p>Self-declared. Unverified. Non-binding.</p>
          {publicAggregate.oversubscription ? (
            <p>
              {aggregateProgress(
                publicAggregate.oversubscription,
                publicAggregate.currency,
              )}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function aggregateProgress(
  progress: PublicOversubscriptionDisplayData,
  currency: string,
): string {
  const target = formatMinorUnits(progress.targetAmount, currency);
  if (progress.status === "below_target") {
    return `${target} target. ${formatMinorUnits(progress.remainingAmount, currency)} remaining.`;
  }
  if (progress.status === "target_reached") return `${target} target reached`;
  return `${target} target. ${formatMinorUnits(progress.amountOverTarget, currency)} above target.`;
}
