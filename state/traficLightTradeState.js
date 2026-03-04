export const tradeState = {
  tradeTakenToday: false,
  tradeActive: false,
  direction: null,
  entryPrice: null,
  trailingActive: false,
  trailSL: null, 
  breakoutHigh: null,
  breakoutLow: null,
  candles: [], // Will store 3-min candles for pattern detection
  optionSymbol: null,
};

// ========================
// STATE MANAGEMENT HELPERS
// ========================

export const resetDailyState = () => {
  tradeState.tradeTakenToday = false;
  tradeState.tradeActive = false;
  tradeState.direction = null;
  tradeState.entryPrice = null;
  tradeState.trailingActive = false;
  tradeState.trailSL = null; 
  tradeState.breakoutHigh = null;
  tradeState.breakoutLow = null;
  tradeState.candles = [];
  tradeState.optionSymbol = null;
  
  console.log("🧹 Trade state reset for the new day.");
};

export const pruneCandles = (maxCandles = 5) => {
  // We only really need the last 2 candles for your strategy
  if (tradeState.candles.length > maxCandles) {
    tradeState.candles = tradeState.candles.slice(-maxCandles);
  }
};