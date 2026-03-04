import express from 'express';
import { scanAndSyncOrders } from '../services/orderMonitorService.js';
import ActiveTrade from '../models/activeTradeModel.js';
// 🚨 FIXED: Now imports from the Fyers Ticker
import { lastPrices } from '../services/masterDataFeed.js'; 
import { getKiteInstance } from '../services/kiteService.js'; 
import { sendTelegramAlert } from '../services/telegramService.js';
// 🚨 NEW: Import mapper for price lookups
import { kiteToFyersSymbol } from '../services/symbolMapper.js'; 

const router = express.Router();

// --- 1. GET ACTIVE TRADES (FOR DASHBOARD) ---
router.get('/active', async (req, res) => {
  try {
    const trades = await ActiveTrade.find({ status: 'ACTIVE' }); 
    
    const kc = getKiteInstance();
    let netPositions = [];
    try {
        if (kc.access_token) {
            const posResponse = await kc.getPositions();
            netPositions = posResponse.net || [];
        }
    } catch (err) {
        console.error("⚠️ Could not fetch Kite positions for Live P&L:", err.message);
    }

    const liveStats = trades.map(trade => {
      const { symbols, callSpreadEntryPremium, putSpreadEntryPremium, bufferPremium, tradeType, index } = trade;

      // 🚨 FIXED: Lookup prices using Fyers symbols via the mapper
      const getLtp = (sym) => lastPrices[kiteToFyersSymbol(sym, index)] || 0;

      const currentCallNet = tradeType !== 'PUT_SPREAD' && symbols.callSell ? Math.abs(getLtp(symbols.callSell) - getLtp(symbols.callBuy)) : 0;
      const currentPutNet = tradeType !== 'CALL_SPREAD' && symbols.putSell ? Math.abs(getLtp(symbols.putSell) - getLtp(symbols.putBuy)) : 0;

      const indexPositions = netPositions.filter(p => p.tradingsymbol && p.tradingsymbol.startsWith(index));
      const liveKitePnL = indexPositions.reduce((sum, p) => sum + p.pnl, 0);
      
      const callSellPos = indexPositions.find(p => p.tradingsymbol === symbols.callSell);
      const putSellPos = indexPositions.find(p => p.tradingsymbol === symbols.putSell);
      const currentQty = Math.abs(callSellPos?.quantity || putSellPos?.quantity || 0);

      const callSL = (callSpreadEntryPremium * 4) + bufferPremium;
      const putSL = (putSpreadEntryPremium * 4) + bufferPremium;

      return {
        index: index,
        totalPnL: liveKitePnL.toFixed(2), 
        quantity: currentQty,
        bufferPremium: bufferPremium,
        call: {
          entry: callSpreadEntryPremium.toFixed(2),
          firefight: currentCallNet.toFixed(2), 
          sl: callSL.toFixed(2),
          booked: bufferPremium.toFixed(2), 
          profit70: (callSpreadEntryPremium * 0.3).toFixed(2)
        },
        put: {
          entry: putSpreadEntryPremium.toFixed(2),
          firefight: currentPutNet.toFixed(2),
          sl: putSL.toFixed(2),
          booked: bufferPremium.toFixed(2),
          profit70: (putSpreadEntryPremium * 0.3).toFixed(2)
        }
      };
    });

    res.status(200).json(liveStats);
  } catch (error) {
    console.error("❌ API Active Trades Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- 2. MANUAL SYNC ---
router.post('/sync', async (req, res) => {
  try {
    await scanAndSyncOrders(); 
    const activeTrade = await ActiveTrade.findOne({ status: 'ACTIVE' });
    res.status(200).json({ status: 'success', trade: activeTrade });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- 3. 1-CLICK ROLL EXECUTION ---
router.post('/execute-roll', async (req, res) => {
    try {
        const { rollData } = req.body;
        const trade = await ActiveTrade.findOne({ status: 'ACTIVE' });
        if (!trade || !rollData) return res.status(400).json({ error: "Missing data" });

        const kc = getKiteInstance();
        const exchange = trade.index === 'SENSEX' ? 'BFO' : 'NFO';
        const qty = trade.lotSize;

        let oldShort = rollData.side === 'CE' ? trade.symbols.callSell : trade.symbols.putSell;
        let oldLong = rollData.side === 'CE' ? trade.symbols.callBuy : trade.symbols.putBuy;

        // Sequence: Buy back Short -> Sell Long -> Buy New Long -> Sell New Short
        await kc.placeOrder("regular", { exchange, tradingsymbol: oldShort, transaction_type: "BUY", quantity: qty, order_type: "MARKET", product: "NRML" });
        await kc.placeOrder("regular", { exchange, tradingsymbol: oldLong, transaction_type: "SELL", quantity: qty, order_type: "MARKET", product: "NRML" });
        await kc.placeOrder("regular", { exchange, tradingsymbol: rollData.buySymbol, transaction_type: "BUY", quantity: qty, order_type: "MARKET", product: "NRML" });
        await kc.placeOrder("regular", { exchange, tradingsymbol: rollData.sellSymbol, transaction_type: "SELL", quantity: qty, order_type: "MARKET", product: "NRML" });

        if (rollData.side === 'CE') {
            trade.symbols.callSell = rollData.sellSymbol;
            trade.symbols.callBuy = rollData.buySymbol;
            trade.alertsSent.call70Decay = false;
        } else {
            trade.symbols.putSell = rollData.sellSymbol;
            trade.symbols.putBuy = rollData.buySymbol;
            trade.alertsSent.put70Decay = false; 
        }
        await trade.save();
        res.status(200).json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;