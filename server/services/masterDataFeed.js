import { fyersDataSocket } from "fyers-api-v3";
import { CandleBuilder } from "../services/candleBuilder.js";
import { handleNewCandle, handleTick } from "../strategy/strategyEngine.js";
import ActiveTrade from "../models/activeTradeModel.js";
import { sendTelegramAlert } from "./telegramService.js";
import { scanForRoll } from "./rollService.js";
import { executeMarketExit } from "./orderService.js";
import { kiteToFyersSymbol, getFyersIndexSymbol } from "./symbolMapper.js";

// --- BASE SYMBOLS ---
const NIFTY_SPOT = "NSE:NIFTY50-INDEX";
const SENSEX_SPOT = "BSE:SENSEX-INDEX"; 
const niftyCandleBuilder = new CandleBuilder(3);

// Shared cache for Iron Condor
export let lastPrices = {};
let lastScanTime = 0;

export const initMasterDataFeed = async (io) => {
  const accessToken = process.env.FYERS_ACCESS_TOKEN;
  const appId = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    console.error("❌ Master Feed: Missing Credentials.");
    return;
  }

  // --- 🛠️ V3 WEBSOCKET FIX ---
  // 1. Ensure App ID has the '-100' suffix required for WebSockets
  const wsAppId = appId.includes("-") ? appId : `${appId}-100`;

  // 2. Combine into the strict AppID:Token string format
  const wsToken = accessToken.includes(":")
    ? accessToken
    : `${wsAppId}:${accessToken}`;

  console.log("🔌 Connecting to Unified Fyers V3 Master Socket...");

  // 3. Initialize using getInstance to obey the Singleton rule
  const fyersData = fyersDataSocket.getInstance(wsToken, "./logs");
  
  // 4. Enable Fyers native auto-reconnect
  fyersData.autoreconnect();
  // -----------------------------

  fyersData.on("connect", async () => {
    console.log(
      "✅ Master Feed Connected! Building unified subscription list...",
    );

    // 1. Base Subscriptions: NIFTY SPOT (Traffic Light) & SENSEX SPOT (Iron Condor)
    let symbolsToSubscribe = [NIFTY_SPOT, SENSEX_SPOT];

    // 2. Add Iron Condor Legs if a trade is active
    const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (activeTrade) {
      const icSymbols = [
        getFyersIndexSymbol(activeTrade.index),
        activeTrade.symbols.callSell
          ? kiteToFyersSymbol(activeTrade.symbols.callSell, activeTrade.index)
          : null,
        activeTrade.symbols.callBuy
          ? kiteToFyersSymbol(activeTrade.symbols.callBuy, activeTrade.index)
          : null,
        activeTrade.symbols.putSell
          ? kiteToFyersSymbol(activeTrade.symbols.putSell, activeTrade.index)
          : null,
        activeTrade.symbols.putBuy
          ? kiteToFyersSymbol(activeTrade.symbols.putBuy, activeTrade.index)
          : null,
      ].filter(Boolean);

      symbolsToSubscribe = [...new Set([...symbolsToSubscribe, ...icSymbols])];
    }

    // 3. Subscribe in Full Mode (passing 'false' as the second argument)
    fyersData.subscribe(symbolsToSubscribe, false);
    console.log(
      `📡 Subscribed to ${symbolsToSubscribe.length} total symbols for both strategies.`,
    );
  });

  fyersData.on("message", async (msg) => {
    const symbol = msg.symbol || msg.n;
    const price = msg.ltp || msg.v?.lp;

    if (!symbol || !price) return;

    // --- 🚦 TRAFFIC LIGHT LOGIC (Only catches Nifty) ---
    if (symbol === NIFTY_SPOT) {
      // 1. Tick logic & Dashboard emission
      await handleTick(price);
      if (io) io.emit("market_tick", { price, timestamp: Date.now() });

      // 2. Candle building
      const finishedCandle = niftyCandleBuilder.build(price, Date.now());
      if (finishedCandle) {
        console.log(
          `\n📦 New 3-Min Candle: ${finishedCandle.color.toUpperCase()} | Range: ${finishedCandle.range.toFixed(2)}`,
        );
        handleNewCandle(finishedCandle);
      }
    }

    // --- 🛡️ IRON CONDOR LOGIC (Catches everything) ---
    // Update the cache for ALL incoming symbols (Spot + Options)
    lastPrices[symbol] = price;

    // Run the Iron Condor SL and Decay monitor (Pass IO for Roll Service)
    await monitorCondorLevels(io);
  });

  fyersData.on("error", (err) => console.error("❌ Master Socket Error:", err));

  fyersData.on("close", () => {
    console.log("❌ Master Socket Closed. Native auto-reconnect will handle it...");
    // We rely on fyersData.autoreconnect() instead of a custom timeout now
  });

  fyersData.connect();
};

// --- IRON CONDOR MONITORING FUNCTION ---
async function monitorCondorLevels(io) {
  const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });
  if (!activeTrade || activeTrade.status !== "ACTIVE") return;

  const idx = activeTrade.index;
  const getLtp = (sym) =>
    sym ? lastPrices[kiteToFyersSymbol(sym, idx)] || 0 : 0;
  const spotLTP = lastPrices[getFyersIndexSymbol(idx)] || 0;

  const currentCallNet = activeTrade.symbols.callSell
    ? Math.abs(
        getLtp(activeTrade.symbols.callSell) -
          getLtp(activeTrade.symbols.callBuy),
      )
    : 0;
  const currentPutNet = activeTrade.symbols.putSell
    ? Math.abs(
        getLtp(activeTrade.symbols.putSell) -
          getLtp(activeTrade.symbols.putBuy),
      )
    : 0;

  let stateChanged = false;

  // --- 🎯 70% DECAY ALERTS (Target Achievement) ---
  if (!activeTrade.alertsSent.call70Decay && currentCallNet > 0 && currentCallNet <= (activeTrade.callSpreadEntryPremium * 0.3)) {
      sendTelegramAlert(`🟢 <b>70% DECAY: ${idx} CALL</b>\nEntry: ₹${activeTrade.callSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentCallNet.toFixed(2)}\nRadar Activated.`);
      activeTrade.alertsSent.call70Decay = true;
      stateChanged = true;
  }

  if (!activeTrade.alertsSent.put70Decay && currentPutNet > 0 && currentPutNet <= (activeTrade.putSpreadEntryPremium * 0.3)) {
      sendTelegramAlert(`🟢 <b>70% DECAY: ${idx} PUT</b>\nEntry: ₹${activeTrade.putSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentPutNet.toFixed(2)}\nRadar Activated.`);
      activeTrade.alertsSent.put70Decay = true;
      stateChanged = true;
  }

  if (stateChanged) await activeTrade.save();

  // --- 🛡️ RADAR TRIGGER (Roll Scanner) ---
  // If a target is hit, check for roll opportunities every 5 seconds
  if ((activeTrade.alertsSent.call70Decay || activeTrade.alertsSent.put70Decay) && spotLTP) {
      if (Date.now() - lastScanTime > 5000) {
          lastScanTime = Date.now();
          scanForRoll(activeTrade, spotLTP, io); 
      }
  }

  // --- 🚨 STOP LOSS LOGIC ---
  const callSL =
    activeTrade.callSpreadEntryPremium * 4 + (activeTrade.bufferPremium || 0);
  const putSL =
    activeTrade.putSpreadEntryPremium * 4 + (activeTrade.bufferPremium || 0);

  let triggerExit = false;
  let reason = "";

  if (activeTrade.symbols.callSell && currentCallNet >= callSL) {
      triggerExit = true;
      reason = `CALL SL Hit (Current: ₹${currentCallNet.toFixed(2)} | Limit: ₹${callSL.toFixed(2)})`;
  } else if (activeTrade.symbols.putSell && currentPutNet >= putSL) {
      triggerExit = true;
      reason = `PUT SL Hit (Current: ₹${currentPutNet.toFixed(2)} | Limit: ₹${putSL.toFixed(2)})`;
  }

  if (triggerExit && activeTrade.status === "ACTIVE") {
    activeTrade.status = "EXITING";
    await activeTrade.save();
    sendTelegramAlert(`🚨 <b>STOP LOSS HIT: ${idx}</b>\nReason: ${reason}`);
    await executeMarketExit(activeTrade);
  }
}