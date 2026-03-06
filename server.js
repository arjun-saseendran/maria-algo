import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import mongoose from "mongoose";

// ─── Config & Routes ──────────────────────────────────────────────────────────
import { connectDatabases } from "./config/db.js";
import authRoutes     from "./routes/authRoutes.js";
import tradeRoutes    from "./routes/ironCondorTradeRoutes.js";
import optionsRoutes  from "./routes/optionChainRoutes.js";
import positionRoutes from "./routes/ironCondorPositionRoutes.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import getActiveTradeModel from "./models/ironCondorActiveTradeModel.js";
import TradePerformance    from "./models/trafficTradePerformanceModel.js";
import { DailyStatus }     from "./models/traficLightDailyStatusModel.js";

// ─── Services & Strategy ──────────────────────────────────────────────────────
import { resetDailyState, tradeState }     from "./state/traficLightTradeState.js";
import { scanAndSyncOrders, condorPrices } from "./Engines/ironCondorEngine.js";
import { setIO as setTrafficIO }           from "./Engines/traficLightEngine.js";
import { loadTokenFromDisk }               from "./config/kiteConfig.js";
import { setUpstoxAccessToken }            from "./config/upstoxConfig.js";
import { sendTelegramAlert }               from "./services/telegramService.js";
import { initFyersLiveData }               from "./services/fyersLiveData.js";
import { kiteToFyersSymbol }               from "./services/fyersSymbolMapper.js";

const app    = express();
const server = http.createServer(app);
let lastTLLTP = 0;

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ["https://mariaalgo.online", "http://localhost:3000", "http://localhost:5173"],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });
app.set("io", io);
setTrafficIO(io);

io.on("connection", (socket) => {
  socket.on("market_tick", (data) => { if (data?.price) lastTLLTP = data.price; });
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/trades",    tradeRoutes);
app.use("/api/options",   optionsRoutes);
app.use("/api/positions", positionRoutes);

// 1. Iron Condor Live Positions
app.get("/api/condor/positions", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const { getCondorTradePerformanceModel } = await import('./models/condorTradePerformanceModel.js');
    const CondorPerf  = getCondorTradePerformanceModel();

    const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });

    if (!activeTrade) {
      const lastTrade = await ActiveTrade.findOne({ status: "COMPLETED" }).sort({ updatedAt: -1 });
      if (!lastTrade) return res.json([]);
      const lastPerf = await CondorPerf.findOne({ activeTradeId: lastTrade._id });
      return res.json([{
        status:     "COMPLETED",
        index:      lastTrade.index,
        totalPnL:   lastPerf?.realizedPnL?.toFixed(2) || "0.00",
        exitReason: lastPerf?.exitReason || "COMPLETED",
        quantity:   lastTrade.lotSize,
        call: { entry: lastTrade.callSpreadEntryPremium?.toFixed(2) || "0.00", current: "0.00", sl: "0.00", firefight: "0.00", profit70: "0.00" },
        put:  { entry: lastTrade.putSpreadEntryPremium?.toFixed(2)  || "0.00", current: "0.00", sl: "0.00", firefight: "0.00", profit70: "0.00" }
      }]);
    }

    const idx = activeTrade.index;
    const getLtp = (sym) => sym ? (condorPrices[kiteToFyersSymbol(sym, idx)] || 0) : 0;

    const currentCallNet = activeTrade.symbols.callSell
      ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy)) : 0;
    const currentPutNet = activeTrade.symbols.putSell
      ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy)) : 0;

    const totalPnL = ((activeTrade.callSpreadEntryPremium - currentCallNet) +
                      (activeTrade.putSpreadEntryPremium  - currentPutNet)) * activeTrade.lotSize;

    res.json([{
      index:    activeTrade.index,
      totalPnL: totalPnL.toFixed(2),
      quantity: activeTrade.lotSize,
      call: {
        entry:     activeTrade.callSpreadEntryPremium.toFixed(2),
        current:   currentCallNet.toFixed(2),
        sl:        (activeTrade.callSpreadEntryPremium * 4).toFixed(2),
        firefight: (activeTrade.callSpreadEntryPremium * 3).toFixed(2),
        profit70:  (activeTrade.callSpreadEntryPremium * 0.3).toFixed(2)
      },
      put: {
        entry:     activeTrade.putSpreadEntryPremium.toFixed(2),
        current:   currentPutNet.toFixed(2),
        sl:        (activeTrade.putSpreadEntryPremium * 4).toFixed(2),
        firefight: (activeTrade.putSpreadEntryPremium * 3).toFixed(2),
        profit70:  (activeTrade.putSpreadEntryPremium * 0.3).toFixed(2)
      }
    }]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Traffic Light Status
app.get("/api/traffic/status", (req, res) => {
  let livePnL = 0;
  if (tradeState?.tradeActive && tradeState?.entryPrice && lastTLLTP > 0) {
    const points = tradeState.direction === "CE"
      ? lastTLLTP - tradeState.entryPrice
      : tradeState.entryPrice - lastTLLTP;
    livePnL = points * 65;
  }
  res.json({
    signal:         tradeState?.tradeActive ? "ACTIVE" : tradeState?.tradeTakenToday ? "CLOSED" : "WAITING",
    direction:      tradeState?.direction  || null,
    entryPrice:     tradeState?.entryPrice || 0,
    livePnL:        livePnL.toFixed(2),
    stopLoss:       tradeState?.trailingActive
                      ? (tradeState?.trailSL?.toFixed(2)       || "0.00")
                      : tradeState?.direction === "CE"
                        ? (tradeState?.breakoutLow?.toFixed(2)  || "0.00")
                        : (tradeState?.breakoutHigh?.toFixed(2) || "0.00"),
    trailingActive: tradeState?.trailingActive || false,
    breakoutHigh:   tradeState?.breakoutHigh   || 0,
    breakoutLow:    tradeState?.breakoutLow    || 0,
  });
});

// 3. Combined Trade History
app.get("/api/history", async (req, res) => {
  try {
    const history = await TradePerformance.find()
      .sort({ createdAt: -1 })
      .limit(20);

    const combined = history.map((h) => ({
      symbol:     h.index || h.symbol,
      exitReason: h.exitReason,
      pnl:        h.realizedPnL ?? h.pnl,
      strategy:   h.strategy || "TRAFFIC_LIGHT",
      createdAt:  h.createdAt,
    }));

    res.json(combined);
  } catch (err) {
    console.error("❌ /api/history error:", err.message);
    res.status(500).json({ error: "History fetch failed" });
  }
});

app.get("/status", (req, res) => res.json({ status: "Online", timestamp: new Date() }));

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────

// Catches async errors that were thrown but never caught (e.g. in a promise chain)
process.on("unhandledRejection", async (reason, promise) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error("❌ Unhandled Rejection:", msg);
  try {
    await sendTelegramAlert(
      `🚨 <b>Unhandled Rejection</b>\n` +
      `<code>${msg.slice(0, 800)}</code>\n` +
      `⚠️ Server is still running but check immediately.`
    );
  } catch (_) {}
});

// Catches synchronous exceptions that were never caught (e.g. null deref at top level)
process.on("uncaughtException", async (err) => {
  const msg = err.stack || err.message;
  console.error("💥 Uncaught Exception:", msg);
  try {
    await sendTelegramAlert(
      `💥 <b>Uncaught Exception — Server Crashing!</b>\n` +
      `<code>${msg.slice(0, 800)}</code>\n` +
      `🔴 Restart required. Check open positions immediately!`
    );
  } catch (_) {}
  // Give Telegram time to send before Node exits
  setTimeout(() => process.exit(1), 3000);
});

// Fires when the process is killed (e.g. systemctl stop, PM2 restart, Ctrl+C)
process.on("SIGTERM", async () => {
  console.warn("⚠️ SIGTERM received — shutting down gracefully.");
  try {
    await sendTelegramAlert(
      `⚠️ <b>Maria Algo — SIGTERM Received</b>\n` +
      `Server is shutting down.\n` +
      `${ tradeState?.tradeActive ? "🔴 <b>Active trade open! Check positions immediately.</b>" : "✅ No active trade." }`
    );
  } catch (_) {}
  server.close(() => process.exit(0));
});

// Fires on Ctrl+C in terminal
process.on("SIGINT", async () => {
  console.warn("⚠️ SIGINT received — shutting down.");
  try {
    await sendTelegramAlert(
      `⚠️ <b>Maria Algo — Manual Stop (SIGINT)</b>\n` +
      `${ tradeState?.tradeActive ? "🔴 <b>Active trade open! Check positions immediately.</b>" : "✅ No active trade." }`
    );
  } catch (_) {}
  server.close(() => process.exit(0));
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDatabases();

    await loadTokenFromDisk();
    if (process.env.UPSTOX_ACCESS_TOKEN) {
      setUpstoxAccessToken(process.env.UPSTOX_ACCESS_TOKEN);
      console.log("✅ Upstox token loaded");
    }

    // Restore Traffic Light daily state
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const dailyRecord = await DailyStatus.findOne({ date: today });
    if (dailyRecord) {
      tradeState.tradeTakenToday = dailyRecord.tradeTakenToday || false;
      tradeState.breakoutHigh    = dailyRecord.breakoutHigh;
      tradeState.breakoutLow     = dailyRecord.breakoutLow;
    }

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, async () => {
      console.log(`🚀 Maria Algo Server Online · port ${PORT}`);
      await sendTelegramAlert("🤖 <b>Maria Algo Online! ✅</b>");
      if (process.env.FYERS_ACCESS_TOKEN) await initFyersLiveData(io);
      setInterval(async () => { try { await scanAndSyncOrders(); } catch (err) {} }, 60000);
    });

  } catch (err) {
    // Startup failure — notify before dying
    console.error("💥 Fatal startup error:", err);
    try {
      await sendTelegramAlert(
        `💥 <b>Maria Algo — Startup Failed!</b>\n` +
        `<code>${(err.stack || err.message).slice(0, 800)}</code>\n` +
        `🔴 Server did NOT start. Manual intervention required.`
      );
    } catch (_) {}
    process.exit(1);
  }
};

// ─── CRON ─────────────────────────────────────────────────────────────────────
// Reset Traffic Light state at 9:00 AM IST on weekdays
cron.schedule("0 9 * * 1-5", () => resetDailyState(), { timezone: "Asia/Kolkata" });

start();