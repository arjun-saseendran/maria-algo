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
import tradeRoutes    from "./routes/tradeRoutes.js";
import optionsRoutes  from "./routes/optionsRoutes.js";
import positionRoutes from "./routes/positionRoutes.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import { DailyStatus }          from "./models/dailyStatusModel.js";
import TrafficTradePerformance  from "./models/trafficTradePerformanceModel.js";
import ActiveTrade              from "./models/activeTradeModel.js";

// ─── Services ─────────────────────────────────────────────────────────────────
import { resetDailyState, tradeState } from "./state/tradeState.js";
import { scanAndSyncOrders } from "./services/orderMonitorService.js";
import { loadTokenFromDisk, getKiteInstance } from "./services/kiteService.js";
import { sendTelegramAlert } from "./services/telegramService.js";
import { initMasterDataFeed, lastPrices }  from "./services/masterDataFeed.js";
import { kiteToFyersSymbol } from "./services/symbolMapper.js";

const app    = express();
const server = http.createServer(app);
let lastTLLTP = 0; 

// ─── CORS Fix ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ["https://mariaalgo.online", "http://localhost:3000", "http://localhost:5173"],
  credentials: true
}));
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });
app.set("io", io); 

io.on("connection", (socket) => {
  socket.on("market_tick", (data) => { if (data?.price) lastTLLTP = data.price; });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/options", optionsRoutes);
app.use("/api/positions", positionRoutes);

// 1. Dashboard: Iron Condor Live Positions
app.get("/api/condor/positions", async (req, res) => {
  try {
    const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!activeTrade) return res.json([]);
    const idx = activeTrade.index;
    const getLtp = (sym) => sym ? lastPrices[kiteToFyersSymbol(sym, idx)] || 0 : 0;
    const currentCallNet = activeTrade.symbols.callSell ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy)) : 0;
    const currentPutNet = activeTrade.symbols.putSell ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy)) : 0;
    const totalPnL = ((activeTrade.callSpreadEntryPremium - currentCallNet) + (activeTrade.putSpreadEntryPremium - currentPutNet)) * activeTrade.quantity;

    res.json([{
      index: activeTrade.index,
      totalPnL: totalPnL.toFixed(2),
      quantity: activeTrade.quantity,
      call: { entry: activeTrade.callSpreadEntryPremium.toFixed(2), current: currentCallNet.toFixed(2), sl: (activeTrade.callSpreadEntryPremium * 4).toFixed(2), profit70: (activeTrade.callSpreadEntryPremium * 0.3).toFixed(2) },
      put: { entry: activeTrade.putSpreadEntryPremium.toFixed(2), current: currentPutNet.toFixed(2), sl: (activeTrade.putSpreadEntryPremium * 4).toFixed(2), profit70: (activeTrade.putSpreadEntryPremium * 0.3).toFixed(2) }
    }]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Multi-Leg strategy execution
app.post("/api/trades/execute-basket", async (req, res) => {
  try {
    const { symbol, legs } = req.body;
    const kite = getKiteInstance();
    const results = await Promise.all(legs.map(leg => {
      return kite.placeOrder("regular", {
        exchange: symbol === "SENSEX" ? "BFO" : "NFO",
        tradingsymbol: `${symbol}26MAR${leg.strike}${leg.optionType}`,
        transaction_type: leg.type === "BUY" ? kite.TRANSACTION_TYPE_BUY : kite.TRANSACTION_TYPE_SELL,
        quantity: leg.qty,
        order_type: kite.ORDER_TYPE_MARKET,
        product: kite.PRODUCT_MIS
      });
    }));
    res.json({ orderIds: results.map(r => r.order_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Traffic Light dashboard status
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

// 4. Combined history (FIXED: defined model outside to prevent crash)
let CondorPerfModel; 
app.get("/api/history", async (req, res) => {
  try {
    const trafficHistory = await TrafficTradePerformance.find().sort({ createdAt: -1 }).limit(10);
    if (!CondorPerfModel) {
      const condorConn = getCondorDB();
      CondorPerfModel = condorConn.model("CondorTradePerformance", new mongoose.Schema({}, { strict: false, collection: 'condortradeperformances' }));
    }
    const condorHistory = await CondorPerfModel.find().sort({ createdAt: -1 }).limit(10);
    const combined = [...trafficHistory, ...condorHistory].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10).map((h) => ({
        symbol: h.index || h.symbol, exitReason: h.exitReason, pnl: h.realizedPnL || h.pnl,
        strategy: h.notes?.includes("Iron Condor") || h.callSpreadEntryPremium ? "IRON_CONDOR" : "TRAFFIC_LIGHT",
      }));
    res.json(combined);
  } catch (err) { res.status(500).json({ error: "History sync failed" }); }
});

const start = async () => {
  try {
    await connectDatabases();
    await loadTokenFromDisk(); 
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, async () => {
      console.log(`🚀 Maria Algo Server Online · port ${PORT}`);
      if (process.env.FYERS_ACCESS_TOKEN) await initMasterDataFeed(io);
      setInterval(async () => { try { await scanAndSyncOrders(); } catch (err) {} }, 60000);
    });
  } catch (err) { process.exit(1); }
};

start();