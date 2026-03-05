import { getKiteInstance } from '../config/kiteConfig.js';
import { getQuotes } from '../config/fyersConfig.js';
import { getIO } from '../config/socket.js';
import { sendCondorAlert } from '../services/telegramService.js';
import { executeMarketExit, executeMarginSafeEntry } from '../services/IronCodorOrderService.js';
import { kiteToFyersSymbol, getFyersIndexSymbol } from '../services/fyersSymbolMapper.js';
import  getActiveTradeModel  from '../models/ironCondorActiveTradeModel.js';
import { getCondorTradePerformanceModel } from '../models/condorTradePerformanceModel.js';
import dotenv from 'dotenv';

// Lazy getters — models must be accessed after DB is connected
const ActiveTrade       = () => getActiveTradeModel();
const TradePerformance  = () => getCondorTradePerformanceModel();

const emitLog = (msg, level = "info") => {
  console.log(msg);
  const io = getIO();
  if (io) io.emit("trade_log", { msg, level, strategy: "CONDOR", time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) });
};

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
// 💰 FETCH CYCLE BUFFER FROM MONGODB
// Walk backwards through history — STOP at last STOP_LOSS_HIT.
// Only profits from the CURRENT cycle (since last SL) count as buffer.
// Example (newest first):
//   PROFIT +400  ← include
//   PROFIT +200  ← include
//   SL_HIT -300  ← STOP. Older profits belong to previous cycle.
//   PROFIT +500  ← ignored
// Buffer = (400 + 200) / lotSize
// ==========================================
const fetchHistoricalBuffer = async (index, lotSize) => {
    try {
        // Fetch last 20 trades for this index newest first
        const recentTrades = await TradePerformance().find({ index })
            .sort({ createdAt: -1 })
            .limit(20);

        if (!recentTrades || recentTrades.length === 0) {
            emitLog(`ℹ️ No trade history for ${index}. Buffer = 0`, "info");
            return 0;
        }

        // Walk backwards. Group by activeTradeId.
        // Stop the moment we hit a STOP_LOSS_HIT record.
        // This means:
        //   - Firefight rolls within the SAME activeTradeId are included together
        //   - Once any trade (any ID) has a SL hit, we stop — that's the cycle boundary
        // Example (newest first):
        //   TradeB: PROFIT +400  ← include (different ID, but still same cycle — no SL yet)
        //   TradeA: PROFIT +200  ← include
        //   TradeX: SL_HIT -300  ← STOP. Everything older is a previous cycle.
        //   TradeW: PROFIT +500  ← ignored

        let cycleProfit = 0;
        for (const trade of recentTrades) {
            if (trade.exitReason === 'STOP_LOSS_HIT') {
                emitLog(`🛑 Buffer boundary: SL hit on trade ${trade.activeTradeId} (${trade.createdAt.toDateString()}). Stopping.`, "info");
                break;
            }
            if (trade.exitReason === 'PROFIT_TARGET' || trade.exitReason === 'MANUAL_CLOSE') {
                cycleProfit += trade.realizedPnL;
                emitLog(`  ✅ Including trade ${trade.activeTradeId}: +₹${trade.realizedPnL.toFixed(2)}`, "info");
            }
        }

        const bufferPoints = Math.max(0, cycleProfit / lotSize);
        emitLog(`💰 Cycle buffer for ${index}: ₹${cycleProfit.toFixed(2)} = ${bufferPoints.toFixed(2)} pts`, "info");

        if (bufferPoints > 0) {
            sendCondorAlert(
                `💰 <b>Buffer Loaded (Cycle Profit)</b>\n` +
                `Index: ${index}\n` +
                `Profit since last SL: ₹${cycleProfit.toFixed(2)}\n` +
                `Buffer Points: ${bufferPoints.toFixed(2)}`
            );
        } else {
            emitLog(`ℹ️ Last trade was SL or no profits in current cycle. Buffer = 0`, "info");
        }

        return bufferPoints;
    } catch (err) {
        emitLog(`❌ Error fetching historical buffer:: ${err.message}`, "error");
        return 0;
    }
};

// ==========================================
// 🛡️ 2. LIVE RISK & DECAY MONITOR
// ==========================================
export const monitorCondorLevels = async () => {
    const activeTrade = await ActiveTrade().findOne({ status: 'ACTIVE' });
    if (!activeTrade) return;

    const idx = activeTrade.index;
    const getLtp = (sym) => sym ? condorPrices[kiteToFyersSymbol(sym, idx)] || 0 : 0;
    const spotLTP = condorPrices[getFyersIndexSymbol(idx)] || 0;

    const currentCallNet = activeTrade.symbols.callSell
        ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy))
        : 0;
    const currentPutNet = activeTrade.symbols.putSell
        ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy))
        : 0;

    let stateChanged = false;
    const { isIronButterfly, tradeType, callSpreadEntryPremium, putSpreadEntryPremium, totalEntryPremium, bufferPremium } = activeTrade;

    // --- 🎯 70% DECAY ALERTS ---
    if (!activeTrade.alertsSent.call70Decay && tradeType !== 'PUT_SPREAD' && currentCallNet > 0 && currentCallNet <= (callSpreadEntryPremium * 0.3)) {
        sendCondorAlert(`🟢 <b>70% DECAY: ${idx} CALL</b>\nEntry: ₹${callSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentCallNet.toFixed(2)}\nRadar Activated.`);
        activeTrade.alertsSent.call70Decay = true;
        stateChanged = true;
    }

    if (!activeTrade.alertsSent.put70Decay && tradeType !== 'CALL_SPREAD' && currentPutNet > 0 && currentPutNet <= (putSpreadEntryPremium * 0.3)) {
        sendCondorAlert(`🟢 <b>70% DECAY: ${idx} PUT</b>\nEntry: ₹${putSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentPutNet.toFixed(2)}\nRadar Activated.`);
        activeTrade.alertsSent.put70Decay = true;
        stateChanged = true;
    }

    // --- 🚨 DEFENSIVE RADAR TRIGGER ---
    const callStrike = extractBaseSymbol(activeTrade.symbols.callSell)?.strike;
    const putStrike = extractBaseSymbol(activeTrade.symbols.putSell)?.strike;

    if (spotLTP && !isIronButterfly) {
        if (callStrike && spotLTP >= callStrike && !activeTrade.alertsSent.callDefense) {
            sendCondorAlert(`⚠️ <b>DEFENSE ALERT: ${idx} CALL</b>\nSpot (${spotLTP}) has reached Short Strike (${callStrike}).\nScanning for Iron Butterfly conversion...`);
            activeTrade.alertsSent.callDefense = true;
            stateChanged = true;
        } else if (putStrike && spotLTP <= putStrike && !activeTrade.alertsSent.putDefense) {
            sendCondorAlert(`⚠️ <b>DEFENSE ALERT: ${idx} PUT</b>\nSpot (${spotLTP}) has reached Short Strike (${putStrike}).\nScanning for Iron Butterfly conversion...`);
            activeTrade.alertsSent.putDefense = true;
            stateChanged = true;
        }
    }

    if (stateChanged) await activeTrade.save();

    // --- 📡 RADAR SCANNER ---
    if ((activeTrade.alertsSent.call70Decay || activeTrade.alertsSent.put70Decay || activeTrade.alertsSent.callDefense || activeTrade.alertsSent.putDefense) && !isIronButterfly && spotLTP) {
        if (Date.now() - lastScanTime > 5000) {
            lastScanTime = Date.now();
            await scanForRoll(activeTrade, spotLTP);
        }
    }

    // --- 🚨 STOP LOSS LOGIC ---
    let triggerExit = false;
    let exitReason = '';
    let slHitSide = null; // track which side hit SL for new trade creation

    const currentTotalValue = currentCallNet + currentPutNet;

    if (isIronButterfly) {
        // 🦋 IRON BUTTERFLY SL = totalEntryPremium * 3 + bufferPremium
        // 4-leg exit together, so 3x on combined premium is the risk limit
        const maxLossLimit = (totalEntryPremium * 3) + bufferPremium;

        if (currentTotalValue >= maxLossLimit) {
            triggerExit = true;
            exitReason = `Iron Butterfly SL Hit (Limit: ₹${maxLossLimit.toFixed(2)} | Current: ₹${currentTotalValue.toFixed(2)})`;
        }
    } else {
        // 🦅 STANDARD CONDOR: single side exit only, so 4x on that spread premium
        const callSL = (callSpreadEntryPremium * 4) + bufferPremium;
        const putSL  = (putSpreadEntryPremium  * 4) + bufferPremium;

        if (tradeType !== 'PUT_SPREAD' && currentCallNet >= callSL) {
            triggerExit = true;
            slHitSide = 'CALL';
            exitReason = `CALL SL Hit (Current: ₹${currentCallNet.toFixed(2)} | Limit: ₹${callSL.toFixed(2)})`;
        } else if (tradeType !== 'CALL_SPREAD' && currentPutNet >= putSL) {
            triggerExit = true;
            slHitSide = 'PUT';
            exitReason = `PUT SL Hit (Current: ₹${currentPutNet.toFixed(2)} | Limit: ₹${putSL.toFixed(2)})`;
        }
    }

    if (triggerExit && activeTrade.status === 'ACTIVE') {
        activeTrade.status = 'EXITING';
        await activeTrade.save();
        sendCondorAlert(`🚨 <b>STOP LOSS TRIGGERED: ${idx}</b>\nReason: ${exitReason}\nExecuting margin-safe exit...`);
        await executeMarketExit(activeTrade);

        // Mark as COMPLETED after exit
        activeTrade.status = 'COMPLETED';
        activeTrade.slHitSide = slHitSide; // track for new trade creation
        await activeTrade.save();

        // Notify: if one side hit SL, alert to enter new spread on that side
        if (slHitSide && tradeType === 'IRON_CONDOR') {
            sendCondorAlert(
                `📋 <b>SL Hit: ${slHitSide} Side</b>\n` +
                `Other side still open.\n` +
                `When you enter a new ${slHitSide} spread on Kite,\n` +
                `the bot will auto-detect it as a NEW Iron Condor.\n` +
                `Buffer will be loaded from MongoDB history.`
            );
        }
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
        const spreadDistance = isNifty
            ? parseInt(process.env.NIFTY_SPREAD_DISTANCE || 150)
            : parseInt(process.env.SENSEX_SPREAD_DISTANCE || 500);

        let suggestedRoll = null;
        const baseSymbolInfoCall = extractBaseSymbol(trade.symbols.callSell);
        const baseSymbolInfoPut  = extractBaseSymbol(trade.symbols.putSell);

        // 🦋 MODE 1: DEFENSE (IRON BUTTERFLY CONVERSION)
        if (trade.alertsSent.callDefense || trade.alertsSent.putDefense) {
            const sideToRoll = trade.alertsSent.callDefense ? 'PE' : 'CE';
            const targetShortStrike = trade.alertsSent.callDefense ? baseSymbolInfoCall.strike : baseSymbolInfoPut.strike;
            const targetLongStrike  = sideToRoll === 'PE' ? targetShortStrike - spreadDistance : targetShortStrike + spreadDistance;

            const base     = baseSymbolInfoCall.base;
            const sellKite = `${base}${targetShortStrike}${sideToRoll}`;
            const buyKite  = `${base}${targetLongStrike}${sideToRoll}`;
            const sellFyers = kiteToFyersSymbol(sellKite, trade.index);
            const buyFyers  = kiteToFyersSymbol(buyKite, trade.index);

            const quotes = await getQuotes([sellFyers, buyFyers]);
            let netPremium = 0;
            if (quotes) {
                const sellLTP = quotes.find(q => q.n === sellFyers)?.v?.lp || 0;
                const buyLTP  = quotes.find(q => q.n === buyFyers)?.v?.lp  || 0;
                netPremium = Math.abs(sellLTP - buyLTP);
            }

            suggestedRoll = {
                side: sideToRoll, type: 'DEFENSE',
                sellSymbol: sellKite, buySymbol: buyKite,
                netPremium: netPremium.toFixed(2),
                targetPremium: 'MAX CREDIT',
                isIronButterfly: true, status: 'READY'
            };
        }

        // 🦅 MODE 2: OFFENSE (70% DECAY ROLL INWARD)
        else if (trade.alertsSent.call70Decay || trade.alertsSent.put70Decay) {
            const sideToRoll      = trade.alertsSent.call70Decay ? 'CE' : 'PE';
            const targetPremium   = trade.alertsSent.call70Decay ? trade.putSpreadEntryPremium : trade.callSpreadEntryPremium;
            const currentShortStrike  = sideToRoll === 'CE' ? baseSymbolInfoCall.strike : baseSymbolInfoPut.strike;
            const oppositeShortStrike = sideToRoll === 'CE' ? baseSymbolInfoPut.strike  : baseSymbolInfoCall.strike;
            const base     = baseSymbolInfoCall.base;
            const stepSize = isNifty ? 50 : 100;

            const strikesToScan = [];
            for (let i = 1; i <= 5; i++) {
                let scanShort = sideToRoll === 'CE' ? currentShortStrike - (i * stepSize) : currentShortStrike + (i * stepSize);
                let scanLong  = sideToRoll === 'CE' ? scanShort + spreadDistance : scanShort - spreadDistance;

                if (sideToRoll === 'CE' && scanShort < oppositeShortStrike) break;
                if (sideToRoll === 'PE' && scanShort > oppositeShortStrike) break;

                strikesToScan.push({
                    sellKite:  `${base}${scanShort}${sideToRoll}`,
                    buyKite:   `${base}${scanLong}${sideToRoll}`,
                    sellFyers: kiteToFyersSymbol(`${base}${scanShort}${sideToRoll}`, trade.index),
                    buyFyers:  kiteToFyersSymbol(`${base}${scanLong}${sideToRoll}`,  trade.index)
                });
            }

            if (strikesToScan.length > 0) {
                const allSymbols = strikesToScan.flatMap(s => [s.sellFyers, s.buyFyers]);
                const quotes = await getQuotes(allSymbols);

                if (quotes) {
                    for (const pair of strikesToScan) {
                        const sellLTP    = quotes.find(q => q.n === pair.sellFyers)?.v?.lp || 0;
                        const buyLTP     = quotes.find(q => q.n === pair.buyFyers)?.v?.lp  || 0;
                        const netPremium = Math.abs(sellLTP - buyLTP);

                        if (netPremium >= targetPremium && netPremium <= targetPremium + 1.0) {
                            suggestedRoll = {
                                side: sideToRoll, type: 'OFFENSE',
                                sellSymbol: pair.sellKite, buySymbol: pair.buyKite,
                                netPremium: netPremium.toFixed(2),
                                targetPremium: targetPremium.toFixed(2),
                                isIronButterfly: false, status: 'READY'
                            };
                            break;
                        }
                    }
                }
            }
        }

        if (suggestedRoll) io.emit('roll_suggestion', suggestedRoll);

    } catch (err) {
        emitLog(`❌ Roll Radar Error:: ${err.message}`, "error");
    }
};

// ==========================================
// 🔄 4. KITE POSITION SYNC MANAGER
// Creates NEW ActiveTrade when new positions detected after a COMPLETED trade
// Loads buffer from MongoDB history (cross-day aware)
// ==========================================
export const scanAndSyncOrders = async () => {
    const index = getActiveIndexForToday();
    if (!index) return;

    const kc = getKiteInstance();
    try {
        const positions = await kc.getPositions();
        let activeTrade = await ActiveTrade().findOne({ index, status: 'ACTIVE' });

        const activeIndexPositions = positions.net.filter(
            p => p.tradingsymbol.startsWith(index) && p.quantity !== 0
        );

        // --- 🏁 TRADE COMPLETION (all positions closed) ---
        if (activeIndexPositions.length === 0 && activeTrade) {
            emitLog(`🏁 All positions closed. Finalizing trade...`, "info");
            const totalPnL = positions.net
                .filter(p => p.tradingsymbol.startsWith(index))
                .reduce((sum, p) => sum + p.pnl, 0);

            try {
                await TradePerformance().create({
                    index: index,
                    activeTradeId: activeTrade._id,
                    exitReason: totalPnL >= 0 ? 'PROFIT_TARGET' : 'STOP_LOSS_HIT',
                    realizedPnL: totalPnL,
                    notes: `Strategy: Iron Condor/Butterfly | Final P&L: ₹${totalPnL.toFixed(2)}`
                });
            } catch (dbErr) {
                emitLog(`❌ History Archive Error:: ${dbErr.message}`, "error");
            }

            activeTrade.status = 'COMPLETED';
            activeTrade.exitTime = new Date();
            await activeTrade.save();

            sendCondorAlert(`🏁 <b>Trade Completed: ${index}</b>\nTotal P&L: <b>₹${totalPnL.toLocaleString('en-IN')}</b>`);
            return;
        }

        if (activeIndexPositions.length === 0) return;

        // --- Detect leg structure from Kite positions ---
        let ceSell, ceBuy, peSell, peBuy;
        activeIndexPositions.forEach(p => {
            const isCall = p.tradingsymbol.endsWith('CE');
            const isSell = p.quantity < 0;
            if (isCall  && isSell)  ceSell = p;
            if (isCall  && !isSell) ceBuy  = p;
            if (!isCall && isSell)  peSell = p;
            if (!isCall && !isSell) peBuy  = p;
        });

        let isButterflyNow = false;
        if (ceSell && peSell) {
            const callStrike = extractBaseSymbol(ceSell.tradingsymbol)?.strike;
            const putStrike  = extractBaseSymbol(peSell.tradingsymbol)?.strike;
            if (callStrike === putStrike) isButterflyNow = true;
        }

        const tradeType  = (ceSell && peSell) ? 'IRON_CONDOR' : ceSell ? 'CALL_SPREAD' : 'PUT_SPREAD';
        const callNet    = ceSell && ceBuy ? Math.abs(ceSell.average_price - ceBuy.average_price) : 0;
        const putNet     = peSell && peBuy ? Math.abs(peSell.average_price - peBuy.average_price) : 0;
        const lotSize    = Math.abs(ceSell?.quantity || peSell?.quantity || 65);
        const spotToken  = 256265; // NIFTY spot token (default)

        // ================================================================
        // 🆕 NEW TRADE CREATION
        // Fires when:
        //   A) No activeTrade exists at all, OR
        //   B) Previous trade is COMPLETED and new positions detected
        //      (e.g. you entered a new spread after an SL hit)
        // Buffer is loaded from MongoDB history so cross-day profits count
        // ================================================================
        const lastTrade = await ActiveTrade().findOne({ index }).sort({ createdAt: -1 });
        const shouldCreateNew = !activeTrade && activeIndexPositions.length > 0 &&
            (!lastTrade || lastTrade.status === 'COMPLETED');

        if (shouldCreateNew) {
            emitLog(`🆕 New positions detected for ${index}. Creating new ActiveTrade...`, "info");

            // Load buffer from MongoDB — includes all previous PROFIT_TARGET trades
            const historicalBuffer = await fetchHistoricalBuffer(index, lotSize);

            // Also add today's intraday closed PnL (e.g. from the rolled/closed leg today)
            const todayClosedPnL = positions.net
                .filter(p => p.tradingsymbol.startsWith(index) && p.quantity === 0 &&
                    (p.day_buy_quantity > 0 || p.day_sell_quantity > 0))
                .reduce((sum, p) => sum + (p.realised || p.pnl || 0), 0);
            const todayBuffer = Math.max(0, todayClosedPnL / lotSize);

            // Total buffer = historical (from MongoDB) + today's intraday booked profit
            const totalBuffer = historicalBuffer + todayBuffer;

            emitLog(`📊 Buffer breakdown: Historical=${historicalBuffer.toFixed(2)} + Today=${todayBuffer.toFixed(2)} = Total=${totalBuffer.toFixed(2)}`, "info");

            const newTrade = await ActiveTrade().create({
                index,
                status: 'ACTIVE',
                tradeType,
                isIronButterfly: isButterflyNow,
                bufferPremium: totalBuffer,
                lotSize,
                callSpreadEntryPremium: callNet,
                putSpreadEntryPremium:  putNet,
                totalEntryPremium: callNet + putNet,
                alertsSent: {
                    call70Decay: false,
                    put70Decay: false,
                    firefightAlert: false
                },
                symbols: {
                    callSell: ceSell?.tradingsymbol || null,
                    callBuy:  ceBuy?.tradingsymbol  || null,
                    putSell:  peSell?.tradingsymbol || null,
                    putBuy:   peBuy?.tradingsymbol  || null,
                },
                tokens: {
                    spotIndex: spotToken,
                }
            });

            emitLog(`✅ New ActiveTrade created: ${newTrade._id}`, "info");
            sendCondorAlert(
                `🆕 <b>New Iron Condor Detected: ${index}</b>\n` +
                `Type: ${tradeType}\n` +
                `Call Spread: ₹${callNet.toFixed(2)}\n` +
                `Put Spread: ₹${putNet.toFixed(2)}\n` +
                `Buffer (from history): ${totalBuffer.toFixed(2)} pts\n` +
                `Butterfly: ${isButterflyNow ? 'YES 🦋' : 'NO'}`
            );
            return;
        }

        // --- UPDATE EXISTING ACTIVE TRADE ---
        if (activeTrade) {
            const needsUpdate =
                activeTrade.symbols.callSell !== (ceSell?.tradingsymbol || null) ||
                activeTrade.isIronButterfly  !== isButterflyNow;

            if (needsUpdate) {
                // Today's intraday realized PnL from closed legs (rolls etc.)
                const todayClosedPnL = positions.net
                    .filter(p => p.tradingsymbol.startsWith(index) && p.quantity === 0 &&
                        (p.day_buy_quantity > 0 || p.day_sell_quantity > 0))
                    .reduce((sum, p) => sum + (p.realised || p.pnl || 0), 0);

                // Buffer = intraday booked profit only (historical already baked in at creation)
                activeTrade.bufferPremium      = Math.max(0, todayClosedPnL / lotSize);
                activeTrade.tradeType          = tradeType;
                activeTrade.isIronButterfly    = isButterflyNow;
                activeTrade.callSpreadEntryPremium = callNet || activeTrade.callSpreadEntryPremium;
                activeTrade.putSpreadEntryPremium  = putNet  || activeTrade.putSpreadEntryPremium;
                activeTrade.totalEntryPremium  = activeTrade.callSpreadEntryPremium + activeTrade.putSpreadEntryPremium;
                activeTrade.symbols = {
                    callSell: ceSell?.tradingsymbol || null,
                    callBuy:  ceBuy?.tradingsymbol  || null,
                    putSell:  peSell?.tradingsymbol || null,
                    putBuy:   peBuy?.tradingsymbol  || null,
                };
                await activeTrade.save();

                sendCondorAlert(
                    `✅ <b>Bot Synced: ${index}</b>\n` +
                    `Butterfly Mode: <b>${isButterflyNow ? 'ON 🦋' : 'OFF'}</b>\n` +
                    `Intraday Buffer: <b>${activeTrade.bufferPremium.toFixed(2)} pts</b>`
                );
            }
        }

    } catch (err) {
        emitLog(`❌ Order Monitor Sync Error:: ${err.message}`, "error");
    }
};