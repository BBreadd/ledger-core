// parse.ts -- turns an unknown JSON value into a value the core will accept, or a refusal.
// Depends on: domain, application (ports), problem.

import { ACCOUNT_TYPES } from "../../domain/account.ts";
import type { AccountType } from "../../domain/account.ts";
import type { Direction } from "../../domain/money.ts";
import type { EntryDraft, TransactionDraft } from "../../domain/transaction.ts";
import type { ProblemCode } from "./problem.ts";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ProblemCode; readonly message: string };

/** What POST /v1/accounts accepts. The id is the server's to assign, so it is not here. */
export type NewAccountRequest = {
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly allowsNegative: boolean;
};

/**
 * Amounts arrive as strings of minor units, and this pattern is the whole reason they can
 * be trusted. `BigInt` is far more permissive than it looks: it reads "" as 0n, "0x10" as
 * 16n, "0b11" as 3n, "0o17" as 15n, "+5" as 5n and "007" as 7n, and it trims whitespace.
 * Handing it a client-supplied string and catching what it throws would let every one of
 * those through as a real amount.
 *
 * Eighteen digits is the cap because a BIGINT column holds up to 9223372036854775807, and
 * refusing at the boundary is cheaper than a 22003 from the database. The leading [1-9]
 * carries I7 -- amounts are strictly positive -- and rejects "0" and "007" in one stroke.
 */
const AMOUNT = /^[1-9][0-9]{0,17}$/;

/**
 * Date-and-time, never a bare date. `new Date("2026")` is a valid date in JavaScript, and
 * accepting it would silently turn a truncated field into midnight on New Year's Day.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 500;
const MAX_IDEMPOTENCY_KEY = 255;

const DIRECTIONS: readonly Direction[] = ["debit", "credit"];

/**
 * Thrown by the helpers below and caught at the edge of each parser, never allowed out of
 * this file. The alternative -- threading a Result through twenty nested checks -- buries
 * the rules it exists to make readable. This is the "expected error" half of the split in
 * the workflow's error rules, converted to a value the moment it leaves the parser.
 */
class ParseError extends Error {
  readonly code: ProblemCode;

  constructor(code: ProblemCode, message: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

function malformed(message: string): never {
  throw new ParseError("MALFORMED_REQUEST", message);
}

function caught<T>(parse: () => T): ParseResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (error instanceof ParseError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * Unknown fields are refused rather than ignored. A caller who sends `ocurredAt` has a bug
 * either way, but being told "unknown field: ocurredAt" points at it, while being told
 * "occurredAt is required" sends them looking at the field they thought they sent.
 */
function object(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    malformed(`${where} must be a JSON object`);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      malformed(`unknown field in ${where}: ${key}`);
    }
  }
  return record;
}

function text(record: Record<string, unknown>, field: string, maxLength: number): string {
  const value = record[field];
  if (typeof value !== "string") {
    malformed(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    malformed(`${field} must not be empty`);
  }
  if (trimmed.length > maxLength) {
    malformed(`${field} must be at most ${maxLength} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

function optionalBoolean(record: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = record[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    malformed(`${field} must be a boolean`);
  }
  return value;
}

function amount(record: Record<string, unknown>, field: string): bigint {
  const value = record[field];
  if (typeof value !== "string") {
    malformed(
      `${field} must be a string of minor units, such as "12000". Numbers are refused ` +
        "because JSON numbers lose precision above 2^53 and money does not tolerate that.",
    );
  }
  if (!AMOUNT.test(value)) {
    malformed(
      `${field} must be a positive integer of minor units with no sign, radix prefix or ` +
        `leading zero, up to 18 digits, got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

function timestamp(record: Record<string, unknown>, field: string): Date {
  const value = record[field];
  if (typeof value !== "string") {
    malformed(`${field} must be an ISO 8601 date-time string`);
  }
  if (!TIMESTAMP.test(value)) {
    malformed(
      `${field} must be an ISO 8601 date-time with a time and a zone, such as ` +
        `"2026-08-15T12:00:00.000Z", got ${JSON.stringify(value)}`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    malformed(`${field} is not a real date: ${JSON.stringify(value)}`);
  }
  return date;
}

function uuid(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !UUID.test(value)) {
    malformed(`${field} must be a UUID`);
  }
  return value;
}

function direction(record: Record<string, unknown>, field: string): Direction {
  const value = record[field];
  if (typeof value !== "string" || !DIRECTIONS.includes(value as Direction)) {
    malformed(`${field} must be one of ${DIRECTIONS.join(", ")}`);
  }
  return value as Direction;
}

/** Parses a path segment. Not a body field, so it gets its own entry point. */
export function parseUuidPath(value: string): ParseResult<string> {
  return caught(() => {
    if (!UUID.test(value)) {
      malformed(`${JSON.stringify(value)} is not a UUID`);
    }
    return value;
  });
}

/**
 * The idempotency key travels in a header because it is metadata about delivery, not about
 * economic content: a transaction that happened is the same transaction however many times
 * it was transmitted.
 *
 * Both spellings are accepted. The IETF draft asks for a Structured Header, which is quoted
 * (`Idempotency-Key: "abc"`), while every implementation in the field sends it bare. Taking
 * only one of the two would reject half the clients over punctuation.
 */
export function parseIdempotencyKey(header: string | string[] | undefined): ParseResult<string> {
  return caught(() => {
    if (Array.isArray(header)) {
      throw new ParseError("MALFORMED_REQUEST", "Idempotency-Key must appear at most once");
    }
    if (header === undefined) {
      throw new ParseError(
        "MISSING_IDEMPOTENCY_KEY",
        "Idempotency-Key is required on every write, so that a retry cannot post twice",
      );
    }

    const unquoted = header.trim().replace(/^"(.*)"$/, "$1").trim();
    if (unquoted.length === 0) {
      malformed("Idempotency-Key must not be empty");
    }
    if (unquoted.length > MAX_IDEMPOTENCY_KEY) {
      malformed(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY} characters`);
    }
    return unquoted;
  });
}

export function parseNewAccount(body: unknown): ParseResult<NewAccountRequest> {
  return caught(() => {
    const record = object(body, "the request body", ["name", "type", "currency", "allowsNegative"]);

    const type = record["type"];
    if (typeof type !== "string" || !ACCOUNT_TYPES.includes(type as AccountType)) {
      malformed(`type must be one of ${ACCOUNT_TYPES.join(", ")}`);
    }

    const currency = record["currency"];
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      malformed("currency must be a three-letter uppercase ISO 4217 code");
    }

    return {
      name: text(record, "name", MAX_NAME),
      type: type as AccountType,
      currency,
      allowsNegative: optionalBoolean(record, "allowsNegative", false),
    };
  });
}

/**
 * occurredAt is required, and the reason is not obvious enough to leave unwritten. The
 * request fingerprint includes it, so defaulting it to `new Date()` would give a client's
 * retry a different timestamp, a different hash, and therefore IDEMPOTENCY_KEY_REUSED --
 * breaking idempotency for exactly the caller who needs it most.
 */
export function parseTransactionDraft(
  body: unknown,
  idempotencyKey: string,
): ParseResult<TransactionDraft> {
  return caught(() => {
    const record = object(body, "the request body", ["description", "occurredAt", "entries"]);

    const entries = record["entries"];
    if (!Array.isArray(entries)) {
      malformed("entries must be an array");
    }

    return {
      idempotencyKey,
      description: text(record, "description", MAX_DESCRIPTION),
      occurredAt: timestamp(record, "occurredAt"),
      entries: entries.map((entry, index): EntryDraft => {
        const leg = object(entry, `entries[${index}]`, ["accountId", "direction", "amount"]);
        return {
          accountId: uuid(leg, "accountId"),
          direction: direction(leg, "direction"),
          amount: amount(leg, "amount"),
        };
      }),
    };
  });
}

export function parseReversalDescription(body: unknown): ParseResult<string> {
  return caught(() => {
    const record = object(body, "the request body", ["description"]);
    return text(record, "description", MAX_DESCRIPTION);
  });
}
