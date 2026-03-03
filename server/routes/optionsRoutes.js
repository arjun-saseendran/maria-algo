import express from 'express';
import fyers from '../config/fyersConfig.js'; // 🚨 NEW: Fetching data from Fyers
import { getFyersIndexSymbol, kiteToFyersSymbol } from '../services/symbolMapper.js';

const router = express.Router();

router.get('/chain', async (req, res) => {
  const symbol = req.query.symbol || 'NIFTY';
  const expiry = req.query.expiry || '26MAR'; 

  try {
    const indexSymbol = getFyersIndexSymbol(symbol);
    
    // 1️⃣ Fetch Spot Price from Fyers
    const spotRes = await fyers.get_quotes(indexSymbol);
    const spotPrice = spotRes.d[0].v.lp;

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

    // 5️⃣ Fetch Quotes from Fyers (Free)
    const quotesRes = await fyers.get_quotes(instruments.join(','));
    const quotes = quotesRes.d;

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