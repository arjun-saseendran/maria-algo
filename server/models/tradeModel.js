import { Schema, model } from "mongoose";

const tradeSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    symbol: String,
    side: {
      type: String,
      enum: ["BUY", "SELL"],
    },
    quantity: Number,
    price: Number,      // Entry Price
    exitPrice: Number,  // Exit Price
    pnl: Number,        // Estimated Profit/Loss
    status: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      default: "OPEN",
    },
  },
  { timestamps: true }
);

export const Trade = model("Trade", tradeSchema);