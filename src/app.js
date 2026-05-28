require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./database/sqlite');
const { fetchOrders } = require('./scraper/orders');
const { processOrders } = require('./services/rulesEngine');
const { sendTelegramAlert } = require('./services/telegram');
const { startScheduler } = require('./scheduler/cron');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const logFilePath = path.join(logsDir, 'app.log');

// Log formatting helper
function log(task, status, duration = null, error = null) {
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] Task: ${task} | Status: ${status}`;
  if (duration !== null) logLine += ` | Duration: ${duration}ms`;
  if (error !== null) logLine += ` | Error: ${error.message || error}`;
  logLine += '\n';

  // Print out to console
  console.log(logLine.trim());

  // Append entry to logs/app.log file
  fs.appendFileSync(logFilePath, logLine, 'utf8');
}

async function runSingleCycle() {
  const startTime = Date.now();
  log('FetchOrdersCycle', 'STARTED');

  try {
    // 1. Fetch pending orders using Playwright (Network interception or DOM scraping fallback)
    const orders = await fetchOrders();
    const fetchDuration = Date.now() - startTime;
    log('FetchOrders', 'SUCCESS', fetchDuration);

    // If 0 orders are found, check if we should send the "All Clear" daily report
    if (orders.length === 0) {
      log('FetchOrders', 'NO_ORDERS_TODAY');
      
      const now = new Date();
      const currentHour = now.getHours();
      const currentMin = now.getMinutes();
      const timeVal = currentHour * 60 + currentMin;
      const targetTimeVal = 10 * 60 + 45; // 10:45 AM (15 mins before Meesho 11:00 AM SLA)

      if (timeVal >= targetTimeVal) {
        const dateStr = now.toISOString().split('T')[0];
        const clearKey = `ClearDay_${dateStr}`;
        const alreadyNotified = await db.hasBeenNotified(clearKey, 'informational');

        if (!alreadyNotified) {
          console.log(`[App] 10:45 AM or later reached. Dispatching "All Clear" notification...`);
          const clearDayAlert = {
            marketplace: 'SmartHUB',
            alertLevel: 'informational',
            orders: [{ orderId: 'All Clear', sku: 'No pending pick lists today' }]
          };
          
          const screenshotPath = path.join(__dirname, '..', 'screenshots', 'dashboard.png');
          try {
            await sendTelegramAlert(clearDayAlert, screenshotPath);
            log('SendTelegramAlert:ClearDay', 'SUCCESS');
          } catch (alertErr) {
            log('SendTelegramAlert:ClearDay', 'FAILED', null, alertErr);
          }
        }
      }
      
      const totalDuration = Date.now() - startTime;
      log('FetchOrdersCycle', 'SUCCESS', totalDuration);
      return Infinity; // Return Infinity since no deadlines are active
    }

    // 2. Process orders through Rules Engine & filter notifications
    const { allActiveAlerts, groupedAlerts } = await processOrders(orders);
    log('RulesEngine', 'SUCCESS');

    // 3. Send alerts for each group
    const screenshotPath = path.join(__dirname, '..', 'screenshots', 'dashboard.png');
    for (const groupAlert of groupedAlerts) {
      try {
        log(`SendTelegramAlert:${groupAlert.marketplace}:${groupAlert.alertLevel}`, 'STARTED');
        // Attach screenshot for critical/urgent/warning events
        const attachScreenshot = groupAlert.alertLevel !== 'informational';
        await sendTelegramAlert(groupAlert, attachScreenshot ? screenshotPath : null);
        log(`SendTelegramAlert:${groupAlert.marketplace}:${groupAlert.alertLevel}`, 'SUCCESS');
      } catch (alertErr) {
        log(`SendTelegramAlert:${groupAlert.marketplace}:${groupAlert.alertLevel}`, 'FAILED', null, alertErr);
      }
    }

    const totalDuration = Date.now() - startTime;
    log('FetchOrdersCycle', 'SUCCESS', totalDuration);

    // Calculate minimum remaining minutes to deadline across all orders
    let minRemainingMins = Infinity;
    orders.forEach(o => {
      const { getTodayTime, slaConfig } = require('./services/rulesEngine');
      if (slaConfig.slas[o.marketplace]) {
        const slaDate = getTodayTime(slaConfig.slas[o.marketplace]);
        const diffMs = slaDate - new Date();
        const remaining = Math.floor(diffMs / (1000 * 60));
        if (remaining > 0 && remaining < minRemainingMins) {
          minRemainingMins = remaining;
        }
      }
    });

    return minRemainingMins;

  } catch (err) {
    const duration = Date.now() - startTime;
    log('FetchOrdersCycle', 'FAILED', duration, err);
    throw err;
  }
}

async function bootstrap() {
  console.log('SmartHUB OMS Shipping Alert Assistant starting...');
  
  try {
    // Initialize Database
    await db.init();
    log('DatabaseInit', 'SUCCESS');

    // Run single cycle on startup
    const minMins = await runSingleCycle();
    
    // Start node-cron scheduler
    startScheduler(runSingleCycle, minMins);

  } catch (err) {
    log('Bootstrap', 'FAILED', null, err);
    process.exit(1);
  }
}

// Start application
bootstrap();
