import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const kc = new KiteConnect({
  api_key: process.env.KITE_API_KEY,
  redirect_uri: process.env.KITE_REDIRECT_URL
});

let dailyAccessToken = null;

// ==========================================
// LOAD TOKEN (FROM .ENV VIA DOTENV)
// ==========================================
export const loadTokenFromDisk = () => {
  // Directly use the environment variable loaded by dotenv.config()
  const token = process.env.KITE_ACCESS_TOKEN;
  if (token) {
    dailyAccessToken = token;
    kc.setAccessToken(token);
    return token;
  }
  return null;
};

// ==========================================
// SET AND SAVE NEW TOKEN TO .ENV
// ==========================================
export const setAccessToken = (token) => {
  dailyAccessToken = token;
  kc.setAccessToken(token);
  
  const envPath = path.resolve(process.cwd(), ".env");
  let envData = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  
  const key = "KITE_ACCESS_TOKEN";
  const regex = new RegExp(`^${key}=.*`, "m");
  const newLine = `${key}="${token}"`;

  // If the key exists, replace it; otherwise, append it to the end
  envData = regex.test(envData) 
    ? envData.replace(regex, newLine) 
    : envData + (envData.endsWith("\n") ? "" : "\n") + newLine + "\n";

  fs.writeFileSync(envPath, envData, "utf8");
};

export const getKiteInstance = () => {
  if (!dailyAccessToken) loadTokenFromDisk();
  return kc;
};