require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { fetchOrders } = require('./scraper/orders');
const { sendTelegramAlert } = require('./services/telegram');
const db = require('./database/sqlite');

async function runLiveTest() {
  console.log('\n================================================================');
  console.log('             SMARTHUB LIVE SCRAPER & ALERT TEST                 ');
  console.log('================================================================');

  try {
    // Initialize SQLite database
    await db.init();

    // 1. Fetch live orders across both Create and Active tabs using production scraper in Test Mode!
    const orders = await fetchOrders(true);

    console.log(`\n[Live Test] Extracted ${orders.length} orders across both tabs!`);
    console.log(orders);

    const screenshotPath = path.join(__dirname, '..', 'screenshots', 'dashboard.png');
    const screenshotActivePath = path.join(__dirname, '..', 'screenshots', 'active_dashboard.png');

    if (orders.length === 0) {
      console.log('\n[Info] No active shipping pick lists found for today in the tables.');
      
      // Dispatch the All Clear notification immediately for testing
      const clearDayAlert = {
        marketplace: 'SmartHUB',
        alertLevel: 'informational',
        orders: [{ orderId: 'All Clear', sku: 'No pending pick lists today' }]
      };
      await sendTelegramAlert(clearDayAlert, screenshotPath);
      console.log('SUCCESS! Dispatched "All Clear" status notification.');
      return;
    }

    // 2. Separate lists into Create tab vs Active tab for visual accuracy
    const createOrders = orders.filter(o => !o.isFromActiveTab);
    const activeOrders = orders.filter(o => o.isFromActiveTab);

    // 3. Dispatch Create Tab warnings immediately
    if (createOrders.length > 0) {
      const modifiedAlert = {
        marketplace: 'SmartHUB Create Tab',
        alertLevel: 'critical',
        orders: createOrders
      };
      await sendTelegramAlert(modifiedAlert, screenshotPath);
      console.log('SUCCESS! Dispatched Create tab alert with screenshot.');
    }

    // 4. Dispatch Active Tab warnings immediately
    if (activeOrders.length > 0) {
      const modifiedAlert = {
        marketplace: 'SmartHUB Active Tab',
        alertLevel: 'critical',
        orders: activeOrders
      };
      await sendTelegramAlert(modifiedAlert, screenshotActivePath);
      console.log('SUCCESS! Dispatched Active tab alert with screenshot.');
    }

    console.log('\n================================================================');
    console.log('SUCCESS! Test alert and screenshot dispatched to all recipients.');
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n[Error] Live scraping test failed:', err.message || err);
  }
}

runLiveTest();
