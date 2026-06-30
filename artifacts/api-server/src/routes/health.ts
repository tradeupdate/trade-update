import { Router, type IRouter } from "express";
import { botManager } from "../services/bot.js";
import { derivService } from "../services/deriv.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

let lastKeepAlivePing = 0;

export function recordKeepAlivePing() {
  lastKeepAlivePing = Date.now();
}

export function getLastKeepAlivePing() {
  return lastKeepAlivePing;
}

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
    uptime: process.uptime(),
    botsRunning: botManager.countRunning(),
    derivConnected: derivService.isConnected(),
    version: "1.0.0",
  });
});

export default router;
