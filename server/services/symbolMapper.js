/**
 * Utility to translate between Fyers and Zerodha (Kite) symbols.
 */

// Converts Kite symbol (e.g., "NIFTY24MAR22000CE") to Fyers (e.g., "NSE:NIFTY24MAR22000CE")
export const kiteToFyersSymbol = (kiteSymbol, index = 'NIFTY') => {
    if (!kiteSymbol) return null;
    const prefix = (index === 'SENSEX' || index === 'BANKEX') ? 'BSE' : 'NSE';
    // Fyers uses ":" as a separator
    return `${prefix}:${kiteSymbol}`;
};

// Converts Fyers symbol back to Kite (strips the exchange prefix)
export const fyersToKiteSymbol = (fyersSymbol) => {
    if (!fyersSymbol) return null;
    const parts = fyersSymbol.split(':');
    return parts.length > 1 ? parts[1] : parts[0];
};

// Returns the Fyers Index symbol based on the trading index
export const getFyersIndexSymbol = (index) => {
    if (index === 'SENSEX') return 'BSE:SENSEX-INDEX';
    if (index === 'BANKEX') return 'BSE:BANKEX-INDEX';
    return 'NSE:NIFTY50-INDEX';
};