export interface TradingSession {
  name: string;
  startUtcHour: number;
  endUtcHour: number;
  quality: "MODERATE" | "HIGH" | "PREMIUM";
}

export const SESSIONS: TradingSession[] = [
  { name: "Asian/Tokyo", startUtcHour: 0, endUtcHour: 3, quality: "MODERATE" },
  { name: "London Open", startUtcHour: 7, endUtcHour: 10, quality: "HIGH" },
  { name: "London/NY Overlap", startUtcHour: 12, endUtcHour: 15, quality: "PREMIUM" },
  { name: "NY Afternoon", startUtcHour: 13, endUtcHour: 16, quality: "HIGH" },
];

export function getCurrentSession(): TradingSession | null {
  const nowUtc = new Date();
  const utcHour = nowUtc.getUTCHours() + nowUtc.getUTCMinutes() / 60;
  return SESSIONS.find((s) => utcHour >= s.startUtcHour && utcHour < s.endUtcHour) || null;
}

export function isInSession(sessionNames: string[]): boolean {
  const current = getCurrentSession();
  if (!current) return false;
  if (!sessionNames || sessionNames.length === 0) return true;
  return sessionNames.includes(current.name);
}

export function getNextSession(): { session: TradingSession; minutesUntil: number } | null {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let best: { session: TradingSession; minutesUntil: number } | null = null;

  for (const session of SESSIONS) {
    const startMinutes = session.startUtcHour * 60;
    let diff = startMinutes - utcMinutes;
    if (diff < 0) diff += 24 * 60;
    if (!best || diff < best.minutesUntil) {
      best = { session, minutesUntil: diff };
    }
  }
  return best;
}
