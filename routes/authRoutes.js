import express from "express";
import {
  loginFyers,
  fyersCallback,
  getProfile,
  getQuotes,
} from "../controllers/fyersControllers.js";
import { 
  loginKite, 
  kiteCallback 
} from "../controllers/kiteControllers.js";

const router = express.Router();

// ─── Fyers Routes (shared login — serves both strategies) ─────────────────────
router.get("/fyers/login",    loginFyers);
router.get("/fyers/callback", fyersCallback);
router.get("/fyers/profile",  getProfile);
router.get("/fyers/quotes",   getQuotes);

// ─── Zerodha/Kite Routes (Iron Condor order execution) ───────────────────────
router.get("/zerodha/login",    loginKite);
router.get("/zerodha/callback", kiteCallback);

export default router;