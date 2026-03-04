import {fyers} from "../config/fyersConfig.js";

export const placeOrder = async ({ symbol, qty, side }) => {
  const sideLabel = side === 1 ? 'BUY' : 'SELL';

  if (process.env.LIVE_TRADING !== "true") {
    console.log(`\n📝 [PAPER] ${sideLabel} ${qty} ${symbol}`);
    return { s: "ok" };
  }

  try {
    const response = await fyers.place_order({
      symbol: symbol,
      qty: Math.floor(qty),
      type: 2, // Market
      side: side,
      productType: "INTRADAY",
      validity: "DAY"
    });

    if (response.s === "ok") console.log(`✅ Order Placed: ${response.id}`);
    else console.error(`❌ Order Rejected: ${response.message}`);
    
    return response;
  } catch (err) {
    console.error("❌ Execution API Error:", err.message);
    return { s: "error" };
  }
};