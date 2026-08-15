// money.ts -- amounts as integer minor units. Depends on: nothing.

export type Direction = "debit" | "credit";

/**
 * Amounts are integers in the currency's minor unit (cents for USD, whole yen for JPY).
 * Floating point is excluded for the obvious reason; decimals are excluded because they
 * can represent amounts that cannot exist, such as 0.00001 USD, and drag rounding rules
 * into runtime. With integers the illegal state is unrepresentable.
 */
export type Amount = bigint;

export type Currency = {
  readonly code: string;
  readonly minorUnit: number;
};

/**
 * Debits positive, credits negative. This is the single arithmetic convention of the
 * system and it mirrors the `signed_amount` generated column, so the same sum means the
 * same thing whether it is computed here or by the database.
 */
export function signedAmount(direction: Direction, amount: Amount): bigint {
  return direction === "debit" ? amount : -amount;
}

/** Renders 12345 as "123.45" for a currency with minorUnit 2. Presentation only. */
export function format(amount: Amount, currency: Currency): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(currency.minorUnit + 1, "0");
  const whole = digits.slice(0, digits.length - currency.minorUnit);
  const fraction = digits.slice(digits.length - currency.minorUnit);
  const sign = negative ? "-" : "";
  return fraction.length > 0
    ? `${sign}${whole}.${fraction} ${currency.code}`
    : `${sign}${whole} ${currency.code}`;
}
