import express from 'express';
// ✅ IMPORT THE NEW V3 HELPER
import { getQuotes } from '../config/fyersConfig.js'; 
import { getFyersIndexSymbol, kiteToFyersSymbol } from '../services/symbolMapper.js';

const router = express.Router();

router.get('/chain', async (req, res) => {
  const symbol = req.query.symbol || 'NIFTY';
  const expiry = req.query.expiry || '26MAR'; 

  try {
    const indexSymbol = getFyersIndexSymbol(symbol);
    
    // 1️⃣ Fetch Spot Price from Fyers (Using new V3 Helper)
    const spotData = await getQuotes(indexSymbol);
    
    // Safety check in case the API returns null
    if (!spotData || spotData.length === 0) {
        return res.status(500).json({ error: "Failed to fetch Spot Price" });
    }
    
    // Extract the Last Traded Price (lp)
    const spotPrice = spotData[0].v.lp;

    // 2️⃣ Calculate ATM Strike
    const step = symbol === 'NIFTY' ? 50 : 100;
    const atmStrike = Math.round(spotPrice / step) * step;

    // 3️⃣ Generate Strikes
    const strikes = [];
    for (let i = -10; i <= 10; i++) {
      strikes.push(atmStrike + (i * step));
    }

    // 4️⃣ Construct Fyers Symbols
    const instruments = [];
    strikes.forEach(strike => {
      instruments.push(kiteToFyersSymbol(`${symbol}${expiry}${strike}CE`, symbol));
      instruments.push(kiteToFyersSymbol(`${symbol}${expiry}${strike}PE`, symbol));
    });

    // 5️⃣ Fetch Quotes from Fyers (Using new V3 Helper)
    const quotes = await getQuotes(instruments.join(','));
    
    if (!quotes) {
         return res.status(500).json({ error: "Failed to fetch Options Quotes" });
    }

    // 6️⃣ Format for React UI
    const formattedChain = strikes.map(strike => {
      const ceSym = kiteToFyersSymbol(`${symbol}${expiry}${strike}CE`, symbol);
      const peSym = kiteToFyersSymbol(`${symbol}${expiry}${strike}PE`, symbol);
      
      const ceData = quotes.find(q => q.n === ceSym)?.v || { lp: 0, oi: 0, vol: 0 };
      const peData = quotes.find(q => q.n === peSym)?.v || { lp: 0, oi: 0, vol: 0 };

      return {
        strike: strike,
        ce: {
          ltp: ceData.lp,
          oi: ceData.oi ? (ceData.oi / 100000).toFixed(1) + 'L' : '0L',
          vol: ceData.vol ? (ceData.vol / 1000).toFixed(1) + 'K' : '0K'
        },
        pe: {
          ltp: peData.lp,
          oi: peData.oi ? (peData.oi / 100000).toFixed(1) + 'L' : '0L',
          vol: peData.vol ? (peData.vol / 1000).toFixed(1) + 'K' : '0K'
        }
      };
    });

    res.json({ spotPrice, atmStrike, chain: formattedChain });
  } catch (error) {
    console.error("❌ Fyers Option Chain Error:", error.message);
    res.status(500).json({ error: "Failed to fetch from Fyers API" });
  }
});

export default router;