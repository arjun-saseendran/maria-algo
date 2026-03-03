import { useState, useEffect } from "react";
import { Activity, Shield, History, TrendingUp, AlertCircle, Layers } from "lucide-react";
import io from "socket.io-client";
import OptionChain from "./OptionChain";
import logo from "./assets/logo.png";

const socket = io("https://api.mariaalgo.online");

const Dashboard = () => {
  const [activeTab, setActiveTab] = useState("system");
  const [condorData, setCondorData] = useState([]);
  const [trafficData, setTrafficData] = useState({ signal: "WAITING", livePnL: "0.00" });
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const fetchAllData = async () => {
      try {
        const [trafficRes, condorRes, historyRes] = await Promise.all([
          fetch("https://api.mariaalgo.online/api/traffic/status"),
          fetch("https://api.mariaalgo.online/api/condor/positions"),
          fetch("https://api.mariaalgo.online/api/history")
        ]);
        if (trafficRes.ok) setTrafficData(await trafficRes.json());
        if (condorRes.ok) setCondorData(await condorRes.json());
        if (historyRes.ok) setHistory(await historyRes.json());
      } catch (err) { console.error("❌ Data Sync Error:", err); }
    };
    fetchAllData();
    const interval = setInterval(fetchAllData, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    socket.on("market_tick", (data) => {
      setTrafficData((prev) => {
        if (prev.signal !== "ACTIVE") return prev;
        const pts = prev.direction === "CE" ? data.price - prev.entryPrice : prev.entryPrice - data.price;
        return { ...prev, livePnL: (pts * 65).toFixed(2) };
      });
    });
    return () => socket.off("market_tick");
  }, []);

  if (activeTab === "options") return <OptionChain onClose={() => setActiveTab("system")} />;

  return (
    <div className="min-h-screen bg-black text-gray-100 p-6 font-sans">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Logo" className="w-10 h-10 bg-emerald-500 rounded-lg p-1" />
          <h1 className="text-2xl font-bold uppercase">Maria <span className="text-emerald-500">Algo</span></h1>
        </div>
      </div>

      <div className="bg-[#0a0a0c] border border-gray-800 rounded-2xl overflow-hidden mb-8 shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-4 text-xs font-bold uppercase tracking-widest text-gray-400">
           <Shield size={14} className="text-yellow-500" /> Live Iron Condor Legs
        </div>
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase text-gray-500 border-b border-gray-800">
            <tr>
              <th className="py-3 text-center">Side</th><th className="py-3 text-center">Entry</th>
              <th className="py-3 text-center">Live</th><th className="py-3 text-center">Stoploss</th>
              <th className="py-3 text-center">Qty</th><th className="py-3 text-right">PnL</th>
            </tr>
          </thead>
          <tbody>
            {condorData.map((row, i) => (
              <React.Fragment key={i}>
                <tr className="border-b border-gray-800/50">
                   <td className="py-4 text-center text-red-400 text-xs font-bold">CALL</td>
                   <td className="text-center font-mono text-sm">₹{row.call.entry}</td>
                   <td className="text-center font-mono text-sm">₹{row.call.current}</td>
                   <td className="text-center font-mono text-sm">₹{row.call.sl}</td>
                   <td className="text-center font-bold" rowSpan="2">{row.quantity}</td>
                   <td className="text-right font-black text-emerald-400 text-lg" rowSpan="2">₹{row.totalPnL}</td>
                </tr>
                <tr>
                   <td className="py-4 text-center text-emerald-400 text-xs font-bold">PUT</td>
                   <td className="text-center font-mono text-sm">₹{row.put.entry}</td>
                   <td className="text-center font-mono text-sm">₹{row.put.current}</td>
                   <td className="text-center font-mono text-sm">₹{row.put.sl}</td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-8 border-b border-gray-800 mb-8 px-4">
        <button onClick={() => setActiveTab("system")} className={`pb-4 text-[11px] font-black uppercase tracking-widest ${activeTab === "system" ? "text-emerald-500 border-b-2 border-emerald-500" : "text-gray-500"}`}>
          <Activity size={14} className="inline mr-2" /> Traffic Light
        </button>
        <button onClick={() => setActiveTab("options")} className={`pb-4 text-[11px] font-black uppercase tracking-widest ${activeTab === "options" ? "text-blue-500 border-b-2 border-blue-500" : "text-gray-500"}`}>
          <Layers size={14} className="inline mr-2" /> Strategy Builder
        </button>
      </div>

      {activeTab === "system" && (
        <div className="lg:col-span-2 bg-[#0a0a0c] border border-gray-800 rounded-2xl p-12 text-center shadow-xl">
           <h2 className={`text-8xl font-black mb-4 ${trafficData.signal === "ACTIVE" ? "text-emerald-500" : "text-gray-600"}`}>{trafficData.signal}</h2>
           <div className="text-emerald-400 font-mono text-2xl font-bold">Live P&L: ₹{trafficData.livePnL}</div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;