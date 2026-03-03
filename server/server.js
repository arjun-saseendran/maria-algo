import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import mongoose from "mongoose";

// ─── Config ───────────────────────────────────────────────────────────────────
import { connectDatabases, getCondorDB } from "./config/db.js";

// ─── Routes ───────────────────────────────────────────────────────────────────
import authRoutes     from "./routes/authRoutes.js";
import tradeRoutes    from "./routes/tradeRoutes.js";
import optionsRoutes  from "./routes/optionsRoutes.js";
import positionRoutes from "./routes/positionRoutes.js";

// ─── Traffic Light: State / Strategy ──────────────────────────────────────────
import { DailyStatus }          from "./models/dailyStatusModel.js";
import TrafficTradePerformance  from "./models/trafficTradePerformanceModel.js";
import { resetDailyState, tradeState } from "./state/tradeState.js";

// ─── Shared & Iron Condor Services ────────────────────────────────────────────
import { scanAndSyncOrders } from "./services/orderMonitorService.js";
import { loadTokenFromDisk } from "./services/kiteService.js";
import { sendTelegramAlert } from "./services/telegramService.js";
import { initMasterDataFeed }  from "./services/masterDataFeed.js";

// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
let lastTLLTP = 0; 

// ─── IST date helper ─────────────────────────────────────────────────────────
const getISTDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

// ─── CORS ─────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: ["https://mariaalgo.online", "http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept", "Origin"],
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: "*" } });
app.set("io", io); 

io.on("connection", (socket) => {
  console.log(`🔌 UI connected: ${socket.id}`);
  socket.on("market_tick", (data) => {
    if (data?.price) lastTLLTP = data.price;
  });
  socket.on("disconnect", () =>
    console.log(`🔌 UI disconnected: ${socket.id}`)
  );
});

// ─── Auth routes (Fyers + Zerodha) ───────────────────────────────────────────
app.use("/api/auth", authRoutes);

// ─── Iron Condor routes ───────────────────────────────────────────────────────
app.use("/api/trades",    tradeRoutes);
app.use("/api/options",   optionsRoutes);
app.use("/api/positions", positionRoutes);

// ─── Traffic Light: dashboard status ─────────────────────────────────────────
app.get("/api/traffic/status", (req, res) => {
  try {
    let livePnL = 0;
    if (tradeState?.tradeActive && tradeState?.entryPrice && lastTLLTP > 0) {
      const points =
        tradeState.direction === "CE"
          ? lastTLLTP - tradeState.entryPrice
          : tradeState.entryPrice - lastTLLTP;
      livePnL = points * 65;
    }
    res.json({
      signal: tradeState?.tradeActive
        ? "ACTIVE"
        : tradeState?.tradeTakenToday ? "CLOSED" : "WAITING",
      direction:    tradeState?.direction || "NONE",
      optionSymbol: tradeState?.optionSymbol || "---",
      entryPrice:   tradeState?.entryPrice?.toFixed(2) || "0.00",
      livePnL:      livePnL.toFixed(2),
      trailingActive: tradeState?.trailingActive || false,
      trailSL:      tradeState?.trailSL?.toFixed(2) || "---",
      exitReason:   tradeState?.exitReason || "---",
      breakoutHigh: tradeState?.breakoutHigh || 0,
      breakoutLow:  tradeState?.breakoutLow || 0,
      lastUpdated:  new Date(),
    });
  } catch {
    res.status(500).json({ error: "Dashboard sync error" });
  }
});

// ─── Iron Condor: health check ────────────────────────────────────────────────
app.get("/status", (req, res) =>
  res.json({ status: "Online", timestamp: new Date() })
);

// ─── Combined history from both DBs ──────────────────────────────────────────
app.get("/api/history", async (req, res) => {
  try {
    const trafficHistory = await TrafficTradePerformance.find()
      .sort({ createdAt: -1 }).limit(10);

    const condorConn = getCondorDB();
    
    // 🚨 FIXED BUG: Now strictly pointing to CondorTradePerformance
    const CondorPerf = condorConn.model(
      "CondorTradePerformance",
      new mongoose.Schema({}, { strict: false, collection: 'condortradeperformances' })
    );
    
    const condorHistory = await CondorPerf.find()
      .sort({ createdAt: -1 }).limit(10);

    const combined = [...trafficHistory, ...condorHistory]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map((h) => ({
        symbol:   h.index || h.symbol, // Handle both DB structures
        exitReason: h.exitReason,
        pnl:      h.realizedPnL || h.pnl, // Handle both DB structures
        strategy: h.notes?.includes("Iron Condor") || h.callSpreadEntryPremium ? "IRON_CONDOR" : "TRAFFIC_LIGHT",
      }));

    res.json(combined);
  } catch (err) {
    console.error("❌ History Error:", err.message);
    res.status(500).json({ error: "Could not fetch history" });
  }
});

// ─── CRON: Reset Traffic Light state at 9:00 AM on weekdays ──────────────────
cron.schedule("0 9 * * 1-5", () => resetDailyState(), {
  timezone: "Asia/Kolkata",
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDatabases();
    await loadTokenFromDisk();

    const dateKey = getISTDate();
    const dailyRecord = await DailyStatus.findOne({ date: dateKey });
    if (dailyRecord) {
      tradeState.tradeTakenToday = dailyRecord.tradeTakenToday || false;
      tradeState.breakoutHigh   = dailyRecord.breakoutHigh;
      tradeState.breakoutLow    = dailyRecord.breakoutLow;
    }

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, async () => {
      console.log(`\n🚀 Maria Algo Server  ·  port ${PORT}`);
      console.log(`   🚦 Traffic Light Strategy — READY`);
      console.log(`   🦅 Iron Condor Strategy   — READY\n`);

      await sendTelegramAlert(
        "🤖 <b>Maria Algo Server Online!</b>\n" +
        "🚦 Traffic Light  +  🦅 Iron Condor\n" +
        "Master Data Feed initialized."
      );

      if (process.env.FYERS_ACCESS_TOKEN) {
        console.log("📡 Fyers token found — starting Master Data Feed...");
        
        await initMasterDataFeed(io);
        
      } else {
        console.warn(
          "⚠️  FYERS_ACCESS_TOKEN not set.\n" +
          "   Run: node autoLogin.js  then restart the server."
        );
      }

      setInterval(async () => {
        try { await scanAndSyncOrders(); }
        catch (err) { console.error("❌ Order Sync Error:", err.message); }
      }, 60000);
    });

  } catch (err) {
    console.error("❌ Fatal Startup Error:", err.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => {
  console.log("🛑 Shutting down...");
  server.close(() => process.exit(0));
});

start();