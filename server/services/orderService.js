import { getKiteInstance } from './kiteService.js';

/**
 * 🛡️ UNIVERSAL MARGIN-SAFE EXIT
 * Automatically detects if the trade is a single spread or a full Iron Condor
 * and executes the exit in a sequence that prevents margin spikes.
 */
export const executeMarketExit = async (trade) => {
    const kc = getKiteInstance();
    const exchange = trade.index === 'SENSEX' ? 'BFO' : 'NFO';
    
    console.log(`🚨 [EXECUTION] Margin-Safe Exit Triggered for ${trade.index}`);

    try {
        // STEP 1: IDENTIFY SHORT LEGS (These MUST be exited first)
        const shortLegs = [
            { symbol: trade.symbols.callSell, type: "BUY" },
            { symbol: trade.symbols.putSell, type: "BUY" }
        ].filter(leg => leg.symbol);

        // STEP 2: IDENTIFY LONG LEGS (These MUST be exited second)
        const longLegs = [
            { symbol: trade.symbols.callBuy, type: "SELL" },
            { symbol: trade.symbols.putBuy, type: "SELL" }
        ].filter(leg => leg.symbol);

        // --- EXECUTION PHASE 1: EXIT SHORTS ---
        for (const leg of shortLegs) {
            console.log(`⏳ Closing Short Leg (Buying to cover): ${leg.symbol}...`);
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

        // --- EXECUTION PHASE 2: EXIT LONGS ---
        for (const leg of longLegs) {
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

        return { status: "SUCCESS" };
    } catch (error) {
        console.error('❌ CRITICAL ORDER FAILURE:', error.message);
        throw error;
    }
};

/**
 * 🛠️ LEGACY HELPER: Still kept in case you manually call a 2-leg exit
 */
export const executeMarginSafeExit = async (sellSymbol, buySymbol, totalQuantity, index) => {
    const kc = getKiteInstance();
    const exchange = index === 'SENSEX' ? 'BFO' : 'NFO';

    try {
        // Exit Short First
        await kc.placeOrder("regular", {
            exchange,
            tradingsymbol: sellSymbol,
            transaction_type: "BUY",
            quantity: totalQuantity,
            order_type: "MARKET",
            product: "NRML"
        });

        // Exit Long Second
        await kc.placeOrder("regular", {
            exchange,
            tradingsymbol: buySymbol,
            transaction_type: "SELL",
            quantity: totalQuantity,
            order_type: "MARKET",
            product: "NRML"
        });

        return { s: "ok" };
    } catch (error) {
        console.error('❌ Spread Exit Failure:', error.message);
        throw error;
    }
};