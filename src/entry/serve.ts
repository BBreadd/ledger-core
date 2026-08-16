// serve.ts -- entry point: builds the HTTP surface and starts listening.
// Depends on: config, adapters, application.

import { loadServerConfig } from "../config.ts";
import { createLedgerServer } from "../adapters/http/server.ts";
import { createLedgerStore } from "../adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../adapters/uuid-v7.ts";

/**
 * How long a shutdown waits for requests already in flight before taking the connections
 * away. A process that dies mid-write is the first cause of corrupted data, and one that
 * refuses to die is the first cause of a stuck deploy.
 */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Composition root, the same shape demo.ts has: everything is constructed here and
  // passed down, and nothing below this line reads the environment.
  const config = loadServerConfig();
  const store = createLedgerStore(config.databaseUrl);
  const server = createLedgerServer({
    store,
    newId: createUuidV7(),
    token: config.apiToken,
  });

  // Fail at startup, not at the first request. A server that accepts connections it cannot
  // serve turns a configuration mistake into an incident.
  await store.ping();

  server.listen(config.port, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    console.log(JSON.stringify({ event: "listening", port }));
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  async function shutdown(signal: string): Promise<void> {
    console.log(JSON.stringify({ event: "shutdown.started", signal }));

    // close() stops accepting new connections and waits for open ones to go idle;
    // closeIdleConnections() releases the keep-alive sockets that are idle right now and
    // would otherwise hold the process open for their full timeout. Without the second
    // call a graceful shutdown routinely takes as long as keepAliveTimeout for no reason.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();

    const forced = setTimeout(() => {
      console.log(JSON.stringify({ event: "shutdown.forced", afterMs: SHUTDOWN_GRACE_MS }));
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    forced.unref();

    await closed;
    clearTimeout(forced);
    await store.close();
    console.log(JSON.stringify({ event: "shutdown.complete" }));
  }
}

await main();
