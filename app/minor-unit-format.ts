/** Format validated integer minor units without floating-point arithmetic. */
export function formatMinorUnits(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError("Minor units must be a non-negative safe integer.");
  }

  const currencyOptions = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  }).resolvedOptions();
  const fractionDigits = currencyOptions.maximumFractionDigits;
  if (fractionDigits === undefined) {
    throw new RangeError("Currency fraction digits are unavailable.");
  }
  let divisor = BigInt(1);
  for (let index = 0; index < fractionDigits; index += 1) {
    divisor *= BigInt(10);
  }
  const minorUnits = BigInt(amount);
  const whole = minorUnits / divisor;
  const fraction = minorUnits % divisor;
  const integer = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(whole);
  const decimal = fractionDigits === 0
    ? ""
    : `.${fraction.toString().padStart(fractionDigits, "0")}`;

  return `${currency} ${integer}${decimal}`;
}
