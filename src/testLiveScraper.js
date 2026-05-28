require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('./database/sqlite');
const { sendTelegramAlert } = require('./services/telegram');

const authPath = path.join(__dirname, 'storage', 'auth.json');
const screenshotPath = path.join(__dirname, '..', 'screenshots', 'pick_test.png');

// Helper to generate today's date formatted exactly like the cards (e.g., "Wednesday May 27th")
function getTodayDateString() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  
  const today = new Date();
  const dayName = days[today.getDay()];
  const monthName = months[today.getMonth()];
  const date = today.getDate();
  
  // Generate date suffix
  let suffix = 'th';
  if (date === 1 || date === 21 || date === 31) suffix = 'st';
  else if (date === 2 || date === 22) suffix = 'nd';
  else if (date === 3 || date === 23) suffix = 'rd';
  
  return `${dayName} ${monthName} ${date}${suffix}`;
}

async function runLiveTest() {
  console.log('\n================================================================');
  console.log('             SMARTHUB LIVE SCRAPER & ALERT TEST                 ');
  console.log('================================================================');

  if (!fs.existsSync(authPath)) {
    console.error('\n[Error] No session authorized yet! Please complete manual login first:');
    console.error('Run command: npm run manual-login\n');
    process.exit(1);
  }

  const baseOmsUrl = process.env.OMS_URL || 'https://smarthub.amazon.in';
  
  // We clean any trailing slash and navigate directly to the /pick route
  const cleanUrl = baseOmsUrl.endsWith('/') ? baseOmsUrl.slice(0, -1) : baseOmsUrl;
  const pickUrl = `${cleanUrl}/pick`;

  console.log(`Launching headless browser using saved session...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authPath });
  const page = await context.newPage();

  try {
    console.log(`Navigating to pick portal: ${pickUrl}`);
    await page.goto(pickUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(4000); // Wait for page JS to settle

    // 1. Locate and click today's date card
    const todayStr = getTodayDateString();
    console.log(`Searching for date card matching: "${todayStr}"`);

    const cards = await page.$$('.awui-pick-create-card');
    let clicked = false;

    for (const card of cards) {
      const text = await card.textContent();
      if (text.includes(todayStr)) {
        console.log(`Found matching card! Clicking on it to activate table...`);
        await card.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      console.log(`\n[Note] Card matching "${todayStr}" not explicitly found for today. Skipping click and table wait.`);
      const screenshotsDir = path.dirname(screenshotPath);
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      await page.screenshot({ path: screenshotPath });
      console.log(`Live screen captured successfully (No date card today) at: ${screenshotPath}`);
      console.log('No active shipments pick lists found for today. Exiting.');
      return;
    }

    // 2. Extract shipping lists from #awui-pick-recommended-table
    console.log('Waiting for recommended table to load and become visible...');
    await page.waitForSelector('#awui-pick-recommended-table table', { state: 'visible', timeout: 15000 });
    
    // Wait for network to settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 4000 });
    } catch (e) {
      // Ignore networkidle timeout
    }
    
    // Wait a solid 3 seconds for rows to fully render visually
    await page.waitForTimeout(3000);

    // 3. Capture a live screenshot of the fully loaded pick screen
    const screenshotsDir = path.dirname(screenshotPath);
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    await page.screenshot({ path: screenshotPath });
    console.log(`Live screen captured successfully at: ${screenshotPath}`);

    const pickLists = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#awui-pick-recommended-table table tbody tr'));
      
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 6) return null; // Skip non-data summary rows

        const priority = cells[1].textContent.trim();
        const orderCountText = cells[2].querySelector('p:first-child')?.textContent?.trim() || cells[2].textContent.trim();
        const orderType = cells[2].querySelector('p:nth-child(2)')?.textContent?.trim() || '';
        const shipoutTime = cells[4].textContent.trim();
        const channel = cells[5].textContent.trim();

        if (!channel || channel.toLowerCase().includes('total')) return null;

        return {
          priority,
          orders: orderCountText,
          orderType,
          shipoutTime,
          channel
        };
      }).filter(Boolean);
    });

    console.log(`Successfully scraped ${pickLists.length} pending pick lists.`);
    console.log(pickLists);

    if (pickLists.length === 0) {
      console.log('\n[Info] No active shipping pick lists found for today in the table.');
      return;
    }

    // 4. Construct Telegram Markdown message for immediate dispatch
    let messageText = `🚨 *LIVE TEST ALERT: PENDING SHIPMENTS*\n\n`;
    messageText += `*Date:* ${todayStr}\n`;
    messageText += `*Active Pick Lists:* ${pickLists.length}\n\n`;

    pickLists.forEach((list, index) => {
      messageText += `*List #${index + 1}:*\n`;
      messageText += `• *Channel:* ${list.channel}\n`;
      messageText += `• *Orders:* ${list.orders} (${list.orderType || 'Standard'})\n`;
      messageText += `• *Shipout SLA:* \`${list.shipoutTime}\`\n`;
      messageText += `• *Priority:* Level ${list.priority}\n\n`;
    });

    // We build a simulated single alert group structure for our telegram service
    const groupAlert = {
      marketplace: 'SmartHUB Live',
      alertLevel: 'urgent',
      orders: pickLists.map((l, i) => ({ orderId: `List #${i+1} (${l.channel})`, sku: `${l.orders} orders` }))
    };

    // Override the messageText inside a custom sender helper to send custom text
    const customGroupAlert = {
      marketplace: 'SmartHUB Live',
      alertLevel: 'urgent',
      orders: [] // Passing empty so it doesn't double-list orderIds, we inject customized text
    };

    // Update process.env to force bypass mock constraints if valid token is there
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';
    const chatIds = rawChatIds.split(',').map(id => id.trim()).filter(Boolean);

    console.log(`Preparing to dispatch alerts directly to: ${chatIds.join(', ')}`);

    // We call the real alert transmitter
    // To ensure the custom markdown formatted message is delivered, we wrap it in sendTelegramAlert but custom format it:
    const mockAlert = {
      marketplace: 'SmartHUB',
      alertLevel: 'critical', // Force critical icon
      orders: []
    };

    // We temporarily construct a modified alert mapping to send our customized multi-pick detail
    const modifiedAlert = {
      marketplace: 'SmartHUB Live',
      alertLevel: 'critical',
      orders: pickLists.map(l => ({ orderId: `${l.channel}: ${l.orders} orders`, sku: `SLA: ${l.shipoutTime}` }))
    };

    await sendTelegramAlert(modifiedAlert, screenshotPath);

    console.log('\n================================================================');
    console.log('SUCCESS! Test alert and screenshot dispatched to all recipients.');
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n[Error] Live scraping test failed:', err.message || err);
  } finally {
    await browser.close();
  }
}

runLiveTest();
