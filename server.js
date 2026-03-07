import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";

// ─── Config & Routes ──────────────────────────────────────────────────────────
import { connectDatabases }  from "./config/db.js";
import authRoutes            from "./routes/authRoutes.js";
import tradeRoutes           from "./routes/ironCondorTradeRoutes.js";
import autoCondorRoutes      from "./routes/autoCondorRoutes.js";
import optionsRoutes         from "./routes/optionChainRoutes.js";
import positionRoutes        from "./routes/ironCondorPositionRoutes.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import getActiveTradeModel   from "./models/ironCondorActiveTradeModel.js";
import TradePerformance      from "./models/trafficTradePerformanceModel.js";
import { DailyStatus }       from "./models/traficLightDailyStatusModel.js";

// ─── Services & Strategy ──────────────────────────────────────────────────────
import { resetDailyState, tradeState }     from "./state/traficLightTradeState.js";
import { scanAndSyncOrders, condorPrices } from "./Engines/ironCondorEngine.js";
import { resetAutoCondorDay }              from "./Engines/autoCondorEngine.js";
import { setIO as setTrafficIO }           from "./Engines/traficLightEngine.js";
import { loadTokenFromDisk }               from "./config/kiteConfig.js";
import { setUpstoxAccessToken }            from "./config/upstoxConfig.js";
import { sendTelegramAlert }               from "./services/telegramService.js";

// ─── Live Data ────────────────────────────────────────────────────────────────
import { initFyersLiveData }                         from "./services/fyersLiveData.js";
import { initUpstoxLiveData, subscribeCondorSymbol } from "./services/upstoxLiveData.js";
// ✅ FIX: import subscribeCondorSymbol so new IC legs get subscribed after position sync

// ─── Symbol mapper ────────────────────────────────────────────────────────────
import { kiteToUpstoxSymbol } from "./services/upstoxSymbolMapper.js";

// ✅ FIX: import setIO from socket.js so getIO() works in all engines.
// server.js creates its own `io = new Server(...)` but never called initSocket(),
// so socket.js `io` var was never set — getIO() returned null everywhere,
// meaning no events were ever emitted to the dashboard.
import { setIO as setSocketIO } from "./config/socket.js";

// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
let lastTLLTP = 0;

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         ["https://mariaalgo.online", "http://localhost:3000", "http://localhost:5173"],
  credentials:    true,
  methods:        ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      ["https://mariaalgo.online", "http://localhost:3000", "http://localhost:5173"],
    methods:     ["GET", "POST"],
    credentials: true,
  },
});

// ✅ FIX: register io into socket.js shared module — must happen before live data inits
// so getIO() returns the correct instance in ironCondorEngine, autoCondorEngine, upstoxLiveData
setSocketIO(io);
setTrafficIO(io);

io.on("connection", (socket) => {
  socket.on("market_tick", (data) => { if (data?.price) lastTLLTP = data.price; });
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use("/api/auth",         authRoutes);
app.use("/api/trades",       tradeRoutes);
app.use("/api/options",      optionsRoutes);
app.use("/api/positions",    positionRoutes);
app.use("/api/auto-condor",  autoCondorRoutes);

// ── 1. Iron Condor Live Positions ─────────────────────────────────────────────
app.get("/api/condor/positions", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const { getCondorTradePerformanceModel } = await import("./models/condorTradePerformanceModel.js");
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
        call: {
          entry:          lastTrade.callSpreadEntryPremium?.toFixed(2) || "0.00",
          current:        "0.00",
          sl:             "0.00",
          firefightLevel: "0.00",
        },
        put: {
          entry:          lastTrade.putSpreadEntryPremium?.toFixed(2) || "0.00",
          current:        "0.00",
          sl:             "0.00",
          firefightLevel: "0.00",
        },
      }]);
    }

    const idx = activeTrade.index;
    const getLtp = (sym) => sym ? (condorPrices[kiteToUpstoxSymbol(sym, idx)] || 0) : 0;

    const currentCallNet = activeTrade.symbols.callSell
      ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy))
      : 0;
    const currentPutNet = activeTrade.symbols.putSell
      ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy))
      : 0;

    const totalPnL =
      ((activeTrade.callSpreadEntryPremium - currentCallNet) +
       (activeTrade.putSpreadEntryPremium  - currentPutNet)) * activeTrade.lotSize;

    const buffer = activeTrade.bufferPremium || 0;

    // ✅ FIX: SL must match engine formula: min((entry × 4) + buffer, spreadDist/2)
    // Was: entry × 4  — missing buffer addend and the spread/2 hard cap
    const spreadDist  = idx === 'SENSEX'
      ? parseInt(process.env.SENSEX_SPREAD_DISTANCE || '500')
      : parseInt(process.env.NIFTY_SPREAD_DISTANCE  || '150');
    const maxSpreadSL = spreadDist / 2;
    const callSL      = Math.min((activeTrade.callSpreadEntryPremium * 4) + buffer, maxSpreadSL);
    const putSL       = Math.min((activeTrade.putSpreadEntryPremium  * 4) + buffer, maxSpreadSL);

    // ✅ FIX: firefightLevel = entry × 0.30
    // Was two separate fields: `firefight` (entry × 3 — completely wrong value,
    // that's the auto-engine's losing-side threshold) and `profit70` (entry × 0.30).
    // The dashboard banner fires when net premium decays TO this level (30% of entry).
    const callFirefightLevel = activeTrade.callSpreadEntryPremium * 0.30;
    const putFirefightLevel  = activeTrade.putSpreadEntryPremium  * 0.30;

    res.json([{
      index:         activeTrade.index,
      totalPnL:      totalPnL.toFixed(2),
      quantity:      activeTrade.lotSize,
      bufferPremium: buffer.toFixed(2),
      isButterfly:   activeTrade.isIronButterfly || false,
      spreadSLCount: activeTrade.spreadSLCount   || 0,
      circleNumber:  activeTrade.circleNumber    || 1,
      butterflySL:   ((activeTrade.totalEntryPremium * 3) + buffer).toFixed(2),
      call: {
        entry:          activeTrade.callSpreadEntryPremium.toFixed(2),
        current:        currentCallNet.toFixed(2),
        sl:             callSL.toFixed(2),
        firefightLevel: callFirefightLevel.toFixed(2),
      },
      put: {
        entry:          activeTrade.putSpreadEntryPremium.toFixed(2),
        current:        currentPutNet.toFixed(2),
        sl:             putSL.toFixed(2),
        firefightLevel: putFirefightLevel.toFixed(2),
      },
    }]);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 2. Traffic Light Status ───────────────────────────────────────────────────
app.get("/api/traffic/status", (req, res) => {
  let livePnL = 0;
  if (tradeState?.tradeActive && tradeState?.entryPrice && lastTLLTP > 0) {
    const points = tradeState.direction === "CE"
      ? lastTLLTP - tradeState.entryPrice
      : tradeState.entryPrice - lastTLLTP;
    livePnL = points * 65;
  }
  res.json({
    signal:         tradeState?.tradeActive    ? "ACTIVE"
                  : tradeState?.tradeTakenToday ? "CLOSED"
                  : "WAITING",
    direction:      tradeState?.direction      || null,
    entryPrice:     tradeState?.entryPrice     || 0,
    livePnL:        livePnL.toFixed(2),
    stopLoss:       tradeState?.trailingActive
                      ? (tradeState?.trailSL?.toFixed(2)       || "0.00")
                      : tradeState?.direction === "CE"
                        ? (tradeState?.breakoutLow?.toFixed(2)  || "0.00")
                        : (tradeState?.breakoutHigh?.toFixed(2) || "0.00"),
    trailingActive: tradeState?.trailingActive || false,
    breakoutHigh:   tradeState?.breakoutHigh   || 0,
    breakoutLow:    tradeState?.breakoutLow    || 0,
    // ✅ FIX: exitReason added — was missing from response, always appeared null on dashboard
    exitReason:     tradeState?.exitReason     || null,
  });
});

// ── 3. Combined Trade History ─────────────────────────────────────────────────
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
      notes:      h.notes,
      createdAt:  h.createdAt,
    }));

    res.json(combined);
  } catch (err) {
    console.error("❌ /api/history error:", err.message);
    res.status(500).json({ error: "History fetch failed" });
  }
});

app.get("/status", (req, res) =>
  res.json({ status: "Online", timestamp: new Date() })
);

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
process.on("uncaughtException", async (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  try { await sendTelegramAlert(`💥 <b>Server Crash: Uncaught Exception</b>\n<code>${err.message}</code>`); } catch (_) {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("💥 Unhandled Rejection:", msg);
  try { await sendTelegramAlert(`⚠️ <b>Unhandled Rejection</b>\n<code>${msg}</code>`); } catch (_) {}
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

      if (process.env.FYERS_ACCESS_TOKEN) {
        await initFyersLiveData();
        console.log("✅ Fyers live data started (Traffic Light)");
      } else {
        console.warn("⚠️ FYERS_ACCESS_TOKEN missing — Traffic Light will not receive live data");
      }

      if (process.env.UPSTOX_ACCESS_TOKEN) {
        await initUpstoxLiveData();
        console.log("✅ Upstox live data started (Iron Condor)");
      } else {
        console.warn("⚠️ UPSTOX_ACCESS_TOKEN missing — Iron Condor will not receive live data");
      }

      // ✅ FIX: after scanAndSyncOrders creates a new ActiveTrade, subscribe its
      // option leg symbols to the Upstox feed. Without this, new legs detected by
      // the position sync are never added to the WS subscription — condorPrices
      // never receives ticks for them and SL monitoring stays blind.
      setInterval(async () => {
        try {
          await scanAndSyncOrders();

          const ActiveTrade = getActiveTradeModel();
          const active = await ActiveTrade.findOne({ status: 'ACTIVE' });
          if (active) {
            const idx = active.index;
            [active.symbols.callSell, active.symbols.callBuy,
             active.symbols.putSell,  active.symbols.putBuy]
              .filter(Boolean)
              .forEach(kite => subscribeCondorSymbol(kiteToUpstoxSymbol(kite, idx)));
          }
        } catch (err) {
          console.error("❌ scanAndSyncOrders error:", err.message);
        }
      }, 60000);
    });

  } catch (err) {
    console.error("💥 Fatal startup error:", err);
    process.exit(1);
  }
};

// ─── CRON — Reset at 9:00 AM IST every weekday ───────────────────────────────
cron.schedule("0 9 * * 1-5", () => {
  resetDailyState();
  resetAutoCondorDay();
}, { timezone: "Asia/Kolkata" });

start();