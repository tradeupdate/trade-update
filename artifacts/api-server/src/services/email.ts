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
