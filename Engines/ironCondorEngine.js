import { getKiteInstance } from '../config/kiteConfig.js';
import { getQuotes } from '../config/fyersConfig.js';
import { getIO } from '../config/socket.js'; 
import { sendTelegramAlert } from '../services/telegramService.js';
import { executeMarketExit } from '../services/IronCodorOrderService.js';
import { kiteToFyersSymbol, getFyersIndexSymbol } from '../services/symbolMapper.js';
import ActiveTrade from '../models/ironCondorActiveTradeModel.js';
import TradePerformance from '../models/condorTradePerformanceModel.js';
import dotenv from 'dotenv';

dotenv.config();

// ==========================================
// 🧠 1. STATE & CACHE MANAGER
// ==========================================
export const condorPrices = {};
let lastScanTime = 0;

export const updateCondorPrice = (symbol, price) => {
    condorPrices[symbol] = price;
};

const getActiveIndexForToday = () => {
    const day = new Date().getDay();
    if (day === 1 || day === 2) return 'NIFTY';
    if (day === 3 || day === 4) return 'SENSEX';
    return null; 
};

const extractBaseSymbol = (symbol) => {
    if (!symbol) return null;
    const match = symbol.match(/^(.+?)(\d+)(CE|PE)$/);
    return match ? { base: match[1], strike: parseInt(match[2]), type: match[3] } : null;
};

// ==========================================
// 🛡️ 2. LIVE RISK & DECAY MONITOR
// ==========================================
export const monitorCondorLevels = async () => {
  const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });
  if (!activeTrade || activeTrade.status !== "ACTIVE") return;

  const idx = activeTrade.index;
  const getLtp = (sym) => sym ? condorPrices[kiteToFyersSymbol(sym, idx)] || 0 : 0;
  const spotLTP = condorPrices[getFyersIndexSymbol(idx)] || 0;

  const currentCallNet = activeTrade.symbols.callSell ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy)) : 0;
  const currentPutNet = activeTrade.symbols.putSell ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy)) : 0;

  let stateChanged = false;
  const { isIronButterfly, tradeType, callSpreadEntryPremium, putSpreadEntryPremium, totalEntryPremium, bufferPremium } = activeTrade;

  // --- 🎯 70% DECAY ALERTS ---
  if (!activeTrade.alertsSent.call70Decay && tradeType !== 'PUT_SPREAD' && currentCallNet > 0 && currentCallNet <= (callSpreadEntryPremium * 0.3)) {
      sendTelegramAlert(`🟢 <b>70% DECAY: ${idx} CALL</b>\nEntry: ₹${callSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentCallNet.toFixed(2)}\nRadar Activated.`);
      activeTrade.alertsSent.call70Decay = true;
      stateChanged = true;
  }

  if (!activeTrade.alertsSent.put70Decay && tradeType !== 'CALL_SPREAD' && currentPutNet > 0 && currentPutNet <= (putSpreadEntryPremium * 0.3)) {
      sendTelegramAlert(`🟢 <b>70% DECAY: ${idx} PUT</b>\nEntry: ₹${putSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentPutNet.toFixed(2)}\nRadar Activated.`);
      activeTrade.alertsSent.put70Decay = true;
      stateChanged = true;
  }

  // --- 🚨 DEFENSIVE RADAR TRIGGER (Short Strike Threatened) ---
  const callStrike = extractBaseSymbol(activeTrade.symbols.callSell)?.strike;
  const putStrike = extractBaseSymbol(activeTrade.symbols.putSell)?.strike;
  
  if (spotLTP && !isIronButterfly) {
      if (callStrike && spotLTP >= callStrike && !activeTrade.alertsSent.callDefense) {
          sendTelegramAlert(`⚠️ <b>DEFENSE ALERT: ${idx} CALL</b>\nSpot (${spotLTP}) has reached Short Strike (${callStrike}).\nScanning for Iron Butterfly conversion...`);
          activeTrade.alertsSent.callDefense = true;
          stateChanged = true;
      } else if (putStrike && spotLTP <= putStrike && !activeTrade.alertsSent.putDefense) {
          sendTelegramAlert(`⚠️ <b>DEFENSE ALERT: ${idx} PUT</b>\nSpot (${spotLTP}) has reached Short Strike (${putStrike}).\nScanning for Iron Butterfly conversion...`);
          activeTrade.alertsSent.putDefense = true;
          stateChanged = true;
      }
  }

  if (stateChanged) await activeTrade.save();

  // --- 📡 RADAR SCANNER TRIGGER ---
  if ((activeTrade.alertsSent.call70Decay || activeTrade.alertsSent.put70Decay || activeTrade.alertsSent.callDefense || activeTrade.alertsSent.putDefense) && !isIronButterfly && spotLTP) {
      if (Date.now() - lastScanTime > 5000) {
          lastScanTime = Date.now();
          await scanForRoll(activeTrade, spotLTP); 
      }
  }

  // --- 🚨 STOP LOSS LOGIC ---
  let triggerExit = false;
  let exitReason = "";

  const currentTotalValue = currentCallNet + currentPutNet;

  if (isIronButterfly) {
      // 🦋 IRON BUTTERFLY 2% LOSS LIMIT
      // Assuming average Iron Butterfly margin is ~₹40,000 per lot.
      // 2% of ₹40,000 = ₹800 max loss allowed per lot.
      const marginPerLot = 40000;
      const maxLossPercent = 0.02; // 2%
      
      // Convert that ₹800 loss into option premium points (e.g., 800 / 50 for Nifty = 16 points)
      const allowedLossPoints = (marginPerLot * maxLossPercent) / (activeTrade.lotSize || 50);
      
      // Your position goes into a loss when its exit cost EXCEEDS your entry credit.
      const maxLossLimit = totalEntryPremium + allowedLossPoints; 
      
      if (currentTotalValue >= maxLossLimit) {
          triggerExit = true;
          exitReason = `Iron Butterfly 2% SL Hit (Limit: ₹${maxLossLimit.toFixed(2)} | Current: ₹${currentTotalValue.toFixed(2)})`;
      }
  } else {
      // 🦅 STANDARD IRON CONDOR LEG SL
      const callSL = (callSpreadEntryPremium * 4) + (bufferPremium || 0);
      const putSL = (putSpreadEntryPremium * 4) + (bufferPremium || 0);

      if (tradeType !== 'PUT_SPREAD' && currentCallNet >= callSL) {
          triggerExit = true;
          exitReason = `CALL SL Hit (Current: ₹${currentCallNet.toFixed(2)} | Limit: ₹${callSL.toFixed(2)})`;
      } else if (tradeType !== 'CALL_SPREAD' && currentPutNet >= putSL) {
          triggerExit = true;
          exitReason = `PUT SL Hit (Current: ₹${currentPutNet.toFixed(2)} | Limit: ₹${putSL.toFixed(2)})`;
      }
  }

  if (triggerExit && activeTrade.status === "ACTIVE") {
    activeTrade.status = "EXITING";
    await activeTrade.save();
    sendTelegramAlert(`🚨 <b>STOP LOSS TRIGGERED: ${idx}</b>\nReason: ${exitReason}\nExecuting margin-safe exit...`);
    await executeMarketExit(activeTrade);
  }
};

// ==========================================
// 📡 3. THE ROLL SCANNER (RADAR)
// ==========================================
export const scanForRoll = async (trade, liveSpotPrice) => {
    try {
        const io = getIO();
        if (!io || !liveSpotPrice) return;

        const isNifty = trade.index === 'NIFTY';
        const spreadDistance = isNifty ? parseInt(process.env.NIFTY_SPREAD_DISTANCE || 150) : parseInt(process.env.SENSEX_SPREAD_DISTANCE || 500);

        let suggestedRoll = null;
        const baseSymbolInfoCall = extractBaseSymbol(trade.symbols.callSell);
        const baseSymbolInfoPut = extractBaseSymbol(trade.symbols.putSell);

        // 🦋 --- MODE 1: DEFENSE (IRON BUTTERFLY CONVERSION) ---
        if (trade.alertsSent.callDefense || trade.alertsSent.putDefense) {
            const sideToRoll = trade.alertsSent.callDefense ? 'PE' : 'CE';
            const targetShortStrike = trade.alertsSent.callDefense ? baseSymbolInfoCall.strike : baseSymbolInfoPut.strike;
            const targetLongStrike = sideToRoll === 'PE' ? targetShortStrike - spreadDistance : targetShortStrike + spreadDistance;
            
            const base = baseSymbolInfoCall.base; 
            const sellKite = `${base}${targetShortStrike}${sideToRoll}`;
            const buyKite = `${base}${targetLongStrike}${sideToRoll}`;
            const sellFyers = kiteToFyersSymbol(sellKite, trade.index);
            const buyFyers = kiteToFyersSymbol(buyKite, trade.index);

            const quotes = await getQuotes([`${sellFyers},${buyFyers}`]); 
            let netPremium = 0;
            if (quotes) {
                const sellLTP = quotes.find(q => q.n === sellFyers)?.v?.lp || 0;
                const buyLTP = quotes.find(q => q.n === buyFyers)?.v?.lp || 0;
                netPremium = Math.abs(sellLTP - buyLTP);
            }

            suggestedRoll = {
                side: sideToRoll,
                type: 'DEFENSE', 
                sellSymbol: sellKite,
                buySymbol: buyKite,
                netPremium: netPremium.toFixed(2),
                targetPremium: 'MAX CREDIT', 
                isIronButterfly: true,
                status: 'READY'
            };
        } 
        
        // 🦅 --- MODE 2: OFFENSE (70% DECAY ROLL INWARD) ---
        else if (trade.alertsSent.call70Decay || trade.alertsSent.put70Decay) {
            const sideToRoll = trade.alertsSent.call70Decay ? 'CE' : 'PE';
            const targetPremium = trade.alertsSent.call70Decay ? trade.putSpreadEntryPremium : trade.callSpreadEntryPremium;
            const currentShortStrike = sideToRoll === 'CE' ? baseSymbolInfoCall.strike : baseSymbolInfoPut.strike;
            const oppositeShortStrike = sideToRoll === 'CE' ? baseSymbolInfoPut.strike : baseSymbolInfoCall.strike;
            const base = baseSymbolInfoCall.base;
            const stepSize = isNifty ? 50 : 100;
            
            const strikesToScan = [];

            for (let i = 1; i <= 5; i++) {
                let scanShort = sideToRoll === 'CE' ? currentShortStrike - (i * stepSize) : currentShortStrike + (i * stepSize);
                let scanLong = sideToRoll === 'CE' ? scanShort + spreadDistance : scanShort - spreadDistance;

                if (sideToRoll === 'CE' && scanShort < oppositeShortStrike) break;
                if (sideToRoll === 'PE' && scanShort > oppositeShortStrike) break;

                strikesToScan.push({
                    sellKite: `${base}${scanShort}${sideToRoll}`,
                    buyKite: `${base}${scanLong}${sideToRoll}`,
                    sellFyers: kiteToFyersSymbol(`${base}${scanShort}${sideToRoll}`, trade.index),
                    buyFyers: kiteToFyersSymbol(`${base}${scanLong}${sideToRoll}`, trade.index)
                });
            }

            if (strikesToScan.length > 0) {
                const symbolsString = strikesToScan.flatMap(s => [s.sellFyers, s.buyFyers]).join(',');
                const quotes = await getQuotes([symbolsString]); 

                if (quotes) {
                    for (const pair of strikesToScan) {
                        const sellLTP = quotes.find(q => q.n === pair.sellFyers)?.v?.lp || 0;
                        const buyLTP = quotes.find(q => q.n === pair.buyFyers)?.v?.lp || 0;
                        const netPremium = Math.abs(sellLTP - buyLTP);

                        if (netPremium >= targetPremium && netPremium <= targetPremium + 1.0) {
                            suggestedRoll = {
                                side: sideToRoll,
                                type: 'OFFENSE', 
                                sellSymbol: pair.sellKite,
                                buySymbol: pair.buyKite,
                                netPremium: netPremium.toFixed(2),
                                targetPremium: targetPremium.toFixed(2),
                                isIronButterfly: false,
                                status: 'READY'
                            };
                            break;
                        }
                    }
                }
            }
        }

        if (suggestedRoll) io.emit('roll_suggestion', suggestedRoll);

    } catch (err) {
        console.error("❌ Roll Radar Error:", err.message);
    }
};

// ==========================================
// 🔄 4. KITE POSITION SYNC MANAGER
// ==========================================
export const scanAndSyncOrders = async () => {
    const index = getActiveIndexForToday();
    if (!index) return;

    const kc = getKiteInstance();
    try {
        const positions = await kc.getPositions();
        let activeTrade = await ActiveTrade.findOne({ index, status: 'ACTIVE' });

        const activeIndexPositions = positions.net.filter(p => p.tradingsymbol.startsWith(index) && p.quantity !== 0);

        // --- 🏁 TRADE COMPLETION ---
        if (activeIndexPositions.length === 0 && activeTrade) {
            console.log(`🏁 All positions closed. Finalizing trade...`);
            const totalPnL = positions.net.filter(p => p.tradingsymbol.startsWith(index)).reduce((sum, p) => sum + p.pnl, 0);

            try {
                await TradePerformance.create({
                    index: index,
                    exitReason: totalPnL >= 0 ? 'PROFIT_TARGET' : 'STOP_LOSS_HIT',
                    realizedPnL: totalPnL,
                    notes: `Strategy: Iron Condor/Butterfly | Final P&L: ₹${totalPnL.toFixed(2)}`
                });
            } catch (dbErr) { console.error("❌ History Archive Error:", dbErr.message); }

            activeTrade.status = 'COMPLETED';
            activeTrade.exitTime = new Date();
            await activeTrade.save();

            sendTelegramAlert(`🏁 <b>Trade Completed: ${index}</b>\nTotal P&L: <b>₹${totalPnL.toLocaleString('en-IN')}</b>`);
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

        let isButterflyNow = false;
        if (ceSell && peSell) {
            const callStrike = extractBaseSymbol(ceSell.tradingsymbol)?.strike;
            const putStrike = extractBaseSymbol(peSell.tradingsymbol)?.strike;
            if (callStrike === putStrike) isButterflyNow = true;
        }

        let tradeType = (ceSell && peSell) ? 'IRON_CONDOR' : ceSell ? 'CALL_SPREAD' : 'PUT_SPREAD';
        const callNet = ceSell && ceBuy ? Math.abs(ceSell.average_price - ceBuy.average_price) : 0;
        const putNet = peSell && peBuy ? Math.abs(peSell.average_price - peBuy.average_price) : 0;

        if (activeTrade) {
            const needsUpdate = activeTrade.symbols.callSell !== (ceSell?.tradingsymbol || null) || activeTrade.bufferPremium === 0 || activeTrade.isIronButterfly !== isButterflyNow;

            if (needsUpdate) {
                const totalRealizedPnL = positions.net.filter(p => p.tradingsymbol.startsWith(index) && p.quantity === 0).reduce((sum, p) => sum + p.pnl, 0);
                const lotSize = activeTrade.lotSize || 325;
                
                activeTrade.bufferPremium = Math.max(0, totalRealizedPnL / lotSize); 
                activeTrade.tradeType = tradeType;
                activeTrade.isIronButterfly = isButterflyNow;
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
                
                sendTelegramAlert(`✅ <b>Bot Synced</b>\nButterfly Mode: <b>${isButterflyNow ? 'ON 🦋' : 'OFF'}</b>\nBuffer: <b>₹${activeTrade.bufferPremium.toFixed(2)}</b>`);
            }
        }
    } catch (err) {
        console.error("❌ Order Monitor Sync Error:", err.message);
    }
};