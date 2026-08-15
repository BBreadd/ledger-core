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

/**
 * The other side of the same posting. Undoing a debit is crediting the same amount to the
 * same account, never a debit of a negative one -- which the type system would not allow
 * anyway, and the schema would refuse.
 *
 * The database holds this rule too, as flip_direction(). Two copies of one rule is a risk
 * worth naming: they are two lines that say the same thing, and the reconciliation job
 * compares postings written by one against postings judged by the other, so a drift would
 * surface as an audit failure rather than as silence.
 */
export function flip(direction: Direction): Direction {
  return direction === "debit" ? "credit" : "debit";
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
