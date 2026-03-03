import { getKiteInstance } from './kiteService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import TradePerformance from '../models/condorTradePerformanceModel.js'; // 📊 Unified History Model
import { sendTelegramAlert } from './telegramService.js';

const getActiveIndexForToday = () => {
    const day = new Date().getDay();
    if (day === 1 || day === 2) return 'NIFTY';
    if (day === 3 || day === 4) return 'SENSEX';
    return null; 
};

export const scanAndSyncOrders = async () => {
    const index = getActiveIndexForToday();
    if (!index) return;

    const kc = getKiteInstance();
    try {
        const positions = await kc.getPositions();
        
        // Find existing active record
        let activeTrade = await ActiveTrade.findOne({ index, status: 'ACTIVE' });

        // Filter for active legs (quantity not zero)
        const activeIndexPositions = positions.net.filter(p => 
            p.tradingsymbol.startsWith(index) && p.quantity !== 0
        );

        // --- 🏁 TRADE COMPLETION & HISTORY ARCHIVER ---
        if (activeIndexPositions.length === 0 && activeTrade) {
            console.log(`🏁 All positions closed. Finalizing trade...`);
            
            const totalPnL = positions.net
                .filter(p => p.tradingsymbol.startsWith(index))
                .reduce((sum, p) => sum + p.pnl, 0);

            // 💾 Save to the database for the Dashboard History table
            try {
                await TradePerformance.create({
                    index: index,
                    exitReason: totalPnL >= 0 ? 'PROFIT_TARGET' : 'STOP_LOSS_HIT',
                    realizedPnL: totalPnL,
                    notes: `Strategy: Iron Condor/Spread | Final P&L: ₹${totalPnL.toFixed(2)}`
                });
            } catch (dbErr) {
                console.error("❌ History Archive Error:", dbErr.message);
            }

            activeTrade.status = 'COMPLETED';
            activeTrade.exitTime = new Date();
            await activeTrade.save();

            sendTelegramAlert(
                `🏁 <b>Trade Completed: ${index}</b>\n\n` +
                `Total Day's P&L: <b>₹${totalPnL.toLocaleString('en-IN')}</b>\n` +
                `Status: <b>Archived to Performance History.</b>`
            );
            return;
        }

        if (activeIndexPositions.length === 0) return;

        let ceSell, ceBuy, peSell, peBuy;
        activeIndexPositions.forEach(p => {
            const isCall = p.tradingsymbol.endsWith('CE');
            const isSell = p.quantity < 0; 
            if (isCall && isSell) ceSell = p;
            if (isCall && !isSell) ceBuy = p;
            if (!isCall && isSell) peSell = p;
            if (!isCall && !isSell) peBuy = p;
        });

        let tradeType = (ceSell && peSell) ? 'IRON_CONDOR' : ceSell ? 'CALL_SPREAD' : 'PUT_SPREAD';
        const callNet = ceSell && ceBuy ? Math.abs(ceSell.average_price - ceBuy.average_price) : 0;
        const putNet = peSell && peBuy ? Math.abs(peSell.average_price - peBuy.average_price) : 0;

        if (activeTrade) {
            const needsUpdate = 
                activeTrade.symbols.callSell !== (ceSell?.tradingsymbol || null) ||
                activeTrade.bufferPremium === 0;

            if (needsUpdate) {
                const totalRealizedPnL = positions.net
                    .filter(p => p.tradingsymbol.startsWith(index) && p.quantity === 0)
                    .reduce((sum, p) => sum + p.pnl, 0);

                const lotSize = activeTrade.lotSize || 325;
                activeTrade.bufferPremium = Math.max(0, totalRealizedPnL / lotSize); 
                activeTrade.tradeType = tradeType;
                activeTrade.callSpreadEntryPremium = callNet || activeTrade.callSpreadEntryPremium;
                activeTrade.putSpreadEntryPremium = putNet || activeTrade.putSpreadEntryPremium;
                activeTrade.totalEntryPremium = activeTrade.callSpreadEntryPremium + activeTrade.putSpreadEntryPremium;
                activeTrade.symbols = {
                    callSell: ceSell?.tradingsymbol || null,
                    callBuy: ceBuy?.tradingsymbol || null,
                    putSell: peSell?.tradingsymbol || null,
                    putBuy: peBuy?.tradingsymbol || null
                };
                await activeTrade.save();
                
                sendTelegramAlert(`✅ <b>Bot Synced & Buffer Updated</b>\nNew Buffer: <b>₹${activeTrade.bufferPremium.toFixed(2)}</b>`);
            }
        }
    } catch (err) {
        console.error("❌ Order Monitor Sync Error:", err.message);
    }
};