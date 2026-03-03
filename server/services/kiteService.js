import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const kc = new KiteConnect({
  api_key: process.env.KITE_API_KEY,
  redirect_uri: process.env.KITE_REDIRECT_URL
});

const TOKEN_FILE_PATH = path.join(process.cwd(), 'kite_token.txt');
let dailyAccessToken = null;

export const loadTokenFromDisk = async () => {
  try {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      const savedToken = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
      if (savedToken) {
        dailyAccessToken = savedToken;
        kc.setAccessToken(savedToken);
        console.log(`✅ Loaded Kite Access Token from disk.`);
        
        // --- ADDED: Actual connection validation ---
        await validateKiteSession(); 
        
        return savedToken;
      }
    }
  } catch (err) {
    console.error('❌ Kite Session Invalid:', err.message);
  }
  return null;
};

// NEW: Helper to verify the API is actually "connected"
export const validateKiteSession = async () => {
  try {
    const profile = await kc.getProfile();
    console.log(`📡 Kite API Connected: Welcome, ${profile.user_name} (${profile.user_id})`);
    return true;
  } catch (err) {
    console.error('❌ Kite API Connection Failed:', err.message);
    return false;
  }
};

export const setAccessToken = async (token) => {
  dailyAccessToken = token;
  kc.setAccessToken(token);
  fs.writeFileSync(TOKEN_FILE_PATH, token, 'utf8');
  console.log('✅ New Kite Access Token saved securely to disk.');
  await validateKiteSession();
};

export const getAccessToken = () => {
  if (!dailyAccessToken) return loadTokenFromDisk();
  return dailyAccessToken;
};

export const getKiteInstance = () => {
  if (!dailyAccessToken) loadTokenFromDisk();
  return kc;
};