import mongoose from 'mongoose';

const dailyStatusSchema = new mongoose.Schema({
  date: { 
    type: String, 
    required: true, 
    unique: true // Format: "YYYY-MM-DD"
  },
  tradeTakenToday: { 
    type: Boolean, 
    default: false 
  },
  breakoutHigh: {
    type: Number,
    default: null
  },
  breakoutLow: {
    type: Number,
    default: null
  }
});

export const DailyStatus = mongoose.model('DailyStatus', dailyStatusSchema);