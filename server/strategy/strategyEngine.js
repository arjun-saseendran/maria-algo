import { tradeState, pruneCandles } from "../state/tradeState.js";
import { placeOrder } from "../services/trafficFyersOrderService.js";
import { DailyStatus } from "../models/dailyStatusModel.js"; 
import TrafficTradePerformance from "../models/trafficTradePerformanceModel.js"; // 🚨 ADDED: For History Archival
import { sendTelegramAlert } from "../services/telegramService.js";

const RANGE_LIMIT = 30; // Max points allowed for the 2-candle setup
const LOT_SIZE = 65; // Updated SEBI Lot Size

function getISTDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function getTodayString() {
  const d = getISTDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 1. PATTERN DETECTION (3-min timeframe, 2 opposite candles < 30 points)
export const handleNewCandle = (candle) => {
  const candleTime = new Date(new Date(candle.startTime).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
  // RULE: Ignore the very first 3-minute candle of the day (9:15 - 9:18 AM)
  if (candleTime.getHours() === 9 && candleTime.getMinutes() < 18) {
      console.log("⏳ Skipping first 3-min candle...");
      return; 
  }

  // Stop scanning if a trade was already taken for the day
  if (tradeState.tradeTakenToday) return;

  tradeState.candles.push(candle);
  pruneCandles(10); 

  // If a range is already locked, we wait for a breakout in handleTick
  if (tradeState.breakoutHigh && tradeState.breakoutLow) return;
  
  // Need at least 2 candles to check for "opposite color"
  if (tradeState.candles.length < 2) return;

  const c1 = tradeState.candles.at(-2);
  const c2 = tradeState.candles.at(-1);
  const color1 = c1.close >= c1.open ? "green" : "red";
  const color2 = c2.close >= c2.open ? "green" : "red";

  // RULE: Must be opposite colors (Traffic Light)
  if (color1 === color2) return; 

  // RULE: Combined range of the two candles must be < 30 points
  const high = Math.max(c1.high, c2.high);
  const low = Math.min(c1.low, c2.low);
  const totalRange = high - low;

  if (totalRange >= RANGE_LIMIT) {
      console.log(`ℹ️ Pattern found but range (${totalRange.toFixed(2)}) is > 30. Skipping.`);
      return; 
  }

  // Lock the Range for Entry
  tradeState.breakoutHigh = high;
  tradeState.breakoutLow = low;
  console.log(`🎯 TRAFFIC LIGHT RANGE LOCKED!`);
  console.log(`📏 High: ${high} | Low: ${low} | Range: ${totalRange.toFixed(2)}`);

  // 🔔 TELEGRAM: Notify when range is locked
  sendTelegramAlert(`🎯 <b>Range Locked</b>\nHigh: ${high}\nLow: ${low}\nRange: ${totalRange.toFixed(2)}`);

  DailyStatus.findOneAndUpdate(
    { date: getTodayString() }, { breakoutHigh: high, breakoutLow: low }, { upsert: true } 
  ).catch(err => console.error("❌ DB Update Error:", err.message));
};

// 2. LIVE TICK MONITORING (Breakout Entry & Management)
export const handleTick = async (spotPrice) => {
  const now = getISTDate();
  
  // RULE: Hard exit at 3:21 PM
  if (now.getHours() === 15 && now.getMinutes() >= 21) {
    if (tradeState.tradeActive) {
      console.log("⏰ 3:21 PM Reached. Squaring off position...");
      await exitTrade(spotPrice, "3:21 PM Time Exit");
    }
    return;
  }

  // ENTRY LOGIC
  if (!tradeState.tradeTakenToday && !tradeState.tradeActive && tradeState.breakoutHigh) {
    if (spotPrice > tradeState.breakoutHigh) {
        await enterTrade("CE", spotPrice);
    } else if (spotPrice < tradeState.breakoutLow) {
        await enterTrade("PE", spotPrice);
    }
  }

  // MANAGEMENT LOGIC
  if (tradeState.tradeActive) {
      await manageTrade(spotPrice);
  }
};

// 3. RISK MANAGEMENT
async function manageTrade(spotPrice) {
    const { direction, entryPrice, breakoutHigh, breakoutLow, trailingActive } = tradeState;
    
    const risk = breakoutHigh - breakoutLow; 
    const targetPoints = risk * 3; // 1:3 Reward
    const currentPoints = (direction === "CE") ? (spotPrice - entryPrice) : (entryPrice - spotPrice);

    if (!trailingActive) {
      // INITIAL STOPLOSS: High of 2-candles for PE, Low for CE
      const sl = (direction === "CE") ? breakoutLow : breakoutHigh; 
      
      if ((direction === "CE" && spotPrice <= sl) || (direction === "PE" && spotPrice >= sl)) {
        console.log(`❌ Stoploss Hit at ${spotPrice}. Exiting.`);
        await exitTrade(spotPrice, "Stoploss Hit");
        return;
      }
      
      // TARGET REACHED: Lock profit at 1:3 and hold for 3:21 PM
      if (currentPoints >= targetPoints) {
        tradeState.trailingActive = true;
        tradeState.trailSL = (direction === "CE") ? (entryPrice + targetPoints) : (entryPrice - targetPoints);
        
        // 🔔 TELEGRAM: Notify Profit Locked
        sendTelegramAlert(`💰 <b>1:3 Profit Locked!</b>\nSide: ${direction}\nLocked Level: ${tradeState.trailSL.toFixed(2)}`);
        console.log(`💰 1:3 Target Hit! Profit locked at ${tradeState.trailSL.toFixed(2)}.`);
      }
    } else {
      // TRAILING: Only exit if price reverses to hit our locked 1:3 profit level
      if ((direction === "CE" && spotPrice <= tradeState.trailSL) || (direction === "PE" && spotPrice >= tradeState.trailSL)) {
         console.log("📈 Profit Protection Hit. Closing trade.");
         await exitTrade(spotPrice, "1:3 Profit Protection Secured");
      }
    }
}

async function enterTrade(direction, spotPrice) {
  const symbol = getOptionSymbol(direction, spotPrice);
  try {
    console.log(`🚀 Entering ${direction} Trade at ${spotPrice} (ATM Strike)`);
    await DailyStatus.findOneAndUpdate({ date: getTodayString() }, { tradeTakenToday: true }, { upsert: true });
    
    tradeState.tradeTakenToday = true;
    tradeState.tradeActive = true;
    tradeState.direction = direction;
    tradeState.entryPrice = spotPrice;
    tradeState.optionSymbol = symbol;
    tradeState.exitReason = "---"; // Reset reason for new trade

    await placeOrder({ symbol, qty: LOT_SIZE, side: 1 });

    // 🔔 TELEGRAM: Notify Entry
    sendTelegramAlert(`🚀 <b>Trade Entered</b>\nSide: ${direction}\nEntry Spot: ${spotPrice}\nStrike: ${symbol}`);

  } catch (err) { console.error("❌ Execution Error:", err.message); }
}

async function exitTrade(exitSpotPrice, reason = "Manual Exit") {
  if (!tradeState.tradeActive) return;
  
  // Update state with the reason so the Dashboard /api/status can see it
  tradeState.exitReason = reason;

  await placeOrder({ symbol: tradeState.optionSymbol, qty: LOT_SIZE, side: -1 });

  // 🚨 ADDED: Calculate PnL and save to History Database
  const points = tradeState.direction === "CE" ? (exitSpotPrice - tradeState.entryPrice) : (tradeState.entryPrice - exitSpotPrice);
  const realizedPnL = points * LOT_SIZE;

  try {
      let exitCategory = "MANUAL_CLOSE";
      if (reason.includes("Stoploss")) exitCategory = "STOP_LOSS_HIT";
      if (reason.includes("Profit") || reason.includes("3:21 PM")) exitCategory = "PROFIT_TARGET";

      await TrafficTradePerformance.create({
          index: "NIFTY",
          exitReason: exitCategory,
          realizedPnL: realizedPnL,
          notes: `Strategy: Traffic Light | Range: ${(tradeState.breakoutHigh - tradeState.breakoutLow).toFixed(2)} | Final PnL: ₹${realizedPnL.toFixed(2)}`
      });
      console.log(`💾 Trade archived to History DB.`);
  } catch (dbErr) {
      console.error("❌ Failed to save history:", dbErr.message);
  }

  // 🔔 TELEGRAM: Notify Exit
  sendTelegramAlert(`🏁 <b>Trade Closed</b>\nReason: ${reason}\nExit Spot: ${exitSpotPrice}\nEstimated PnL: ₹${realizedPnL.toFixed(2)}`);

  tradeState.tradeActive = false;
  console.log(`🏁 Trade Cycle Complete: ${reason}`);
}

function getOptionSymbol(direction, spotPrice) {
  const strike = Math.round(spotPrice / 50) * 50; 
  const d = getISTDate();
  
  // 🚨 FIXED: Targeting Tuesday Expiry
  const daysToTuesday = (2 + 7 - d.getDay()) % 7; 
  d.setDate(d.getDate() + daysToTuesday);
  
  const year = d.getFullYear().toString().slice(-2); 
  let month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  
  return `NSE:NIFTY${year}${month}${day}${strike}${direction}`;
}