import { getKiteInstance } from './kiteService.js';

export const fetchAndCategorizePositions = async () => {
  const kc = getKiteInstance();
  
  try {
    const positions = await kc.getPositions();
    const netPositions = positions.net;

    // Filter for Active Positions (Open Quantity is not 0)
    const activePositions = netPositions.filter(pos => pos.quantity !== 0);

    // Filter for Closed Positions (Quantity is 0, but traded today)
    const closedPositions = netPositions.filter(pos => pos.quantity === 0 && (pos.day_buy_quantity > 0 || pos.day_sell_quantity > 0));

    // 🚨 FIXED: Use 'm2m' or 'realised' instead of 'pnl'
    let intradayRealizedPnL = 0;
    closedPositions.forEach(pos => {
      intradayRealizedPnL += pos.realised || pos.m2m || 0; 
    });

    console.log(`📊 Fetched Positions: ${activePositions.length} Active, ${closedPositions.length} Closed.`);

    return {
      active: activePositions,
      closed: closedPositions,
      intradayRealizedPnL,
      rawNetPositions: netPositions 
    };

  } catch (error) {
    console.error('❌ Error fetching positions from Kite:', error.message);
    throw error;
  }
};