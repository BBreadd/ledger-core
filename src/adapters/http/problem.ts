// problem.ts -- RFC 9457 problem details, and the one table that maps a code to a status.
// Depends on: application (for the rejection codes it must cover).

import type { ApplicationViolationCode, Rejection } from "../../application/post-transaction.ts";
import type { ReversalViolationCode } from "../../application/reverse-transaction.ts";
import type { ViolationCode } from "../../domain/transaction.ts";

/**
 * Every way the core can refuse a request. These codes are public API, not internal
 * detail: a client that is told `{"error": "internal"}` when it was short of funds cannot
 * tell "fix the request" from "retry later", and the whole reason the core returns
 * rejections instead of throwing is to make that distinction available.
 */
export type CoreRejectionCode = ViolationCode | ApplicationViolationCode | ReversalViolationCode;

/**
 * Refusals that belong to the surface rather than to the ledger. They exist because HTTP
 * has failure modes a ledger does not have: a body that is not JSON, a missing header, a
 * route that does not exist.
 */
export type SurfaceCode =
  | "MALFORMED_REQUEST"
  | "MISSING_IDEMPOTENCY_KEY"
  | "UNKNOWN_CURRENCY"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export type ProblemCode = CoreRejectionCode | SurfaceCode;

export type Problem = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ProblemCode;
  /** Present only when one request broke several rules at once. */
  readonly errors?: readonly { readonly code: ProblemCode; readonly message: string }[];
  /** Present only on 500, so a report can be matched against a log line. */
  readonly requestId?: string;
};

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

const UNPROCESSABLE = 422;

/**
 * Exhaustive by type, and that is the point rather than a nicety. A Record keyed by the
 * union of every rejection code means adding a code to the core without deciding what it
 * means over HTTP fails `npm run typecheck` instead of quietly falling through to a 500.
 */
const PROBLEMS: Readonly<Record<ProblemCode, { readonly status: number; readonly title: string }>> =
  {
    // The pure domain rules. All 422: the request was understood and is well formed JSON,
    // it just asks for something the ledger does not permit.
    EMPTY_IDEMPOTENCY_KEY: { status: UNPROCESSABLE, title: "Idempotency key must not be empty" },
    EMPTY_DESCRIPTION: { status: UNPROCESSABLE, title: "Description must not be empty" },
    TOO_FEW_ENTRIES: { status: UNPROCESSABLE, title: "Too few entries" },
    TOO_FEW_ACCOUNTS: { status: UNPROCESSABLE, title: "Too few accounts" },
    NON_POSITIVE_AMOUNT: { status: UNPROCESSABLE, title: "Amount must be positive" },
    UNBALANCED: { status: UNPROCESSABLE, title: "Debits do not equal credits" },

    // Rules that had to read other rows to be answered.
    //
    // UNKNOWN_ACCOUNT is 422 and not 404 on purpose: POST /v1/transactions does exist,
    // and what is missing is an account named inside the body. A 404 would be a claim
    // about the URL.
    UNKNOWN_ACCOUNT: { status: UNPROCESSABLE, title: "Unknown account" },
    MIXED_CURRENCY: { status: UNPROCESSABLE, title: "Mixed currencies in one transaction" },
    INSUFFICIENT_FUNDS: { status: UNPROCESSABLE, title: "Insufficient funds" },
    IDEMPOTENCY_KEY_REUSED: { status: UNPROCESSABLE, title: "Idempotency key reused" },

    // Reversals. Here the id is the URL, so a missing one is genuinely a 404, and the two
    // conflicts are conflicts with the state of that resource.
    UNKNOWN_TRANSACTION: { status: 404, title: "Unknown transaction" },
    ALREADY_REVERSED: { status: 409, title: "Transaction already reversed" },
    NOT_REVERSIBLE: { status: 409, title: "Transaction is not reversible" },

    MALFORMED_REQUEST: { status: 400, title: "Malformed request" },
    MISSING_IDEMPOTENCY_KEY: { status: 400, title: "Idempotency-Key header is required" },
    UNKNOWN_CURRENCY: { status: UNPROCESSABLE, title: "Unknown currency" },
    UNAUTHORIZED: { status: 401, title: "Unauthorized" },
    NOT_FOUND: { status: 404, title: "Not found" },
    METHOD_NOT_ALLOWED: { status: 405, title: "Method not allowed" },
    UNSUPPORTED_MEDIA_TYPE: { status: 415, title: "Unsupported media type" },
    PAYLOAD_TOO_LARGE: { status: 413, title: "Payload too large" },
    INTERNAL_ERROR: { status: 500, title: "Internal error" },
    SERVICE_UNAVAILABLE: { status: 503, title: "Service unavailable" },
  };

/**
 * A URN rather than a URL. RFC 9457 wants `type` to identify the problem and, where it
 * can, to document it -- but a URL pointing at documentation that does not exist is a
 * promise the repository does not keep, and nothing would ever fail to tell us. A URN
 * identifies without claiming anything is served there.
 */
export function problemType(code: ProblemCode): string {
  return `urn:ledger-core:error:${code.toLowerCase().replaceAll("_", "-")}`;
}

export function statusFor(code: ProblemCode): number {
  return PROBLEMS[code].status;
}

export function problemFor(code: ProblemCode, detail: string, requestId?: string): Problem {
  const kind = PROBLEMS[code];
  return {
    type: problemType(code),
    title: kind.title,
    status: kind.status,
    detail,
    code,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * One problem out of a list of rejections. `validate()` reports everything wrong with a
 * draft at once, and answering with only the first would make a caller fix one field per
 * round trip, so the rest travel in the `errors` extension.
 *
 * The status comes from the first rejection unless they disagree, which today they cannot:
 * every code the pure validator emits is 422. The fallback is there so that a future code
 * with a different status cannot silently take the whole list with it.
 */
export function problemFromRejections(
  rejections: readonly Rejection[] | readonly { code: ReversalViolationCode; message: string }[],
): Problem {
  const first = rejections[0];
  if (first === undefined) {
    throw new Error("a rejected outcome must carry at least one rejection");
  }

  const statuses = new Set(rejections.map((rejection) => statusFor(rejection.code)));
  const status = statuses.size === 1 ? statusFor(first.code) : UNPROCESSABLE;

  return {
    type: problemType(first.code),
    title: PROBLEMS[first.code].title,
    status,
    detail: first.message,
    code: first.code,
    ...(rejections.length > 1
      ? { errors: rejections.map((rejection) => ({ code: rejection.code, message: rejection.message })) }
      : {}),
  };
}
