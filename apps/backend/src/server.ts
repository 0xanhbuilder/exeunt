import { createChainLayer } from "@exeunt/mcp";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config/index.js";
import { openDatabase } from "./shared/db/database.js";
import { migrate } from "./shared/db/migrations.js";
import { ChainGateway } from "./shared/integrations/chain/chain.gateway.js";
import { createLogger } from "./shared/middlewares/logger.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

function main(): void {
  const config = readConfig();
  const logger = createLogger({ nodeId: config.nodeId, level: config.logLevel });
  const log = logger.child({ module: "server" });

  const db = openDatabase(config.dbPath);
  migrate(db);

  const chainOptions = { deploymentsDir: config.deploymentsDir, rpcUrls: config.rpcUrls };
  const { app, capacity, alerts } = createApp({
    db,
    logger,
    chain: new ChainGateway(chainOptions),
    mcpChain: createChainLayer(chainOptions),
    corsOrigin: config.corsOrigin,
    webhookSecret: config.webhookSecret,
  });

  const poller = capacity.createPoller(config.pollIntervalMs, [(snapshots) => alerts.service.evaluateSnapshots(snapshots)]);
  const server = app.listen(config.port, () => {
    log.info({ port: config.port, deploymentsDir: config.deploymentsDir, pollIntervalMs: config.pollIntervalMs }, "listening");
    poller.start();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    void (async () => {
      await poller.stop();
      // Stop accepting connections and let in-flight requests finish.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      log.info("stopped");
      process.exit(0);
    })();
    server.closeIdleConnections();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
