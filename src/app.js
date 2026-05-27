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
