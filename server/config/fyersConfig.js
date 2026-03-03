import { fyersModel } from "fyers-api-v3";
import fs from "fs";
import path from "path";

if (!process.env.FYERS_APP_ID || !process.env.FYERS_REDIRECT_URI) {
  console.error("❌ FYERS Config Error: Missing FYERS_APP_ID or FYERS_REDIRECT_URI in .env");
  process.exit(1);
}

const logDir = path.resolve("./logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Single Fyers instance — shared by Traffic Light and Iron Condor
const fyers = new fyersModel({ path: logDir, enableLogging: true });

fyers.setAppId(process.env.FYERS_APP_ID);
fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);

// Load token set by autoLogin.js on startup
if (process.env.FYERS_ACCESS_TOKEN) {
  fyers.setAccessToken(process.env.FYERS_ACCESS_TOKEN);
  console.log("✅ Fyers Access Token loaded from .env");
}

// Called by autoLogin.js or fyersCallback after a fresh login
export const setFyersAccessToken = (token) => {
  fyers.setAccessToken(token);
  process.env.FYERS_ACCESS_TOKEN = token;
  console.log("✅ Fyers Access Token set — both strategies ready.");
};

export default fyers;
