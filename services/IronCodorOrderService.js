import { getKiteInstance } from '../config/kiteConfig.js'; // 🚨 Updated to your new config path
import dotenv from 'dotenv';

dotenv.config();

/**
 * 🛡️ UNIVERSAL MARGIN-SAFE EXIT
 * Automatically detects legs and executes exit in a sequence that prevents margin spikes.
 * Now integrated with LIVE_TRADING safety toggle.
 */
export const executeMarketExit = async (trade) => {
    const kc = getKiteInstance();
    const exchange = trade.index === 'SENSEX' ? 'BFO' : 'NFO';
    
    console.log(`🚨 [EXECUTION] ${process.env.LIVE_TRADING === "true" ? 'LIVE' : 'PAPER'} Exit Triggered for ${trade.index}`);

    try {
        const shortLegs = [
            { symbol: trade.symbols.callSell, type: "BUY" },
            { symbol: trade.symbols.putSell, type: "BUY" }
        ].filter(leg => leg.symbol);

        const longLegs = [
            { symbol: trade.symbols.callBuy, type: "SELL" },
            { symbol: trade.symbols.putBuy, type: "SELL" }
        ].filter(leg => leg.symbol);

        // --- EXECUTION PHASE 1: EXIT SHORTS ---
        for (const leg of shortLegs) {
            if (process.env.LIVE_TRADING !== "true") {
                console.log(`📝 [PAPER-KITE] BUY (Cover) ${trade.lotSize} ${leg.symbol}`);
            } else {
                console.log(`⏳ [LIVE] Closing Short Leg (Buying to cover): ${leg.symbol}...`);
                await kc.placeOrder("regular", {
                    exchange: exchange,
                    tradingsymbol: leg.symbol,
                    transaction_type: "BUY",
                    quantity: trade.lotSize,
                    order_type: "MARKET",
                    product: "NRML"
                });
                console.log(`✅ Short leg ${leg.symbol} closed.`);
            }
        }

        // --- EXECUTION PHASE 2: EXIT LONGS ---
        for (const leg of longLegs) {
            if (process.env.LIVE_TRADING !== "true") {
                console.log(`📝 [PAPER-KITE] SELL (Close) ${trade.lotSize} ${leg.symbol}`);
            } else {
                console.log(`⏳ Closing Long Leg (Selling to close): ${leg.symbol}...`);
                await kc.placeOrder("regular", {
                    exchange: exchange,
                    tradingsymbol: leg.symbol,
                    transaction_type: "SELL",
                    quantity: trade.lotSize,
                    order_type: "MARKET",
                    product: "NRML"
                });
                console.log(`✅ Long leg ${leg.symbol} closed.`);
            }
        }

        return { status: "SUCCESS" };
    } catch (error) {
        console.error('❌ CRITICAL ORDER FAILURE:', error.message);
        throw error;
    }
};

/**
 * 🚀 MARGIN-SAFE ENTRY / ROLL
 * Use this for one-click adjustments or new entries.
 */
export const executeMarginSafeEntry = async (buySymbol, sellSymbol, quantity, index) => {
    const kc = getKiteInstance();
    const exchange = index === 'SENSEX' ? 'BFO' : 'NFO';

    try {
        if (process.env.LIVE_TRADING !== "true") {
            console.log(`📝 [PAPER-KITE] ENTRY: BUY ${quantity} ${buySymbol} | THEN SELL ${quantity} ${sellSymbol}`);
            return { success: true };
        }

        // LIVE: Buy Long First
        await kc.placeOrder("regular", {
            exchange,
            tradingsymbol: buySymbol,
            transaction_type: "BUY",
            quantity: quantity,
            order_type: "MARKET",
            product: "NRML"
        });

        // LIVE: Sell Short Second
        await kc.placeOrder("regular", {
            exchange,
            tradingsymbol: sellSymbol,
            transaction_type: "SELL",
            quantity: quantity,
            order_type: "MARKET",
            product: "NRML"
        });

        return { success: true };
    } catch (error) {
        console.error("❌ Margin Safe Entry Failed:", error.message);
        throw error;
    }
};