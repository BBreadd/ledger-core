// router.ts -- method and path to handler, with an honest answer when neither matches.
// Depends on: nothing.

export type RouteParams = Readonly<Record<string, string>>;

export type Match<H> =
  | { readonly kind: "found"; readonly handler: H; readonly params: RouteParams }
  /** The path exists, the method does not. Carries what to put in the Allow header. */
  | { readonly kind: "method-not-allowed"; readonly allowed: readonly string[] }
  | { readonly kind: "not-found" }
  /** The target could not be read as a path at all, such as a broken percent-escape. */
  | { readonly kind: "bad-target"; readonly detail: string };

type Segment = { readonly literal: string } | { readonly parameter: string };

type CompiledRoute<H> = {
  readonly method: string;
  readonly segments: readonly Segment[];
  readonly handler: H;
};

/**
 * Five routes and one content type do not need a framework. What a framework would bring
 * here is routing, and routing here is a list of at most four segments compared for
 * equality -- the rest of what it brings is paid for at forty routes, not at five.
 *
 * Patterns look like "POST /v1/transactions/:id/reversal". A segment starting with a colon
 * captures.
 */
export function createRouter<H>(routes: Readonly<Record<string, H>>): {
  match(method: string | undefined, target: string | undefined): Match<H>;
} {
  const compiled: CompiledRoute<H>[] = Object.entries(routes).map(([pattern, handler]) => {
    const [method, path] = pattern.split(" ");
    if (method === undefined || path === undefined) {
      throw new Error(`route pattern must be "METHOD /path", got ${JSON.stringify(pattern)}`);
    }
    return { method, segments: compile(path), handler };
  });

  return {
    match(method, target) {
      if (method === undefined || target === undefined) {
        return { kind: "bad-target", detail: "request had no method or target" };
      }

      const path = splitPath(target);
      if (path === null) {
        return { kind: "bad-target", detail: `${JSON.stringify(target)} is not a valid path` };
      }

      const allowed: string[] = [];
      for (const route of compiled) {
        const params = matchSegments(route.segments, path);
        if (params === null) {
          continue;
        }
        if (route.method === method) {
          return { kind: "found", handler: route.handler, params };
        }
        allowed.push(route.method);
      }

      return allowed.length > 0
        ? { kind: "method-not-allowed", allowed }
        : { kind: "not-found" };
    },
  };
}

function compile(path: string): Segment[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment.startsWith(":") ? { parameter: segment.slice(1) } : { literal: segment },
    );
}

/**
 * The query string is dropped: no route reads one. A trailing slash is dropped too, so
 * /health and /health/ are the same route rather than one of them being a 404 nobody can
 * explain.
 *
 * Returns null when a percent-escape is malformed. decodeURIComponent throws on "%zz", and
 * letting that reach the handler would turn a client's typo into a 500.
 */
function splitPath(target: string): string[] | null {
  const withoutQuery = target.split("?")[0] ?? "";
  try {
    return withoutQuery
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function matchSegments(segments: readonly Segment[], path: readonly string[]): RouteParams | null {
  if (segments.length !== path.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of segments.entries()) {
    const actual = path[index];
    if (actual === undefined) {
      return null;
    }
    if ("literal" in segment) {
      if (segment.literal !== actual) {
        return null;
      }
      continue;
    }
    params[segment.parameter] = actual;
  }
  return params;
}
