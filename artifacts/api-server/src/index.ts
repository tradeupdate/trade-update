import app from "./app";
import { logger } from "./lib/logger";
import { recordKeepAlivePing } from "./routes/health.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Item 1 — Keep-alive: self-ping every 4 minutes
  startKeepAlive(port);

  // Item 5 — Hard stop auto-restart check on startup + hourly
  const { botManager } = await import("./services/bot.js");
  const { derivService } = await import("./services/deriv.js");
  botManager.checkAutoRestart().catch(() => {});
  setInterval(() => botManager.checkAutoRestart().catch(() => {}), 60 * 60 * 1000);

  // Item 6 — Compound: daily midnight UTC
  botManager.scheduleDailyCompound();
  botManager.scheduleDailySummary();

  // Item 2 — Contract sync on Deriv reconnection for all live users
  derivService.onReconnect(async () => {
    try {
      const { db } = await import("@workspace/db");
      const { usersTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const liveUsers = await db.select().from(usersTable).where(eq(usersTable.tradingMode, "live"));
      for (const u of liveUsers) {
        botManager.syncDerivContracts(u.id).catch(() => {});
      }
    } catch {}
  });
});

function startKeepAlive(port: number) {
  const PING_INTERVAL = 4 * 60 * 1000;

  setInterval(async () => {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      const data = await response.json() as { status?: string };
      recordKeepAlivePing();
      logger.debug(`Keep-alive ping: ${data.status} at ${new Date().toISOString()}`);
    } catch (error) {
      logger.warn({ error }, "Keep-alive ping failed");
    }
  }, PING_INTERVAL);

  logger.info("Keep-alive system started — pinging every 4 minutes");
}
