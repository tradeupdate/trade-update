import { logger } from "../lib/logger.js";
import fs from "fs";
import path from "path";

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

const outboxPath = path.join(process.cwd(), "email-outbox.json");

function saveToOutbox(payload: EmailPayload) {
  let outbox: EmailPayload[] = [];
  try {
    if (fs.existsSync(outboxPath)) {
      outbox = JSON.parse(fs.readFileSync(outboxPath, "utf-8"));
    }
  } catch {}
  outbox.push({ ...payload });
  try {
    fs.writeFileSync(outboxPath, JSON.stringify(outbox, null, 2));
  } catch {}
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  const smtpHost = process.env["SMTP_HOST"];
  if (!smtpHost) {
    logger.info({ to: payload.to, subject: payload.subject }, "Email (SMTP not configured, logging only)");
    saveToOutbox(payload);
    return;
  }
  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: parseInt(process.env["SMTP_PORT"] || "587"),
      auth: {
        user: process.env["SMTP_USER"],
        pass: process.env["SMTP_PASS"],
      },
    });
    await transporter.sendMail({
      from: process.env["SMTP_FROM"] || "TradeUpdate <noreply@tradeupdate.app>",
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
    });
    logger.info({ to: payload.to, subject: payload.subject }, "Email sent");
  } catch (err) {
    logger.error({ err }, "Failed to send email");
    saveToOutbox(payload);
  }
}

const dark = `
  <style>
    body { background: #080A0F; color: #F0F2FF; font-family: Inter, sans-serif; padding: 40px; }
    .card { background: #0F1117; border: 1px solid #1C1F2E; border-radius: 12px; padding: 32px; max-width: 560px; margin: 0 auto; }
    .logo { color: #00D4A4; font-size: 24px; font-weight: 800; margin-bottom: 24px; }
    .body { color: #8890AA; line-height: 1.7; }
    .footer { margin-top: 24px; color: #4A5060; font-size: 12px; }
  </style>
`;

export async function sendSignupReceivedEmail(to: string, username: string, country: string) {
  await sendEmail({
    to,
    subject: "Your TradeUpdate access request received",
    html: `<!DOCTYPE html><html>${dark}<body><div class="card">
      <div class="logo">TradeUpdate</div>
      <div class="body">
        <p>Hi <strong>${username}</strong>,</p>
        <p>Thank you for requesting access to TradeUpdate. Your application is under review. We'll notify you by email once a decision has been made.</p>
        <p>Country registered: <strong>${country}</strong></p>
        <p>— The TradeUpdate Team</p>
      </div>
      <div class="footer">TradeUpdate • Professional V75 Trading</div>
    </div></body></html>`,
  });
}

export async function sendApprovedEmail(to: string, username: string) {
  const appUrl = process.env["APP_URL"] || "https://tradeupdate.app";
  await sendEmail({
    to,
    subject: "✅ Your TradeUpdate access has been approved",
    html: `<!DOCTYPE html><html>${dark}<body><div class="card">
      <div class="logo">TradeUpdate</div>
      <div class="body">
        <p>Hi <strong>${username}</strong>,</p>
        <p>Great news — your access to TradeUpdate has been approved! You can now log in and start trading.</p>
        <p>Login at: <a href="${appUrl}/login" style="color:#00D4A4">${appUrl}/login</a></p>
        <p>Your account starts on the Safe trading profile.</p>
        <p>— The TradeUpdate Team</p>
      </div>
      <div class="footer">TradeUpdate • Professional V75 Trading</div>
    </div></body></html>`,
  });
}

export interface DailySummaryStats {
  date: string;
  totalPnl: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  bestTrade: { direction: string; pnl: number } | null;
  worstTrade: { direction: string; pnl: number } | null;
  sessions: Array<{ name: string; pnl: number; wins: number; total: number }>;
  strategyName: string;
  accountBalance: number;
}

export async function sendDailySummaryEmail(to: string, username: string, stats: DailySummaryStats) {
  const appUrl = process.env["APP_URL"] || "https://tradeupdate.app";
  const pnlColor = stats.totalPnl >= 0 ? "#00D4A4" : "#FF4060";
  const pnlSign = stats.totalPnl >= 0 ? "+" : "";
  const winPct = stats.winRate.toFixed(0);

  const sessionRows = stats.sessions
    .map(s => {
      const sColor = s.pnl >= 0 ? "#00D4A4" : "#FF4060";
      const sSign = s.pnl >= 0 ? "+" : "";
      return `<tr>
        <td style="padding:6px 8px;color:#8890AA;font-size:13px">${s.name}</td>
        <td style="padding:6px 8px;text-align:center;color:#F0F2FF;font-size:13px">${s.total}</td>
        <td style="padding:6px 8px;text-align:center;color:#8890AA;font-size:13px">${s.wins}/${s.total - s.wins}</td>
        <td style="padding:6px 8px;text-align:right;color:${sColor};font-size:13px;font-weight:bold;font-family:monospace">${sSign}$${Math.abs(s.pnl).toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  const bestRow = stats.bestTrade
    ? `<p style="margin:4px 0;font-size:13px"><span style="color:#4A5060">Best trade:</span> <strong style="color:#00D4A4">+$${stats.bestTrade.pnl.toFixed(2)}</strong> <span style="color:#8890AA">${stats.bestTrade.direction}</span></p>`
    : "";
  const worstRow = stats.worstTrade
    ? `<p style="margin:4px 0;font-size:13px"><span style="color:#4A5060">Worst trade:</span> <strong style="color:#FF4060">$${stats.worstTrade.pnl.toFixed(2)}</strong> <span style="color:#8890AA">${stats.worstTrade.direction}</span></p>`
    : "";

  await sendEmail({
    to,
    subject: `📊 Daily Summary ${stats.date} — ${pnlSign}$${Math.abs(stats.totalPnl).toFixed(2)} | ${winPct}% win rate`,
    html: `<!DOCTYPE html><html>${dark}<body>
<div class="card">
  <div class="logo">TradeUpdate</div>
  <p style="color:#8890AA;font-size:13px;margin-top:-12px;margin-bottom:24px">${stats.date} • ${stats.strategyName}</p>

  <div style="display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap">
    <div style="flex:1;min-width:120px;background:#080A0F;border:1px solid #1C1F2E;border-radius:10px;padding:16px 20px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:${pnlColor};font-family:monospace">${pnlSign}$${Math.abs(stats.totalPnl).toFixed(2)}</div>
      <div style="font-size:11px;color:#4A5060;margin-top:4px;text-transform:uppercase;letter-spacing:.05em">Total P&amp;L</div>
    </div>
    <div style="flex:1;min-width:120px;background:#080A0F;border:1px solid #1C1F2E;border-radius:10px;padding:16px 20px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#00D4A4">${winPct}%</div>
      <div style="font-size:11px;color:#4A5060;margin-top:4px;text-transform:uppercase;letter-spacing:.05em">Win Rate</div>
    </div>
    <div style="flex:1;min-width:120px;background:#080A0F;border:1px solid #1C1F2E;border-radius:10px;padding:16px 20px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#F0F2FF">${stats.tradeCount}</div>
      <div style="font-size:11px;color:#4A5060;margin-top:4px;text-transform:uppercase;letter-spacing:.05em">Trades</div>
    </div>
  </div>

  <div style="margin-bottom:20px">
    ${bestRow}${worstRow}
    <p style="margin:4px 0;font-size:13px"><span style="color:#4A5060">Account balance:</span> <span style="color:#F0F2FF;font-family:monospace">$${stats.accountBalance.toFixed(2)}</span></p>
    <p style="margin:4px 0;font-size:13px"><span style="color:#4A5060">W/L:</span> <span style="color:#00D4A4">${stats.winCount}W</span> / <span style="color:#FF4060">${stats.lossCount}L</span></p>
  </div>

  ${sessionRows ? `
  <div style="margin-bottom:20px">
    <p style="font-size:12px;color:#4A5060;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Session Breakdown</p>
    <table style="width:100%;border-collapse:collapse;background:#080A0F;border:1px solid #1C1F2E;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="border-bottom:1px solid #1C1F2E">
          <th style="padding:6px 8px;text-align:left;color:#4A5060;font-size:11px;font-weight:500;text-transform:uppercase">Session</th>
          <th style="padding:6px 8px;text-align:center;color:#4A5060;font-size:11px;font-weight:500;text-transform:uppercase">Trades</th>
          <th style="padding:6px 8px;text-align:center;color:#4A5060;font-size:11px;font-weight:500;text-transform:uppercase">W/L</th>
          <th style="padding:6px 8px;text-align:right;color:#4A5060;font-size:11px;font-weight:500;text-transform:uppercase">P&amp;L</th>
        </tr>
      </thead>
      <tbody>${sessionRows}</tbody>
    </table>
  </div>` : ""}

  <a href="${appUrl}/dashboard" style="display:block;text-align:center;background:#00D4A4;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin-top:8px">View Full Dashboard →</a>

  <div class="footer">
    TradeUpdate • Professional V75 Trading<br>
    You're receiving this because daily summaries are enabled. <a href="${appUrl}/dashboard" style="color:#4A5060">Manage in Settings</a>
  </div>
</div>
</body></html>`,
  });
}

export async function sendRejectedEmail(to: string, username: string) {
  await sendEmail({
    to,
    subject: "TradeUpdate access request update",
    html: `<!DOCTYPE html><html>${dark}<body><div class="card">
      <div class="logo">TradeUpdate</div>
      <div class="body">
        <p>Hi <strong>${username}</strong>,</p>
        <p>Thank you for your interest in TradeUpdate. After review, we're unable to approve your access request at this time.</p>
        <p>If you believe this is an error or would like to reapply in the future, please contact us.</p>
        <p>— The TradeUpdate Team</p>
      </div>
      <div class="footer">TradeUpdate • Professional V75 Trading</div>
    </div></body></html>`,
  });
}
