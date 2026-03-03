import mongoose from 'mongoose';

const activeTradeSchema = new mongoose.Schema({
  index: { type: String, required: true },
  status: { 
    type: String, 
    default: 'ACTIVE', 
    enum: ['ACTIVE', 'MANUAL_OVERRIDE', 'EXITING', 'EXITED', 'FAILED_EXIT', 'COMPLETED'] 
  },
  tradeType: { 
    type: String, 
    enum: ['IRON_CONDOR', 'CALL_SPREAD', 'PUT_SPREAD'], 
    required: true 
  },
  isIronButterfly: { type: Boolean, default: false }, 
  bufferPremium: { type: Number, default: 0 }, 
  lotSize: { type: Number, required: true }, 
  callSellStrike: { type: Number },
  putSellStrike: { type: Number },
  callSpreadEntryPremium: { type: Number, default: 0 },
  putSpreadEntryPremium: { type: Number, default: 0 },
  totalEntryPremium: { type: Number, required: true },
  alertsSent: {
    call70Decay: { type: Boolean, default: false },
    put70Decay: { type: Boolean, default: false },
    firefightAlert: { type: Boolean, default: false }
  },
  symbols: {
    callSell: String, callBuy: String, putSell: String, putBuy: String
  },
  tokens: {
    spotIndex: { type: Number, required: true },
    callSell: Number, callBuy: Number, putSell: Number, putBuy: Number
  }
}, { timestamps: true });

// --- THE FIX: PREVENTS OVERWRITEMODELERROR ---
// This checks if the model is already in Mongoose's internal cache
const ActiveTrade = mongoose.models.ActiveTrade || mongoose.model('ActiveTrade', activeTradeSchema);

export default ActiveTrade;