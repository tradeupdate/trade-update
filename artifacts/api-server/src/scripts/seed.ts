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
    { profile: "safe", minBalance: 1000, maxRiskPercent: 1.0, maxTradesDay: 6, scoreThreshold: 16, consecutiveLossStop: 2, maxTradesHour: 2, sessionsEnabled: JSON.stringify(["London/NY Overlap", "London Open"]) },
    { profile: "pro", minBalance: 3000, maxRiskPercent: 1.5, maxTradesDay: 6, scoreThreshold: 16, consecutiveLossStop: 3, maxTradesHour: 3, sessionsEnabled: JSON.stringify(["London/NY Overlap", "London Open", "NY Afternoon"]) },
    { profile: "aggressive", minBalance: 5000, maxRiskPercent: 2.0, maxTradesDay: 8, scoreThreshold: 16, consecutiveLossStop: 4, maxTradesHour: 4, sessionsEnabled: "[]" },
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
      scoreThreshold: 16, maxTradesDay: 6, maxRiskPercent: 1.0, maxTradesHour: 2,
      stopMultiplier: 1.5, tp1Multiplier: 1.5, tp2Multiplier: 3.0,
      momentumExtensionEnabled: 1, spikeFilterEnabled: 1, spikeFilterMultiplier: 3.0,
      consolidationDetection: 1, firstCandleRule: 1, consecutiveLossStop: 3,
      pair: "R_75",
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 68.5, avgScore: 42.1,
    },
    {
      id: randomUUID(), name: "V75 Swing", type: "swing",
      description: "Range consolidation breakout strategy on 4h/1h trend, retest entry. Higher R:R, fewer entries. Session-aware with blackout zones.",
      status: "active", entryTimeframe: "1h", signalTimeframe: "15m", trendTimeframe: "4h",
      sessionsEnabled: JSON.stringify(["Asian/Tokyo", "London Open", "London/NY Overlap", "NY Afternoon"]),
      scoreThreshold: 20, maxTradesDay: 3, maxRiskPercent: 1.0, maxTradesHour: 1,
      stopMultiplier: 2.0, tp1Multiplier: 2.0, tp2Multiplier: 4.0,
      momentumExtensionEnabled: 1, spikeFilterEnabled: 1, spikeFilterMultiplier: 4.0,
      consolidationDetection: 1, firstCandleRule: 0, consecutiveLossStop: 2,
      pair: "R_75",
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 0, avgScore: 0,
    },
    {
      id: randomUUID(), name: "V75 Reversal", type: "reversal",
      description: "Counter-trend strategy trading RSI extremes after significant session moves. Requires dual-timeframe divergence confirmation and 1m candle entry confirmation. Fast trades targeting middle BB. Maximum 5 per day.",
      status: "active", entryTimeframe: "1m", signalTimeframe: "5m", trendTimeframe: "15m",
      sessionsEnabled: JSON.stringify(["asian", "london", "overlap", "ny"]),
      scoreThreshold: 20, maxTradesDay: 5, maxRiskPercent: 1.0, maxTradesHour: 2,
      stopMultiplier: 1.0, tp1Multiplier: 0, tp2Multiplier: 0,
      counterTrendEnabled: 1, counterTrendRsiThreshold: 78, counterTrendBbSigma: 2.5,
      momentumExtensionEnabled: 0, spikeFilterEnabled: 1, spikeFilterMultiplier: 2.0,
      consolidationDetection: 1, firstCandleRule: 0, consecutiveLossStop: 3,
      pair: "R_75",
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 0, avgScore: 0,
    },
    {
      id: randomUUID(), name: "V10 Range Scalper", type: "mean_reversion",
      description: "Mean-reversion strategy on the Volatility 10 Index. Trades BB extremes in clean ranging conditions 24/7. Single TP at middle BB. 15-minute time stop. Score threshold 18/25.",
      status: "active", entryTimeframe: "1m", signalTimeframe: "5m", trendTimeframe: "15m",
      sessionsEnabled: "[]",
      scoreThreshold: 18, maxTradesDay: 15, maxRiskPercent: 1.0, maxTradesHour: 3,
      stopMultiplier: 1.0, tp1Multiplier: 0, tp2Multiplier: 0,
      momentumExtensionEnabled: 0, spikeFilterEnabled: 1, spikeFilterMultiplier: 2.5,
      consolidationDetection: 0, firstCandleRule: 0, consecutiveLossStop: 3,
      pair: "R_10",
      createdAt: now, updatedAt: now, createdBy: "system", winRate: 0, avgScore: 0,
    },
  ];

  for (const s of strategies) {
    await db.insert(strategiesTable).values(s).onConflictDoNothing();
  }
  console.log("✅ Strategies seeded");

  const sniperStrategyId   = strategies[0]!.id;
  const swingStrategyId    = strategies[1]!.id;
  const reversalStrategyId = strategies[2]!.id;
  const v10StrategyId      = strategies[3]!.id;

  // Admin user
  const adminExists = await db.select().from(usersTable).where(eq(usersTable.username, "admin")).limit(1);
  if (!adminExists.length) {
    const adminHash = await bcrypt.hash("Admin1234!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "admin", email: "admin@tradeupdate.app",
      passwordHash: adminHash, role: "admin", status: "active", isActive: 1,
      tradingProfile: "pro", tradingMode: "paper",
      accountBalance: 10000, peakBalance: 10000, dailyStartBalance: 10000,
      forcePasswordChange: 0, createdAt: now, strategyId: sniperStrategyId,
      activePair: "R_75",
    });
    console.log("✅ Admin user: admin / Admin1234!");
  } else {
    console.log("ℹ️  Admin user already exists");
  }

  // Test user (Sniper)
  const testExists = await db.select().from(usersTable).where(eq(usersTable.username, "Clean10test")).limit(1);
  if (!testExists.length) {
    const testHash = await bcrypt.hash("Test1234!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "Clean10test", email: "test@tradeupdate.app",
      passwordHash: testHash, role: "user", status: "active", isActive: 1,
      tradingProfile: "safe", tradingMode: "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 0, createdAt: now, strategyId: sniperStrategyId,
      activePair: "R_75",
    });
    console.log("✅ Test user: Clean10test / Test1234!");
  } else {
    console.log("ℹ️  Test user already exists");
  }

  // Swing test user
  const swingTestExists = await db.select().from(usersTable).where(eq(usersTable.username, "swingtest100")).limit(1);
  if (!swingTestExists.length) {
    const swingHash = await bcrypt.hash("Swing100!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "swingtest100", email: "swingtest@tradeupdate.app",
      passwordHash: swingHash, role: "user", status: "active", isActive: 1,
      tradingProfile: "safe", tradingMode: "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 0, createdAt: now, strategyId: swingStrategyId,
      activePair: "R_75",
    });
    console.log("✅ Swing test user: swingtest100 / Swing100!");
  } else {
    console.log("ℹ️  Swing test user already exists");
  }

  // Reversal test user
  const reversalTestExists = await db.select().from(usersTable).where(eq(usersTable.username, "reversaltest100")).limit(1);
  if (!reversalTestExists.length) {
    const reversalHash = await bcrypt.hash("Reversal100!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "reversaltest100", email: "reversaltest@tradeupdate.app",
      passwordHash: reversalHash, role: "user", status: "active", isActive: 1,
      tradingProfile: "safe", tradingMode: "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 0, createdAt: now, strategyId: reversalStrategyId,
      activePair: "R_75",
    });
    console.log("✅ Reversal test user: reversaltest100 / Reversal100!");
  } else {
    console.log("ℹ️  Reversal test user already exists");
  }

  // V10 test user
  const v10TestExists = await db.select().from(usersTable).where(eq(usersTable.username, "v10test100")).limit(1);
  if (!v10TestExists.length) {
    const v10Hash = await bcrypt.hash("V10Test100!", 12);
    await db.insert(usersTable).values({
      id: randomUUID(), username: "v10test100", email: "v10test@tradeupdate.app",
      passwordHash: v10Hash, role: "user", status: "active", isActive: 1,
      tradingProfile: "safe", tradingMode: "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 0, createdAt: now, strategyId: v10StrategyId,
      activePair: "R_10",
    });
    console.log("✅ V10 test user: v10test100 / V10Test100!");
  } else {
    console.log("ℹ️  V10 test user already exists");
  }

  console.log("\n🎉 Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
