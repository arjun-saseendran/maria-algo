import axios from 'axios';

/**
 * Sends a formatted HTML message to your Telegram bot.
 * Ensure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are in your .env file.
 */
export const sendTelegramAlert = async (message) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.error("⚠️ Telegram Alert Failed: Missing BOT_TOKEN or CHAT_ID in .env");
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML', // Allows bold <b> and 🚀 emojis
            disable_web_page_preview: true
        });
        console.log("📤 Telegram notification sent.");
    } catch (error) {
        // Detailed error logging to help you troubleshoot connection issues
        if (error.response) {
            console.error(`❌ Telegram API Error: ${error.response.data.description}`);
        } else {
            console.error(`❌ Telegram Network Error: ${error.message}`);
        }
    }
};