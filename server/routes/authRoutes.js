import express from "express";
import {
  loginFyers,
  fyersCallback,
  getProfile,
  getQuotes,
} from "../controllers/fyersControllers.js";
import { getKiteInstance, setAccessToken } from "../services/kiteService.js";

const router = express.Router();

// ─── Fyers Routes (shared login — serves both strategies) ─────────────────────
router.get("/fyers/login",    loginFyers);
router.get("/fyers/callback", fyersCallback);
router.get("/fyers/profile",  getProfile);
router.get("/fyers/quotes",   getQuotes);

// ─── Zerodha/Kite Routes (Iron Condor order execution) ───────────────────────
router.get("/zerodha/login", (req, res) => {
  try {
    const loginUrl = getKiteInstance().getLoginURL();
    console.log("🔗 Redirecting to Zerodha login...");
    res.redirect(loginUrl);
  } catch (error) {
    console.error("❌ Kite Login URL error:", error.message);
    res.status(500).json({ error: "Could not generate login URL" });
  }
});

router.get("/zerodha/callback", async (req, res) => {
  const requestToken = req.query.request_token;
  if (!requestToken) {
    return res.status(400).json({ error: "No request_token in callback URL" });
  }
  try {
    const response = await getKiteInstance().generateSession(
      requestToken,
      process.env.KITE_API_SECRET
    );
    setAccessToken(response.access_token);
    console.log("✅ Kite session created.");
    res.status(200).json({
      status: "success",
      message: "Kite authenticated! Iron Condor order service is now active.",
      user: response.user_name,
    });
  } catch (error) {
    console.error("❌ Kite Auth Error:", error.message);
    res.status(500).json({ error: "Kite authentication failed", details: error.message });
  }
});

export default router;
