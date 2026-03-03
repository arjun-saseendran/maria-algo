import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client'; 
import { Activity, Shield,  History, TrendingUp, AlertCircle, Crosshair, AlertTriangle } from 'lucide-react';
import logo from './assets/logo.png'

const Dashboard = () => {
  const [condorData, setCondorData] = useState([]);
  const [trafficData, setTrafficData] = useState(null);
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState({ condor: 'OFFLINE', traffic: 'OFFLINE' });
  
  const [rollSuggestion, setRollSuggestion] = useState(null);
  const [isRolling, setIsRolling] = useState(false);

  const fetchData = async () => {
    try {
      const condorRes = await axios.get('https://api.mariaalgo.online/api/trades/active');
      setCondorData(condorRes.data);
      setStatus(prev => ({ ...prev, condor: 'LIVE' }));

      const trafficRes = await axios.get('https://api.mariaalgo.online/api/status');
      setTrafficData(trafficRes.data);
      setStatus(prev => ({ ...prev, traffic: 'LIVE' }));

      const historyRes = await axios.get('https://api.mariaalgo.online/api/history');
      setHistory(historyRes.data);
    } catch (err) {
      console.error("Dashboard Sync Error:", err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000); 

    const socket = io('https://api.mariaalgo.online'); 

    socket.on('connect', () => console.log('🟢 Live Radar Connected'));
    
    socket.on('roll_suggestion', (data) => {
      setRollSuggestion(data);
    });

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, []);

  const handleExecuteRoll = async () => {
    if (!rollSuggestion || isRolling) return;
    setIsRolling(true);
    try {
      await axios.post('https://api.mariaalgo.online/api/trades/execute-roll', { rollData: rollSuggestion });
      setRollSuggestion(null); 
      alert("✅ Roll Executed Successfully!");
    } catch (error) {
      console.error("Roll Execution Failed:", error);
      alert("❌ Failed to execute roll. Check logs.");
    } finally {
      setIsRolling(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 p-6 font-sans">
      {/* HEADER SECTION */}
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-500 rounded-lg flex items-center justify-center">
            
            <img src={logo} alt="logo" />
            

          </div>
          <h1 className="text-2xl font-bold tracking-tight">MARIA{'     '}<span className='text-emerald-500'>ALGO</span>  <span className="text-emerald-500 text-sm font-normal ml-2">v3.0</span></h1>
        </div>
        <div className="flex gap-4">
          <div className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 ${status.condor === 'LIVE' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/50' : 'bg-red-500/10 text-red-500'}`}>
            <div className={`w-2 h-2 rounded-full ${status.condor === 'LIVE' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            Condor: {status.condor}
          </div>
          <div className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 ${status.traffic === 'LIVE' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/50' : 'bg-red-500/10 text-red-500'}`}>
            <div className={`w-2 h-2 rounded-full ${status.traffic === 'LIVE' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            Traffic: {status.traffic}
          </div>
        </div>
      </div>

      {/* 🧩 LIVE RADAR PANEL (ONLY SHOWS WHEN SUGGESTION EXISTS) */}
      {rollSuggestion && (
        <div className={`mb-8 border-2 rounded-2xl p-6 shadow-2xl relative overflow-hidden transition-all duration-500 ${rollSuggestion.isIronButterfly ? 'bg-yellow-500/10 border-yellow-500/50' : 'bg-blue-500/10 border-blue-500/50'}`}>
          {/* Background Pulse Effect - 🐛 BUG FIXED HERE */}
          <div className={`absolute -top-20 -right-20 w-40 h-40 rounded-full blur-3xl opacity-20 ${rollSuggestion.isIronButterfly ? 'bg-yellow-500' : 'bg-blue-500'} animate-pulse`} />
          
          <div className="flex justify-between items-center relative z-10">
            <div>
              <div className="flex items-center gap-2 mb-2">
                {rollSuggestion.isIronButterfly ? (
                  <AlertTriangle className="text-yellow-500 animate-bounce" size={24} />
                ) : (
                  <Crosshair className="text-blue-400 animate-pulse" size={24} />
                )}
                <h2 className={`text-xl font-black tracking-widest uppercase ${rollSuggestion.isIronButterfly ? 'text-yellow-500' : 'text-blue-400'}`}>
                  {rollSuggestion.isIronButterfly ? "⚠️ IRON BUTTERFLY CONVERSION READY" : "🛡️ ADJUSTMENT RADAR ACTIVE"}
                </h2>
              </div>
              <p className="text-sm text-gray-300">
                {rollSuggestion.isIronButterfly 
                  ? "Market has reached critical levels. Convert to Iron Butterfly to maximize credit protection."
                  : `Rolling untested ${rollSuggestion.side} side down to match original premium.`}
              </p>
            </div>

            <div className="flex items-center gap-8 bg-black/50 p-4 rounded-xl border border-gray-800">
              <div className="text-center">
                <div className="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">New Spread</div>
                <div className="font-mono text-lg font-bold text-gray-200">
                  {rollSuggestion.sellSymbol} <span className="text-gray-600">/</span> {rollSuggestion.buySymbol}
                </div>
              </div>
              <div className="text-center border-l border-gray-800 pl-8">
                <div className="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Target Premium</div>
                <div className="font-mono text-lg font-bold text-emerald-500">
                  ₹{rollSuggestion.targetPremium}
                </div>
              </div>
              <div className="text-center border-l border-gray-800 pl-8">
                <div className="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Live Credit</div>
                <div className="font-mono text-2xl font-black text-emerald-400">
                  ₹{rollSuggestion.netPremium}
                </div>
              </div>
              
              <button 
                onClick={handleExecuteRoll}
                disabled={isRolling}
                className={`ml-6 px-8 py-4 rounded-xl font-black uppercase tracking-widest transition-all ${
                  isRolling 
                    ? 'bg-gray-700 text-gray-500 cursor-not-allowed' 
                    : rollSuggestion.isIronButterfly
                      ? 'bg-yellow-500 text-black hover:bg-yellow-400 hover:scale-105 shadow-[0_0_20px_rgba(234,179,8,0.4)]'
                      : 'bg-blue-500 text-black hover:bg-blue-400 hover:scale-105 shadow-[0_0_20px_rgba(59,130,246,0.4)]'
                }`}
              >
                {isRolling ? 'EXECUTING...' : '1-CLICK ROLL'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* IRON CONDOR LIVE LEGS TABLE */}
      <div className="bg-[#0a0a0c] border border-gray-800 rounded-2xl overflow-hidden mb-8 shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-[#0d0d0f]">
          <div className="flex items-center gap-2 text-gray-400 uppercase text-xs font-bold tracking-widest">
            <Shield size={14} className="text-yellow-500" /> Iron Condor Live Legs
          </div>
          <div className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">
            Index: <span className="text-emerald-500">{condorData[0]?.index || "WAITING..."}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-gray-500 bg-[#0d0d0f]">
                <th className="px-6 py-3 border-r border-gray-800 text-center text-red-400" colSpan="5">Call Side</th>
                <th className="px-6 py-3 border-r border-gray-800 text-center text-emerald-400" colSpan="2">Center</th>
                <th className="px-6 py-3 text-center text-emerald-400" colSpan="5">Put Side</th>
              </tr>
              <tr className="text-[9px] uppercase tracking-tighter text-gray-500 border-b border-gray-800">
                <th className="px-4 py-3 text-center">Entry</th>
                <th className="px-4 py-3 text-center">Firefight</th>
                <th className="px-4 py-3 text-center">Stoploss</th>
                <th className="px-4 py-3 text-center">Booked</th>
                <th className="px-4 py-3 text-center border-r border-gray-800">Profit (70%)</th>
                <th className="px-4 py-3 text-center">Quantity</th>
                <th className="px-4 py-3 text-center border-r border-gray-800">Total Profit</th>
                <th className="px-4 py-3 text-center">Entry</th>
                <th className="px-4 py-3 text-center">Firefight</th>
                <th className="px-4 py-3 text-center">Stoploss</th>
                <th className="px-4 py-3 text-center">Booked</th>
                <th className="px-4 py-3 text-center">Profit (70%)</th>
              </tr>
            </thead>
            <tbody>
              {condorData.length > 0 ? condorData.map((row, i) => (
                <tr key={i} className="hover:bg-white/[0.02] transition-colors border-b border-gray-800/50 last:border-0">
                  <td className="px-4 py-5 text-center font-mono text-sm">{row.call.entry}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm text-red-400">{row.call.firefight}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm">{row.call.sl}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm">{row.call.booked}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm border-r border-gray-800">{row.call.profit70}</td>
                  
                  <td className="px-4 py-5 text-center font-bold text-lg text-emerald-500">{row.quantity}</td>
                  <td className="px-4 py-5 text-center font-bold text-lg text-emerald-400 border-r border-gray-800">₹{row.totalPnL}</td>

                  <td className="px-4 py-5 text-center font-mono text-sm">{row.put.entry}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm text-emerald-400">{row.put.firefight}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm">{row.put.sl}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm">{row.put.booked}</td>
                  <td className="px-4 py-5 text-center font-mono text-sm">{row.put.profit70}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="12" className="py-12 text-center text-gray-600 italic text-sm">Waiting for live positions from Kite API...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MIDDLE SECTION: TRAFFIC LIGHT + SYSTEM INFO */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
        <div className="lg:col-span-2 bg-[#0a0a0c] border border-gray-800 rounded-2xl p-8 flex flex-col items-center justify-center relative shadow-xl min-h-[300px]">
          <div className="absolute top-4 right-6 text-[10px] text-gray-500 uppercase font-bold tracking-widest">Traffic Light</div>
          <Activity className="absolute top-6 left-6 text-blue-500/50" size={24} />
          
          <div className="text-center">
            <h2 className={`text-7xl font-black tracking-tighter mb-2 ${trafficData?.signal === 'ACTIVE' ? 'text-emerald-500' : 'text-gray-200'}`}>
              {trafficData?.signal || 'WAITING'}
            </h2>
            <div className="flex items-center justify-center gap-4 text-gray-500 uppercase text-[10px] font-bold tracking-widest">
              <span>Last Entry: <span className="text-gray-300">₹{trafficData?.entryPrice || '0.00'}</span></span>
              <div className="w-1 h-1 bg-gray-700 rounded-full" />
              <span>Live P&L: <span className={parseFloat(trafficData?.livePnL) >= 0 ? 'text-emerald-500' : 'text-red-500'}>₹{trafficData?.livePnL || '0.00'}</span></span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 w-full mt-12 border-t border-gray-800/50 pt-8">
            <div className="text-center">
              <div className="text-[9px] text-gray-600 uppercase font-bold mb-1 tracking-widest">Breakout Range</div>
              <div className="text-xs font-mono text-gray-400">H: {trafficData?.breakoutHigh || '---'} | L: {trafficData?.breakoutLow || '---'}</div>
            </div>
            <div className="text-center border-l border-gray-800">
              <div className="text-[9px] text-gray-600 uppercase font-bold mb-1 tracking-widest">Runtime</div>
              <div className="text-xs font-bold text-emerald-500">Active Scan</div>
            </div>
          </div>
        </div>

        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-6 flex flex-col justify-between shadow-lg">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="text-emerald-500" size={18} />
              <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-500/80">Market Insight</h3>
            </div>
            <p className="text-sm text-gray-400 leading-relaxed mb-4">
              System is currently scanning NIFTY 3-minute candles. Spread strategy is protecting credit with a 4x stoploss buffer.
            </p>
          </div>
          <div className="bg-black/40 rounded-xl p-4 border border-emerald-500/10">
            <div className="text-[10px] text-gray-500 uppercase font-bold mb-1 tracking-widest">Current Lot Size</div>
            <div className="text-lg font-bold">NIFTY: 65 <span className="text-xs font-normal text-gray-600 ml-2">(Default: 5 Lots)</span></div>
          </div>
        </div>
      </div>

      {/* NEW: TRADE HISTORY SECTION */}
      <div className="bg-[#0a0a0c] border border-gray-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-2 bg-[#0d0d0f]">
          <History size={16} className="text-blue-400" />
          <div className="text-gray-400 uppercase text-xs font-bold tracking-widest">Recent Performance (Last 5 Trades)</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-gray-500 bg-[#0d0d0f] border-b border-gray-800">
                <th className="px-6 py-3">Strategy</th>
                <th className="px-6 py-3">Symbol</th>
                <th className="px-6 py-3">Entry Price</th>
                <th className="px-6 py-3">Exit Price</th>
                <th className="px-6 py-3">Exit Reason</th>
                <th className="px-6 py-3 text-right">Net P&L</th>
              </tr>
            </thead>
            <tbody>
              {history.length > 0 ? history.map((trade, i) => (
                <tr key={i} className="hover:bg-white/[0.02] border-b border-gray-800/50 last:border-0 transition-colors">
                  <td className="px-6 py-4">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${trade.symbol.includes('CONDOR') ? 'bg-yellow-500/10 text-yellow-500' : 'bg-blue-500/10 text-blue-500'}`}>
                      {trade.symbol.includes('CONDOR') ? 'IRON CONDOR' : 'TRAFFIC LIGHT'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-xs font-mono text-gray-400">{trade.symbol}</td>
                  <td className="px-6 py-4 text-xs font-mono tracking-tighter">₹{trade.price.toFixed(2)}</td>
                  <td className="px-6 py-4 text-xs font-mono tracking-tighter">₹{trade.exitPrice?.toFixed(2) || '---'}</td>
                  <td className="px-6 py-4">
                    <span className="text-[10px] text-gray-500 font-medium italic">
                      {trade.exitReason || "Standard Exit"}
                    </span>
                  </td>
                  <td className={`px-6 py-4 text-right font-bold font-mono text-sm ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {trade.pnl >= 0 ? '+' : ''}₹{trade.pnl.toFixed(2)}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="6" className="py-8 text-center text-gray-600 text-xs italic">No trade history available yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      <div className="mt-6 flex justify-between items-center px-2">
        <div className="flex items-center gap-2 text-[10px] text-gray-600 uppercase font-bold tracking-widest">
          <AlertCircle size={12} /> Algo Server Status: <span className="text-emerald-500/80">All Systems Nominal</span>
        </div>
        <div className="text-[10px] text-gray-700 font-mono">
          Last Sync: {new Date().toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;