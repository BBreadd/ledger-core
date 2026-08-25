// server.ts -- the HTTP surface over the ledger core. Depends on: application, domain, node:http.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  CredentialDirectory,
  IdGenerator,
  LedgerStore,
  Scope,
  StoredTransaction,
} from "../../application/ports.ts";
import { postTransaction } from "../../application/post-transaction.ts";
import { reverseTransaction } from "../../application/reverse-transaction.ts";
import { createAuthenticator, scopeAllows } from "./auth.ts";
import type { Principal } from "./auth.ts";
import type { ParseResult } from "./parse.ts";
import {
  parseIdempotencyKey,
  parseNewAccount,
  parseReversalDescription,
  parseTransactionDraft,
  parseUuidPath,
} from "./parse.ts";
import { PROBLEM_CONTENT_TYPE, problemFor, problemFromRejections } from "./problem.ts";
import type { Problem, ProblemCode } from "./problem.ts";
import { createRouter } from "./router.ts";
import type { RouteParams } from "./router.ts";
import { accountView, balanceView, transactionView } from "./views.ts";
import type { TransactionView } from "./views.ts";

const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Ten seconds for a whole request and five for its headers, both set explicitly. Node's
 * defaults are 300 and 60, which are the numbers a slow-loris attack is built around: a
 * client that opens a connection and dribbles one byte a minute holds a socket for five
 * minutes at no cost to itself.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;

export type LogLine = Readonly<Record<string, string | number>>;

export type ServerDependencies = {
  readonly store: LedgerStore;
  readonly credentials: CredentialDirectory;
  readonly newId: IdGenerator;
  readonly maxBodyBytes?: number;
  readonly log?: (line: LogLine) => void;
};

type Reply = {
  readonly status: number;
  readonly body: unknown;
  readonly location?: string;
  readonly allow?: readonly string[];
};

/**
 * A reply plus whoever earned it. The principal travels back out so the request log can
 * name the caller, which is the only thing outside this function that needs it -- handlers
 * are given what they need, not who asked.
 */
type Outcome = {
  readonly reply: Reply;
  readonly principal: Principal | null;
};

type RequestContext = {
  readonly params: RouteParams;
  readonly request: IncomingMessage;
  readonly body: unknown;
  readonly requestId: string;
  /** Null only on /health, the one route that identifies nobody. */
  readonly principal: Principal | null;
};

type Handler = {
  /**
   * The scope a credential must hold to reach this route. "none" belongs to /health alone,
   * which a load balancer has to reach without credentials.
   *
   * Declared per route rather than derived from the method, so that adding a route forces
   * the question to be answered instead of inherited.
   */
  readonly requires: Scope | "none";
  /** True for the routes that read a JSON body, which are exactly the writes. */
  readonly reads: boolean;
  handle(context: RequestContext): Promise<Reply>;
};

export function createLedgerServer(deps: ServerDependencies): Server {
  const authenticate = createAuthenticator(deps.credentials);
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = deps.log ?? ((line: LogLine) => console.log(JSON.stringify(line)));
  const router = createRouter<Handler>(routes(deps));

  const server = createServer((request, response) => {
    const requestId = deps.newId();
    const startedAt = process.hrtime.bigint();

    // Written from inside the chain and read in the finally, so that one log line covers
    // both the answered and the failed path. It stays null when the request never got as
    // far as presenting a usable credential.
    let caller: Principal | null = null;

    void dispatch(request, requestId)
      .then((outcome) => {
        caller = outcome.principal;
        send(response, outcome.reply, requestId);
      })
      .catch((error: unknown) => {
        // Anything reaching here is a bug rather than a refusal: every expected failure is
        // a value by the time it gets back. The detail goes to the log with an id, and the
        // caller gets that id and nothing else.
        log({
          event: "request.failed",
          requestId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
        send(
          response,
          {
            status: 500,
            body: problemFor(
              "INTERNAL_ERROR",
              "The request could not be completed. Quote the requestId when reporting it.",
              requestId,
            ),
          },
          requestId,
        );
      })
      .finally(() => {
        // Who made the request, on every line. With one shared token there was nothing to
        // say; with a credential per caller, a log that cannot attribute a request is a log
        // that cannot answer the first question anyone asks of it. The key id is also what
        // `revoke-key` takes, so a line here is enough to act on.
        const attribution: LogLine =
          caller === null ? {} : { tenantId: caller.tenantId, keyId: caller.keyId };

        log({
          event: "request",
          requestId,
          method: request.method ?? "",
          path: (request.url ?? "").split("?")[0] ?? "",
          status: response.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
          ...attribution,
        });
      });
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;

  async function dispatch(request: IncomingMessage, requestId: string): Promise<Outcome> {
    const match = router.match(request.method, request.url);

    if (match.kind === "bad-target") {
      return anonymous(problemReply("MALFORMED_REQUEST", match.detail));
    }
    if (match.kind === "not-found") {
      return anonymous(problemReply("NOT_FOUND", `no route for ${request.method} ${request.url}`));
    }
    if (match.kind === "method-not-allowed") {
      return anonymous({
        ...problemReply("METHOD_NOT_ALLOWED", `${request.method} is not allowed on this path`),
        allow: match.allowed,
      });
    }

    const handler = match.handler;

    // Identity first, then scope, then the body. Refusing before reading means a caller
    // that may not use this route cannot make the server hold its payload in memory.
    let principal: Principal | null = null;
    if (handler.requires !== "none") {
      principal = await authenticate(request.headers.authorization);
      if (principal === null) {
        return anonymous(problemReply("UNAUTHORIZED", "a valid bearer token is required"));
      }

      if (!scopeAllows(principal.scope, handler.requires)) {
        return {
          principal,
          reply: problemReply(
            "FORBIDDEN",
            `this credential holds the ${principal.scope} scope; ` +
              `${request.method} on this path requires ${handler.requires}`,
          ),
        };
      }
    }

    const context = { params: match.params, request, requestId, principal };

    if (!handler.reads) {
      return { principal, reply: await handler.handle({ ...context, body: undefined }) };
    }

    if (!isJson(request.headers["content-type"])) {
      return {
        principal,
        reply: problemReply(
          "UNSUPPORTED_MEDIA_TYPE",
          `this endpoint accepts ${JSON_CONTENT_TYPE} only`,
        ),
      };
    }

    const raw = await readBody(request, maxBodyBytes);
    if (!raw.ok) {
      return { principal, reply: problemReply(raw.code, raw.message) };
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.value);
    } catch (error) {
      return {
        principal,
        reply: problemReply(
          "MALFORMED_REQUEST",
          `body is not valid JSON: ${error instanceof Error ? error.message : "unreadable"}`,
        ),
      };
    }

    return { principal, reply: await handler.handle({ ...context, body }) };
  }
}

function routes(deps: ServerDependencies): Record<string, Handler> {
  const core = { store: deps.store, newId: deps.newId };

  return {
    "GET /health": {
      requires: "none",
      reads: false,
      async handle(): Promise<Reply> {
        try {
          await deps.store.ping();
        } catch {
          // Deliberately not re-thrown. An unreachable database is a state this endpoint
          // exists to report, not a bug to hide behind a 500.
          return {
            status: 503,
            body: problemFor("SERVICE_UNAVAILABLE", "the database is not answering"),
          };
        }
        return { status: 200, body: { status: "ok" } };
      },
    },

    "POST /v1/accounts": {
      requires: "write",
      reads: true,
      async handle(context): Promise<Reply> {
        const parsed = parseNewAccount(context.body);
        if (!parsed.ok) {
          return problemReply(parsed.code, parsed.message);
        }

        // Read before writing, on purpose. Without it the insert reaches the foreign key on
        // accounts.currency and a mistyped code comes back as an unmapped 23503, which the
        // caller would see as a 500.
        const currency = await deps.store.findCurrency(parsed.value.currency);
        if (currency === null) {
          return problemReply(
            "UNKNOWN_CURRENCY",
            `${parsed.value.currency} is not a currency this ledger knows`,
          );
        }

        // The tenant comes from the credential and can come from nowhere else. The body
        // parser rejects any field it was not told about, so a caller that tries to send
        // tenantId is answered with 400 rather than quietly ignored -- a client that
        // believes it chose an owner and did not is worse than one that is told no.
        const id = deps.newId();
        await deps.store.createAccount({ id, tenantId: tenantOf(context), ...parsed.value });

        // No Location header, and its absence is deliberate: there is no GET for an
        // account, and a Location pointing at a 404 would be a lie the compiler cannot
        // catch. The body carries the id, which is what the caller actually needs.
        return { status: 201, body: accountView(id, parsed.value, currency.minorUnit) };
      },
    },

    "POST /v1/transactions": {
      requires: "write",
      reads: true,
      async handle(context): Promise<Reply> {
        const key = parseIdempotencyKey(context.request.headers["idempotency-key"]);
        if (!key.ok) {
          return problemReply(key.code, key.message);
        }

        const draft = parseTransactionDraft(context.body, key.value);
        if (!draft.ok) {
          return problemReply(draft.code, draft.message);
        }

        const outcome = await postTransaction(core, draft.value, tenantOf(context));
        if (outcome.status === "rejected") {
          return fromProblem(problemFromRejections(outcome.rejections));
        }

        const view = await viewOf(deps.store, outcome.transaction);
        // 201 against 200 is the signal, not decoration: it is how a caller learns whether
        // its retry landed or whether the original had already been recorded.
        return outcome.status === "posted"
          ? { status: 201, body: view, location: `/v1/transactions/${outcome.transaction.id}` }
          : { status: 200, body: view };
      },
    },

    "POST /v1/transactions/:id/reversal": {
      requires: "write",
      reads: true,
      async handle(context): Promise<Reply> {
        const id = pathUuid(context.params, "id");
        if (!id.ok) {
          return problemReply(id.code, id.message);
        }

        const key = parseIdempotencyKey(context.request.headers["idempotency-key"]);
        if (!key.ok) {
          return problemReply(key.code, key.message);
        }

        const description = parseReversalDescription(context.body);
        if (!description.ok) {
          return problemReply(description.code, description.message);
        }

        const outcome = await reverseTransaction(core, {
          transactionId: id.value,
          tenantId: tenantOf(context),
          idempotencyKey: key.value,
          description: description.value,
        });

        if (outcome.status === "rejected") {
          return fromProblem(problemFromRejections(outcome.rejections));
        }

        const view = await viewOf(deps.store, outcome.transaction);
        return outcome.status === "reversed"
          ? { status: 201, body: view, location: `/v1/transactions/${outcome.transaction.id}` }
          : { status: 200, body: view };
      },
    },

    "GET /v1/transactions/:id": {
      requires: "read",
      reads: false,
      async handle(context): Promise<Reply> {
        const id = pathUuid(context.params, "id");
        if (!id.ok) {
          return problemReply(id.code, id.message);
        }

        // One branch, and it covers both "there is no such transaction" and "it is not
        // yours", because the query returns nothing in either case. The distinction is not
        // lost -- it was never made, which is what keeps it from leaking.
        const transaction = await deps.store.findTransaction(id.value, tenantOf(context));
        if (transaction === null) {
          return problemReply("UNKNOWN_TRANSACTION", `no transaction with id ${id.value}`);
        }

        return { status: 200, body: await viewOf(deps.store, transaction) };
      },
    },

    "GET /v1/accounts/:id/balance": {
      requires: "read",
      reads: false,
      async handle(context): Promise<Reply> {
        const id = pathUuid(context.params, "id");
        if (!id.ok) {
          return problemReply(id.code, id.message);
        }

        const account = await deps.store.findAccountBalance(id.value, tenantOf(context));
        if (account === null) {
          return problemReply("NOT_FOUND", `no account with id ${id.value}`);
        }

        const currency = await requireCurrency(deps.store, account.currency);
        return { status: 200, body: balanceView(account, currency.minorUnit) };
      },
    },
  };
}

function pathUuid(params: RouteParams, name: string): ParseResult<string> {
  return parseUuidPath(params[name] ?? "");
}

/**
 * Unreachable on every route that calls it: dispatch refuses anything but /health before a
 * handler runs, and /health does not ask. If it ever fires, a route was declared
 * `requires: "none"` and then went looking for a caller, which is a bug and gets the answer
 * a bug gets.
 */
function tenantOf(context: RequestContext): string {
  if (context.principal === null) {
    throw new Error("a handler asked who the caller was on a route that requires no credential");
  }
  return context.principal.tenantId;
}

async function viewOf(
  store: LedgerStore,
  transaction: StoredTransaction,
): Promise<TransactionView> {
  const code = transaction.entries[0]?.currency ?? "";
  const currency = await requireCurrency(store, code);
  return transactionView(transaction, currency.minorUnit);
}

/**
 * One extra indexed lookup by primary key per response, and no cache. A currency table
 * that changes about never is the textbook place to memoise, and memoising it is also how
 * a process ends up serving a minor unit that was corrected an hour ago. There is no
 * measurement saying this read costs anything, so it stays a read.
 */
async function requireCurrency(
  store: LedgerStore,
  code: string,
): Promise<{ readonly minorUnit: number }> {
  const currency = await store.findCurrency(code);
  if (currency === null) {
    // Unreachable through the schema: entries.currency is half of a foreign key into
    // accounts, and accounts.currency references currencies. If it ever fires, something
    // deleted a currency out from under live rows and a 500 is the honest answer.
    throw new Error(`currency ${code} is referenced by stored rows but is not in currencies`);
  }
  return currency;
}

/** A reply from before anyone was identified, or from a route that identifies nobody. */
function anonymous(reply: Reply): Outcome {
  return { reply, principal: null };
}

function problemReply(code: ProblemCode, detail: string): Reply {
  return fromProblem(problemFor(code, detail));
}

function fromProblem(problem: Problem): Reply {
  return { status: problem.status, body: problem };
}

function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  const [mediaType] = contentType.split(";");
  return (mediaType ?? "").trim().toLowerCase() === JSON_CONTENT_TYPE;
}

type BodyResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: ProblemCode; readonly message: string };

/**
 * Reads the body with a hard ceiling on bytes. Without one, a body is however much memory
 * the caller feels like spending, and no framework is doing this for us.
 *
 * Content-Length is checked first when present, so an oversized upload is refused before a
 * byte of it is read. It is only a hint -- a chunked request has none, and a lying one is
 * cheap to send -- so the running total is what actually enforces the limit.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isInteger(declared) && declared > limit) {
    return tooLarge(limit);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      return tooLarge(limit);
    }
    chunks.push(buffer);
  }

  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

function tooLarge(limit: number): BodyResult {
  return {
    ok: false,
    code: "PAYLOAD_TOO_LARGE",
    message: `the request body must be at most ${limit} bytes`,
  };
}

function send(response: ServerResponse, reply: Reply, requestId: string): void {
  if (response.writableEnded) {
    return;
  }

  const isProblem = reply.status >= 400;
  const payload = JSON.stringify(reply.body);

  response.setHeader("Content-Type", isProblem ? PROBLEM_CONTENT_TYPE : JSON_CONTENT_TYPE);
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.setHeader("X-Request-Id", requestId);
  if (reply.location !== undefined) {
    response.setHeader("Location", reply.location);
  }
  if (reply.allow !== undefined) {
    response.setHeader("Allow", reply.allow.join(", "));
  }

  // A body that overran the limit was never fully read, so the socket still has the rest of
  // it coming. Announcing the close lets the client read this response before the
  // connection goes away, which a bare destroy() would not.
  const abandon = reply.status === 413;
  if (abandon) {
    response.setHeader("Connection", "close");
  }

  response.writeHead(reply.status);
  response.end(payload, () => {
    if (abandon) {
      response.req.destroy();
    }
  });
}
