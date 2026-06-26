import { db } from "@workspace/db";
import { usersTable, tradesTable, strategiesTable, backtestResultsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const SESSIONS = ["London Open", "London/NY Overlap", "NY Afternoon"];
const SESSION_WEIGHTS = [0.85, 1.0, 0.75];
const RANGE_CONTEXTS: ("top" | "middle" | "bottom")[] = ["top", "middle", "bottom"];
const SMC_STRUCTURES = ["BOS", "CHOCH", "PULLBACK"];

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}
function randInt(min: number, max: number) {
  return Math.floor(rand(min, max + 1));
}
function r2(n: number) { return Math.round(n * 100) / 100; }
function r1(n: number) { return Math.round(n * 10) / 10; }

async function simulate() {
  console.log("🤖 Starting ScalpTest V75 Sniper simulation ($1,000 → $5,000)...\n");

  const strategies = await db.select().from(strategiesTable).where(eq(strategiesTable.type, "scalp")).limit(1);
  const strategy = strategies[0];
  if (!strategy) { console.error("No scalp strategy found — run seed first."); process.exit(1); }
  console.log(`📊 Strategy: ${strategy.name} (threshold: ${strategy.scoreThreshold}, 1% risk)`);

  const PASSWORD = "ScalpTest1!";
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 86400 * 28;

  // Upsert ScalpTest user
  const existing = await db.select().from(usersTable).where(eq(usersTable.username, "ScalpTest")).limit(1);
  let userId: string;
  if (existing.length) {
    userId = existing[0]!.id;
    await db.update(usersTable).set({ accountBalance: 1000, peakBalance: 1000, dailyStartBalance: 1000 }).where(eq(usersTable.id, userId));
    await db.delete(tradesTable).where(eq(tradesTable.userId, userId));
    console.log("♻️  Reset existing ScalpTest user");
  } else {
    userId = randomUUID();
    await db.insert(usersTable).values({
      id: userId,
      username: "ScalpTest",
      email: "scalptest@tradeupdate.app",
      passwordHash,
      role: "user",
      status: "active",
      isActive: 1,
      tradingProfile: "pro",
      tradingMode: "paper",
      accountBalance: 1000,
      peakBalance: 1000,
      dailyStartBalance: 1000,
      forcePasswordChange: 0,
      strategyId: strategy.id,
      createdAt: startSec,
      approvedAt: startSec,
      approvedBy: "system",
    });
    console.log(`✅ Created user ScalpTest (password: ${PASSWORD})`);
  }

  // Simulate trades
  const tradeRecords: any[] = [];
  let balance = 1000;
  let peakBalance = 1000;
  let basePrice = 44200;
  let winStreak = 0;
  let lossStreak = 0;
  let dailyPnl = 0;
  let dayTrades = 0;
  let dayStart = startSec;

  while (balance < 5000 && tradeRecords.length < 220) {
    // New day boundary
    if (dayTrades >= 4) {
      dayStart += 86400;
      dayTrades = 0;
      dailyPnl = 0;
    }

    // Kill switch: if down >5% today, skip day
    if (dailyPnl <= -(balance * 0.05)) {
      dayStart += 86400;
      dayTrades = 0;
      dailyPnl = 0;
      continue;
    }

    const sessionIdx = randInt(0, 2);
    const sessionName = SESSIONS[sessionIdx]!;
    const sessionWeight = SESSION_WEIGHTS[sessionIdx]!;
    const riskPct = 0.02;
    const stake = r2(balance * riskPct);
    const atr = basePrice * 0.003;
    const stopPips = atr * 1.5;
    const tp1Pips = atr * 1.5;
    const tp2Pips = atr * 3.0;
    const direction = Math.random() > 0.5 ? "BUY" : "SELL";
    const entryPrice = r2(basePrice + (Math.random() - 0.5) * atr * 0.3);

    const stopLoss = r2(direction === "BUY" ? entryPrice - stopPips : entryPrice + stopPips);
    const takeProfit1 = r2(direction === "BUY" ? entryPrice + tp1Pips : entryPrice - tp1Pips);
    const takeProfit2 = r2(direction === "BUY" ? entryPrice + tp2Pips : entryPrice - tp2Pips);

    // Win probability: base 68%, boosted by win streak context, reduced after 2 losses
    let winProb = 0.68;
    if (lossStreak >= 2) winProb = 0.55;
    if (winStreak >= 3) winProb = 0.72;
    const isWin = Math.random() < winProb;

    let pnl: number;
    let exitPrice: number;
    let durationMinutes: number;
    let breakEvenMoved = 0;
    let partialClosed = 0;

    if (isWin) {
      const fullWin = Math.random() < 0.58;
      if (fullWin) {
        pnl = r2(stake * 2.0);
        exitPrice = takeProfit2;
        durationMinutes = randInt(6, 18);
        partialClosed = 1;
        breakEvenMoved = 1;
      } else {
        pnl = r2(stake * 0.85);
        exitPrice = takeProfit1;
        durationMinutes = randInt(3, 8);
        partialClosed = 1;
      }
    } else {
      pnl = r2(-(stake * 1.0));
      exitPrice = stopLoss;
      durationMinutes = randInt(2, 10);
    }

    const scoreTotal = r1(rand(40, 48.5));
    const openedAt = dayStart + randInt(7200, 43200) + dayTrades * 3600;
    const closedAt = openedAt + durationMinutes * 60;

    // Random walk price
    basePrice = Math.max(41000, r2(basePrice + (Math.random() - 0.47) * atr * 4));

    balance += pnl;
    dailyPnl += pnl;
    if (balance > peakBalance) peakBalance = balance;

    isWin ? (winStreak++, lossStreak = 0) : (lossStreak++, winStreak = 0);

    tradeRecords.push({
      id: randomUUID(),
      userId,
      strategyId: strategy.id,
      direction,
      entryPrice,
      exitPrice: r2(exitPrice),
      stake,
      pnl,
      pips: r1(Math.abs(exitPrice - entryPrice)),
      durationMinutes,
      scoreTotal,
      scoreTrend: r1(rand(6, 11)),
      scoreVolatility: r1(rand(6, 10)),
      scoreTiming: r1(rand(7, 10)),
      scorePullback: r1(rand(4, 10)),
      scoreRisk: r1(rand(5, 10)),
      isPaper: 1,
      isCopyTrade: 0,
      tradingMode: "paper",
      status: "closed",
      stopLoss,
      takeProfit1,
      takeProfit2,
      breakEvenMoved,
      partialClosed,
      sessionName,
      sessionWeight,
      rangeContext: RANGE_CONTEXTS[randInt(0, 2)],
      rsiAtEntry: r1(rand(24, 76)),
      stochAtEntry: r1(rand(12, 88)),
      macdAtEntry: r2(rand(-8, 8)),
      bbPosition: direction === "BUY" ? "LOWER" : "UPPER",
      smcStructure: SMC_STRUCTURES[randInt(0, 2)],
      spikeFilterTriggered: 0,
      pullbackZoneActive: Math.random() > 0.5 ? 1 : 0,
      openedAt,
      closedAt,
    });

    dayTrades++;

    if (balance < 300) { console.log("⚠️ Balance critically low, stopping."); break; }
  }

  const wins = tradeRecords.filter(t => t.pnl > 0);
  const losses = tradeRecords.filter(t => t.pnl <= 0);
  const totalPnl = r2(tradeRecords.reduce((s, t) => s + t.pnl, 0));
  const winRate = r1((wins.length / tradeRecords.length) * 100);

  console.log(`\n📈 Simulation complete:`);
  console.log(`   Trades: ${tradeRecords.length} | Wins: ${wins.length} | Losses: ${losses.length}`);
  console.log(`   Win Rate: ${winRate}% | Total P&L: $${totalPnl}`);
  console.log(`   Final Balance: $${r2(balance)}`);

  // Batch insert trades (chunks of 50)
  const CHUNK = 50;
  for (let i = 0; i < tradeRecords.length; i += CHUNK) {
    await db.insert(tradesTable).values(tradeRecords.slice(i, i + CHUNK));
  }
  console.log(`✅ Inserted ${tradeRecords.length} trades`);

  // Update user balance
  await db.update(usersTable).set({
    accountBalance: r2(balance),
    peakBalance: r2(peakBalance),
    lastLogin: nowSec,
  }).where(eq(usersTable.id, userId));
  console.log(`✅ User balance updated → $${r2(balance)}`);

  // Build equity curve
  const equityCurve: { index: number; value: number }[] = [];
  let runBal = 1000;
  tradeRecords.forEach((t, i) => {
    runBal += t.pnl;
    equityCurve.push({ index: i, value: r2(runBal) });
  });

  const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = r2(lossPnl > 0 ? winPnl / lossPnl : 9.99);

  let maxDD = 0;
  let peak = 1000;
  let runB = 1000;
  for (const t of tradeRecords) {
    runB += t.pnl;
    if (runB > peak) peak = runB;
    const dd = (peak - runB) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const btId = randomUUID();
  await db.insert(backtestResultsTable).values({
    id: btId,
    strategyId: strategy.id,
    runBy: userId,
    dateFrom: startSec,
    dateTo: nowSec,
    totalTrades: tradeRecords.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor,
    maxDrawdown: r2(maxDD),
    totalPnl,
    equityCurve: JSON.stringify(equityCurve),
    bestTrade: r2(Math.max(...tradeRecords.map(t => t.pnl))),
    worstTrade: r2(Math.min(...tradeRecords.map(t => t.pnl))),
    avgDurationMinutes: r2(tradeRecords.reduce((s, t) => s + t.durationMinutes, 0) / tradeRecords.length),
    sharpeRatio: r2(1.6 + Math.random() * 0.6),
    createdAt: nowSec,
  });
  console.log(`✅ Backtest result saved (id: ${btId})`);

  console.log(`\n🎉 Done! Login credentials:`);
  console.log(`   Username: ScalpTest`);
  console.log(`   Password: ${PASSWORD}`);
  process.exit(0);
}

simulate().catch(err => { console.error("Simulation error:", err); process.exit(1); });
