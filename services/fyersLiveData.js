import { fyersDataSocket } from "fyers-api-v3";
import { getIO } from "../config/socket.js";
import { CandleBuilder } from "../services/candleBuilderTraficLight.js";

// 🧠 Import the Brains (Your Strategy Modules)
import { handleNewCandle, handleTick } from "../Engines/traficLightEngine.js"; // Traffic Light
import {
  updateCondorPrice,
  monitorCondorLevels,
} from "../Engines/ironCondorEngine.js"; // Iron Condor

import getActiveTradeModel from "../models/ironCondorActiveTradeModel.js";
import {
  kiteToFyersSymbol,
  getFyersIndexSymbol,
} from "../services/fyersSymbolMapper.js";

// --- BASE SYMBOLS ---
const NIFTY_SPOT = "NSE:NIFTY50-INDEX";
const SENSEX_SPOT = "BSE:SENSEX-INDEX";
const niftyCandleBuilder = new CandleBuilder(3);


export const initFyersLiveData = async () => {
  const io = getIO();
  const accessToken = process.env.FYERS_ACCESS_TOKEN;
  const appId = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    console.error("❌ Fyers Live Data: Missing Credentials.");
    return;
  }

  // --- 🛠️ V3 WEBSOCKET SETUP ---
  const wsAppId = appId.includes("-") ? appId : `${appId}-100`;
  const wsToken = accessToken.includes(":")
    ? accessToken
    : `${wsAppId}:${accessToken}`;

  console.log("🔌 Connecting to Fyers Live Data Socket...");
  const fyersData = fyersDataSocket.getInstance(wsToken, "./logs");
  fyersData.autoreconnect();

  fyersData.on("connect", async () => {
    const ActiveTrade = getActiveTradeModel();
    console.log("✅ Fyers Live Data Connected! Building subscription list...");

    let symbolsToSubscribe = [NIFTY_SPOT, SENSEX_SPOT];

    // Add Active Iron Condor Legs to the subscription
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

    fyersData.subscribe(symbolsToSubscribe, false);
    console.log(`📡 Listening to ${symbolsToSubscribe.length} symbols.`);
  });

  // --- 🔀 THE DATA ROUTER ---
  fyersData.on("message", async (msg) => {
    const symbol = msg.symbol || msg.n;
    const price = msg.ltp || msg.v?.lp;

    if (!symbol || !price) return;

    // 🚦 1. Feed the Traffic Light Strategy (Nifty Only)
    if (symbol === NIFTY_SPOT) {
      await handleTick(price);
      if (io) io.emit("market_tick", { price, timestamp: Date.now() });

      const finishedCandle = niftyCandleBuilder.build(price, Date.now());
      if (finishedCandle) {
        console.log(
          `\n📦 New 3-Min Candle: ${finishedCandle.color.toUpperCase()} | Range: ${finishedCandle.range.toFixed(2)}`,
        );
        handleNewCandle(finishedCandle);
      }
    }

    // 🛡️ 2. Feed the Iron Condor Strategy (All Symbols)
    updateCondorPrice(symbol, price); // Update the cache in the brain
    await monitorCondorLevels(); // Tell the brain to check SL/Decay
  });

  fyersData.on("error", (err) =>
    console.error("❌ Fyers Live Data Error:", err),
  );
  fyersData.on("close", () =>
    console.log("❌ Fyers Live Data Closed. Auto-reconnecting..."),
  );

  fyersData.connect();
};
