import fyers from "../config/fyersConfig.js"; 
import { kiteToFyersSymbol } from './symbolMapper.js';
import dotenv from 'dotenv';

dotenv.config();

const extractBaseSymbol = (symbol) => {
    const match = symbol.match(/^(.+?)(\d+)(CE|PE)$/);
    return match ? { base: match[1], strike: parseInt(match[2]), type: match[3] } : null;
};

// 🚨 FIXED: Accept 'io' as a parameter directly
export const scanForRoll = async (trade, liveSpotPrice, io) => {
    try {
        if (!io || !liveSpotPrice) return;

        const isNifty = trade.index === 'NIFTY';
        const stepSize = isNifty ? 50 : 100;
        const spreadDistance = isNifty ? parseInt(process.env.NIFTY_SPREAD_DISTANCE || 150) : parseInt(process.env.SENSEX_SPREAD_DISTANCE || 500);

        let targetPremium = 0;
        let baseSymbolInfo = null;
        let sideToRoll = '';
        
        if (trade.alertsSent.call70Decay && !trade.alertsSent.put70Decay) {
            sideToRoll = 'CE';
            targetPremium = trade.putSpreadEntryPremium;
            baseSymbolInfo = extractBaseSymbol(trade.symbols.callSell);
        } else if (trade.alertsSent.put70Decay && !trade.alertsSent.call70Decay) {
            sideToRoll = 'PE';
            targetPremium = trade.callSpreadEntryPremium;
            baseSymbolInfo = extractBaseSymbol(trade.symbols.putSell);
        } else {
            return;
        }

        if (!baseSymbolInfo) return;
        const { base, strike: currentShortStrike } = baseSymbolInfo;
        const strikesToScan = [];

        for (let i = 1; i <= 5; i++) {
            let scanShort = sideToRoll === 'CE' ? currentShortStrike - (i * stepSize) : currentShortStrike + (i * stepSize);
            let scanLong = sideToRoll === 'CE' ? scanShort + spreadDistance : scanShort - spreadDistance;

            strikesToScan.push({
                sellKite: `${base}${scanShort}${sideToRoll}`,
                buyKite: `${base}${scanLong}${sideToRoll}`,
                sellFyers: kiteToFyersSymbol(`${base}${scanShort}${sideToRoll}`, trade.index),
                buyFyers: kiteToFyersSymbol(`${base}${scanLong}${sideToRoll}`, trade.index)
            });
        }

        const symbolsString = strikesToScan.flatMap(s => [s.sellFyers, s.buyFyers]).join(',');
        const response = await fyers.get_quotes(symbolsString);
        
        if (response.s !== "ok") return;
        const quotes = response.d;

        let suggestedRoll = null;
        for (const pair of strikesToScan) {
            const sellLTP = quotes.find(q => q.n === pair.sellFyers)?.v.lp || 0;
            const buyLTP = quotes.find(q => q.n === pair.buyFyers)?.v.lp || 0;
            const netPremium = Math.abs(sellLTP - buyLTP);

            if (netPremium >= targetPremium && netPremium <= targetPremium + 1.0) {
                suggestedRoll = {
                    side: sideToRoll,
                    sellSymbol: pair.sellKite,
                    buySymbol: pair.buyKite,
                    netPremium: netPremium.toFixed(2),
                    targetPremium: targetPremium.toFixed(2),
                    status: 'READY'
                };
                break;
            }
        }

        if (suggestedRoll) io.emit('roll_suggestion', suggestedRoll);

    } catch (err) {
        console.error("❌ Free Radar Error:", err.message);
    }
};