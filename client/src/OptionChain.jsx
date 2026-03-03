import React, { useState, useEffect } from "react";
import { Layers, Loader2, Trash2, ShoppingCart, ArrowLeft } from "lucide-react";

const ActionablePriceCell = ({ typeCEPE, strike, price, onAddLeg, selectedLegs }) => {
  const isSelected = selectedLegs.some(l => l.strike === strike && l.optionType === typeCEPE);
  return (
    <div className="flex items-center gap-2 justify-center">
      <button onClick={() => onAddLeg("BUY", strike, typeCEPE, price)} className={`px-3 py-1 text-[10px] font-bold rounded ${isSelected ? "bg-blue-600" : "bg-blue-500/20 text-blue-400"}`}>B</button>
      <span className="font-mono font-bold w-12 text-center">{price?.toFixed(2)}</span>
      <button onClick={() => onAddLeg("SELL", strike, typeCEPE, price)} className={`px-3 py-1 text-[10px] font-bold rounded ${isSelected ? "bg-red-600" : "bg-red-500/20 text-red-400"}`}>S</button>
    </div>
  );
};

const OptionChain = ({ onClose }) => {
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiry] = useState("26MAR");
  const [chainData, setChainData] = useState([]);
  const [selectedLegs, setSelectedLegs] = useState([]);
  const [isExecuting, setIsExecuting] = useState(false);

  useEffect(() => {
    const fetchChain = async () => {
      try {
        const res = await fetch(`https://api.mariaalgo.online/api/options/chain?symbol=${symbol}&expiry=${expiry}`);
        const data = await res.json();
        if (data.chain) setChainData(data.chain);
      } catch (err) {}
    };
    fetchChain();
    const itv = setInterval(fetchChain, 5000);
    return () => clearInterval(itv);
  }, [symbol]);

  const handleExecute = async () => {
    if (!window.confirm(`Execute strategy on Zerodha?`)) return;
    setIsExecuting(true);
    try {
      const res = await fetch("https://api.mariaalgo.online/api/trades/execute-basket", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, legs: selectedLegs }),
      });
      if (res.ok) { alert("Execution Success!"); setSelectedLegs([]); }
    } catch (err) { alert("Execution Failed"); }
    finally { setIsExecuting(false); }
  };

  return (
    <div className="h-screen bg-black text-gray-100 p-6 flex flex-col gap-6 overflow-hidden">
      <div className="flex justify-between items-center border-b border-gray-800 pb-4 shrink-0">
        <button onClick={onClose} className="bg-gray-800 px-4 py-2 rounded text-xs font-bold"><ArrowLeft size={14} className="inline mr-2" /> Back</button>
        <div className="flex gap-2 bg-gray-900 p-1 rounded">
          {["NIFTY", "SENSEX"].map(s => <button key={s} onClick={() => setSymbol(s)} className={`px-4 py-1 rounded text-xs font-bold ${symbol === s ? "bg-blue-600" : ""}`}>{s}</button>)}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto bg-[#0a0a0c] border border-gray-800 rounded-xl custom-scrollbar">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-[#0d0d0f] border-b border-gray-800 text-[10px] uppercase text-gray-500">
            <tr><th className="p-4 text-center">Call LTP</th><th className="p-4 text-center">Strike</th><th className="p-4 text-center">Put LTP</th></tr>
          </thead>
          <tbody>
            {chainData.map((row, i) => (
              <tr key={i} className="border-b border-gray-800/50">
                <td><ActionablePriceCell typeCEPE="CE" strike={row.strike} price={row.ce.ltp} onAddLeg={(t, s, o, p) => setSelectedLegs([...selectedLegs, { type: t, strike: s, optionType: o, price: p, qty: symbol === "NIFTY" ? 65 : 10 }])} selectedLegs={selectedLegs} /></td>
                <td className="text-center font-black text-lg text-blue-400 bg-black/30 py-4">{row.strike}</td>
                <td><ActionablePriceCell typeCEPE="PE" strike={row.strike} price={row.pe.ltp} onAddLeg={(t, s, o, p) => setSelectedLegs([...selectedLegs, { type: t, strike: s, optionType: o, price: p, qty: symbol === "NIFTY" ? 65 : 10 }])} selectedLegs={selectedLegs} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedLegs.length > 0 && (
        <div className="p-4 bg-gray-900 border-t border-blue-500/30 shrink-0">
           <button onClick={handleExecute} disabled={isExecuting} className="w-full bg-blue-500 text-black py-4 rounded-xl font-black uppercase">{isExecuting ? "Executing..." : `Execute Basket`}</button>
        </div>
      )}
    </div>
  );
};

export default OptionChain;