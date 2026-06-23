import { db } from "@workspace/db";
import {
  usersTable, strategiesTable, tradingProfilesTable,
  systemSettingsTable, pendingSignupsTable
} from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

async function seed() {
  console.log("🌱 Seeding TradeUpdate database...");

  // System settings
  await db.insert(systemSettingsTable).values({ key: "master_stop", value: "false" }).onConflictDoNothing();
  console.log("✅ System settings seeded");

  // Trading profiles
  const profiles = [
    { profile: "safe", minBalance: 1000, maxRiskPercent: 1.0, maxTradesDay: 4, scoreThreshold: 40, consecutiveLossStop: 2, maxTradesHour: 2, sessionsEnabled: JSON.stringify(["London/NY Overlap", "London Open"]) },
    { profile: "pro", minBalance: 3000, maxRiskPercent: 1.5, maxTradesDay: 6, scoreThreshold: 38, consecutiveLossStop: 3, maxTradesHour: 3, sessionsEnabled: JSON.stringify(["London/NY Overlap", "London Open", "NY Afternoon"]) },
    { profile: "aggressive", minBalance: 5000, maxRiskPercent: 2.0, maxTradesDay: 8, scoreThreshold: 36, consecutiveLossStop: 4, maxTradesHour: 4, sessionsEnabled: "[]" },
  ];

  for (const p of profiles) {
    await db.insert(tradingProfilesTable).values({ ...p, updatedAt: Math.floor(Date.now() / 1000) }).onConflictDoNothing();
  }
  console.log("✅ Trading profiles seeded");

  // Strategies
  const now = Math.floor(Date.now() / 1000);
  const strategies = [
    {
      id: randomUUID(), name: "V75 Sniper", type: "scalp",
      description: "High-precision scalping on 1m with 5m confirmation. Targets institutional order blocks at key levels.",
      status: "active", entryTimeframe: "1m", signalTimeframe: "5m", trendTimeframe: "15m",
      sessionsEnabled: JSON.stringify(["London/NY Overlap", "London Open"]),
      scoreThreshold: 40, maxTradesDay: 4, maxRiskPercent: 1.0,
      stopMultiplier: 1.5, tp1Multiplier: 1.5, tp2Multiplier: 3.0,
      momentumExtensionEnabled: 1, spikeFilterEnabled: 1, spikeFilterMultiplier: 3.0,
      consolidationDetection: 1, firstCandleRule: 1,
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 68.5, avgScore: 42.1,
    },
    {
      id: randomUUID(), name: "V75 Swing", type: "swing",
      description: "Multi-session swing trades on 5m+15m trend alignment. Higher R:R, fewer entries.",
      status: "active", entryTimeframe: "5m", signalTimeframe: "15m", trendTimeframe: "15m",
      sessionsEnabled: JSON.stringify(["London/NY Overlap", "London Open", "NY Afternoon"]),
      scoreThreshold: 38, maxTradesDay: 3, maxRiskPercent: 1.5,
      stopMultiplier: 2.0, tp1Multiplier: 2.0, tp2Multiplier: 4.0,
      momentumExtensionEnabled: 1, spikeFilterEnabled: 1, spikeFilterMultiplier: 2.5,
      consolidationDetection: 1, firstCandleRule: 0,
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 71.2, avgScore: 43.8,
    },
    {
      id: randomUUID(), name: "V75 Reversal", type: "reversal",
      description: "Counter-trend entries at extreme RSI/BB with SMC confluence. High score threshold.",
      status: "active", entryTimeframe: "1m", signalTimeframe: "5m", trendTimeframe: "15m",
      sessionsEnabled: JSON.stringify(["London/NY Overlap"]),
      scoreThreshold: 44, maxTradesDay: 2, maxRiskPercent: 1.0,
      stopMultiplier: 1.2, tp1Multiplier: 2.0, tp2Multiplier: 4.0,
      counterTrendEnabled: 1, counterTrendRsiThreshold: 78, counterTrendBbSigma: 2.5,
      momentumExtensionEnabled: 1, spikeFilterEnabled: 1, spikeFilterMultiplier: 3.5,
      consolidationDetection: 1, firstCandleRule: 1,
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 65.3, avgScore: 45.6,
    },
  ];

  for (const s of strategies) {
    await db.insert(strategiesTable).values(s).onConflictDoNothing();
  }
  console.log("✅ Strategies seeded");

  const strategyId = strategies[0]!.id;

  // Admin user
  const adminExists = await db.select().from(usersTable).where(eq(usersTable.username, "admin")).limit(1);
  if (!adminExists.length) {
    const adminHash = await bcrypt.hash("Admin1234!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "admin", email: "admin@tradeupdate.app",
      passwordHash: adminHash, role: "admin", status: "active", isActive: 1,
      tradingProfile: "pro", tradingMode: "paper",
      accountBalance: 10000, peakBalance: 10000, dailyStartBalance: 10000,
      forcePasswordChange: 0, createdAt: now, strategyId,
    });
    console.log("✅ Admin user: admin / Admin1234!");
  } else {
    console.log("ℹ️  Admin user already exists");
  }

  // Test user
  const testExists = await db.select().from(usersTable).where(eq(usersTable.username, "Clean10test")).limit(1);
  if (!testExists.length) {
    const testHash = await bcrypt.hash("Test1234!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "Clean10test", email: "test@tradeupdate.app",
      passwordHash: testHash, role: "user", status: "active", isActive: 1,
      tradingProfile: "safe", tradingMode: "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 0, createdAt: now, strategyId,
    });
    console.log("✅ Test user: Clean10test / Test1234!");
  } else {
    console.log("ℹ️  Test user already exists");
  }

  console.log("\n🎉 Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
