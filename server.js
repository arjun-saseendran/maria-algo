import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import mongoose from "mongoose";

// ─── Config & Routes ──────────────────────────────────────────────────────────
import { connectDatabases, getCondorDB } from "./config/db.js";
import authRoutes     from "./routes/authRoutes.js";
import tradeRoutes    from "./routes/ironCondorTradeRoutes.js";
import optionsRoutes  from "./routes/optionChainRoutes.js";
import positionRoutes from "./routes/ironCondorPositionRoutes.js";

// ─── SAFE MODEL LOADING ───────────────────────────────────────────────────────
import ActiveTrade              from "./models/ironCondorActiveTradeModel.js";
import TradePerformance         from "./models/trafficTradePerformanceModel.js";
import { DailyStatus }          from "./models/traficLightDailyStatusModel.js";

// ─── Services & Strategy ──────────────────────────────────────────────────────
import { resetDailyState, tradeState } from "./state/traficLightTradeState.js";
// 🚨 FIXED: Import condorPrices cache directly from the Engine
import { scanAndSyncOrders, condorPrices } from "./Engines/ironCondorEngine.js";
import { loadTokenFromDisk, getKiteInstance } from "./config/kiteConfig.js";
import { sendTelegramAlert } from "./services/telegramService.js";
// 🚨 FIXED: Use the correct named export 'initFyersLiveData'
import { initFyersLiveData } from "./services/fyersLiveData.js";
import { kiteToFyersSymbol } from "./services/symbolMapper.js";

const app    = express();
const server = http.createServer(app);
let lastTLLTP = 0; 

// ─── PRODUCTION CORS ──────────────────────────────────────────────────────────
app.use(cors({
  origin: ["https://mariaalgo.online", "http://localhost:3000", "http://localhost:5173"],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });
app.set("io", io); 

io.on("connection", (socket) => {
  socket.on("market_tick", (data) => { if (data?.price) lastTLLTP = data.price; });
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/trades",    tradeRoutes);
app.use("/api/options",   optionsRoutes);
app.use("/api/positions", positionRoutes);

// 1. Dashboard: Iron Condor Live Positions
app.get("/api/condor/positions", async (req, res) => {
  try {
    const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!activeTrade) return res.json([]);
    
    const idx = activeTrade.index;
    // 🚨 FIXED: Reference 'condorPrices' cache for real-time spread valuation
    const getLtp = (sym) => sym ? (condorPrices[kiteToFyersSymbol(sym, idx)] || 0) : 0;

    const currentCallNet = activeTrade.symbols.callSell 
        ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy)) : 0;
    const currentPutNet = activeTrade.symbols.putSell 
        ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy)) : 0;

    const totalPnL = ((activeTrade.callSpreadEntryPremium - currentCallNet) + 
                      (activeTrade.putSpreadEntryPremium - currentPutNet)) * activeTrade.lotSize;

    res.json([{
      index: activeTrade.index,
      totalPnL: totalPnL.toFixed(2),
      quantity: activeTrade.lotSize,
      call: { entry: activeTrade.callSpreadEntryPremium.toFixed(2), current: currentCallNet.toFixed(2), sl: (activeTrade.callSpreadEntryPremium * 4).toFixed(2), profit70: (activeTrade.callSpreadEntryPremium * 0.3).toFixed(2) },
      put: { entry: activeTrade.putSpreadEntryPremium.toFixed(2), current: currentPutNet.toFixed(2), sl: (activeTrade.putSpreadEntryPremium * 4).toFixed(2), profit70: (activeTrade.putSpreadEntryPremium * 0.3).toFixed(2) }
    }]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Traffic Light: Status
app.get("/api/traffic/status", (req, res) => {
  let livePnL = 0;
  if (tradeState?.tradeActive && tradeState?.entryPrice && lastTLLTP > 0) {
    const points = tradeState.direction === "CE" ? lastTLLTP - tradeState.entryPrice : tradeState.entryPrice - lastTLLTP;
    livePnL = points * 65;
  }
  res.json({
    signal: tradeState?.tradeActive ? "ACTIVE" : tradeState?.tradeTakenToday ? "CLOSED" : "WAITING",
    entryPrice: tradeState?.entryPrice?.toFixed(2) || "0.00",
    livePnL: livePnL.toFixed(2),
    breakoutHigh: tradeState?.breakoutHigh || 0,
    breakoutLow:  tradeState?.breakoutLow || 0,
  });
});

// 3. Combined History (SAFE)
app.get("/api/history", async (req, res) => {
  try {
    const trafficHistory = await TradePerformance.find().sort({ createdAt: -1 }).limit(10);
    const condorConn = getCondorDB();
    
    // Safety check for dynamic connection model
    const CondorPerf = condorConn.models.CondorTradePerformance || 
      condorConn.model("CondorTradePerformance", new mongoose.Schema({}, { strict: false, collection: 'condortradeperformances' }));

    const condorHistory = await CondorPerf.find().sort({ createdAt: -1 }).limit(10);
    const combined = [...trafficHistory, ...condorHistory].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10).map((h) => ({
        symbol: h.index || h.symbol, exitReason: h.exitReason, pnl: h.realizedPnL || h.pnl,
        strategy: h.notes?.includes("Iron Condor") || h.callSpreadEntryPremium ? "IRON_CONDOR" : "TRAFFIC_LIGHT",
      }));
    res.json(combined);
  } catch (err) { res.status(500).json({ error: "History sync failed" }); }
});

app.get("/status", (req, res) => res.json({ status: "Online", timestamp: new Date() }));

// ─── STARTUP ──────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDatabases();
    await loadTokenFromDisk(); 

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const dailyRecord = await DailyStatus.findOne({ date: today });
    if (dailyRecord) {
      tradeState.tradeTakenToday = dailyRecord.tradeTakenToday || false;
      tradeState.breakoutHigh = dailyRecord.breakoutHigh;
      tradeState.breakoutLow = dailyRecord.breakoutLow;
    }

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, async () => {
      console.log(`🚀 Maria Algo Server Online · port ${PORT}`);
      await sendTelegramAlert("🤖 <b>Maria Algo Online</b>");
      // 🚨 FIXED: Call the correct named function for Fyers Live Data
      if (process.env.FYERS_ACCESS_TOKEN) await initFyersLiveData(io);
      setInterval(async () => { try { await scanAndSyncOrders(); } catch (err) {} }, 60000);
    });
  } catch (err) { console.error("Fatal:", err); process.exit(1); }
};

cron.schedule("0 9 * * 1-5", () => resetDailyState(), { timezone: "Asia/Kolkata" });
start();