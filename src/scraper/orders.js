const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { authPath, performLogin } = require('./login');
const { setupInterception } = require('./networkInterceptor');

const screenshotsDir = path.join(__dirname, '..', '..', 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}
const screenshotPath = path.join(screenshotsDir, 'dashboard.png');
const screenshotActivePath = path.join(screenshotsDir, 'active_dashboard.png');

async function fetchOrders() {
  const url = process.env.OMS_URL || 'https://smarthub.amazon.in';
  const username = process.env.OMS_USERNAME || 'admin';
  const password = process.env.OMS_PASSWORD || 'supersecurepassword';
  const headless = process.env.HEADLESS !== 'false';

  // Step 1: Ensure auth session state exists, or perform initial login
  if (!fs.existsSync(authPath)) {
    console.log('Session storage file not found. Performing fresh login...');
    await performLogin(url, username, password, headless);
  }

  const browser = await chromium.launch({ headless });
  
  // Set up context with saved auth state
  let context;
  try {
    context = await browser.newContext({ storageState: authPath });
  } catch (err) {
    console.warn('Failed to load session storage, attempting re-login...', err);
    await performLogin(url, username, password, headless);
    context = await browser.newContext({ storageState: authPath });
  }

  const page = await context.newPage();

  // Configurable patterns
  const apiInterceptPattern = process.env.OMS_API_INTERCEPT_PATTERN || '/api/orders';
  const dashboardPath = process.env.OMS_DASHBOARD_PATH || '/pick';

  // Helper to safely join base URL and path to avoid double slashes
  const safeJoinUrl = (base, pathStr) => {
    const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const cleanPath = pathStr.startsWith('/') ? pathStr : `/${pathStr}`;
    return `${cleanBase}${cleanPath}`;
  };

  const dashboardUrl = safeJoinUrl(url, dashboardPath);

  // Set up Network Interception
  const interceptor = await setupInterception(page, apiInterceptPattern);

  try {
    console.log(`Navigating to dashboard: ${dashboardUrl}`);
    const response = await page.goto(dashboardUrl, { waitUntil: 'load', timeout: 20000 });

    // Wait a brief moment for DOM elements to fully settle
    await page.waitForTimeout(4000);

    // Verify Session Status (Logged-Out Detection)
    const currentUrl = page.url();
    const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('/signin') || currentUrl === `${url}/` || currentUrl === url;
    const hasPasswordInput = (await page.$('input[type="password"]')) !== null;
    const cards = await page.$$('.awui-pick-create-card');
    const isLoggedOut = isLoginPage || hasPasswordInput || cards.length === 0;

    if (isLoggedOut) {
      console.error('[Scraper] Session is logged out! Redirected to login page or picker elements completely missing.');
      try {
        await page.screenshot({ path: screenshotPath });
        console.log(`Logged-out screenshot successfully captured at: ${screenshotPath}`);
      } catch (err) {
        console.error('Failed to capture logged-out screenshot:', err);
      }
      throw new Error('SESSION_LOGGED_OUT');
    }

    return await extractData(page, interceptor, screenshotPath, screenshotActivePath);

  } catch (err) {
    console.error('Error fetching orders from dashboard:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

async function extractData(page, interceptor, screenshotPath, screenshotActivePath) {
  // Wait a short time for page to settle
  await page.waitForTimeout(4000);

  // Helper to generate today's date formatted like the cards (e.g., "Wednesday May 27th")
  const getTodayDateString = () => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    const today = new Date();
    const dayName = days[today.getDay()];
    const monthName = months[today.getMonth()];
    const date = today.getDate();
    
    let suffix = 'th';
    if (date === 1 || date === 21 || date === 31) suffix = 'st';
    else if (date === 2 || date === 22) suffix = 'nd';
    else if (date === 3 || date === 23) suffix = 'rd';
    
    return `${dayName} ${monthName} ${date}${suffix}`;
  };

  const todayStr = getTodayDateString();
  console.log(`[Scraper] Today's target date string: "${todayStr}"`);

  // Helper to check if a table is fully loaded (rows > 0 and rows contain text)
  const waitTablePopulated = async (targetId) => {
    console.log(`[Scraper] Waiting for table ${targetId} to load completely...`);
    await page.waitForSelector(`${targetId} table`, { state: 'visible', timeout: 15000 });
    
    await page.waitForFunction((id) => {
      const rows = document.querySelectorAll(`${id} table tbody tr`);
      return rows.length > 0 && rows[0].textContent.trim().length > 0;
    }, targetId, { timeout: 15000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 4000 });
    } catch (e) {
      // Ignore networkidle timeouts
    }

    await page.waitForTimeout(3000); // 3 seconds extra render settle delay
  };

  const allOrders = [];

  // ==========================================
  // STEP 1: SCRAPE CREATE TAB
  // ==========================================
  let clicked = false;
  try {
    const cards = await page.$$('.awui-pick-create-card');

    for (const card of cards) {
      const text = await card.textContent();
      if (text.includes(todayStr)) {
        console.log(`[Scraper] Found today's date card. Clicking...`);
        await card.click();
        clicked = true;
        break;
      }
    }
  } catch (cardErr) {
    console.warn('[Scraper] Warning: Error checking date cards:', cardErr.message);
  }

  // If today's card is not found, we skip the Create tab scraping
  if (!clicked) {
    console.log(`[Scraper] Card matching "${todayStr}" not explicitly found for today. Skipping Create tab.`);
    try {
      await page.screenshot({ path: screenshotPath });
      console.log(`Create screen captured successfully (No date card today) at: ${screenshotPath}`);
    } catch (err) {
      console.error('Failed to capture Create screenshot:', err);
    }
  } else {
    // If today's card is found, wait for table load, take screenshot, and parse
    try {
      await waitTablePopulated('#awui-pick-recommended-table');

      // Capture screenshot of the fully populated recommended table
      try {
        await page.screenshot({ path: screenshotPath });
        console.log(`Create tab screenshot successfully captured at: ${screenshotPath}`);
      } catch (err) {
        console.error('Failed to capture Create tab screenshot:', err);
      }

      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];

      // Extract recommended list from table
      const recommendedPickLists = await page.evaluate(({ sel, datePrefix }) => {
        const rows = Array.from(document.querySelectorAll(sel));
        
        return rows.map(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 6) return null; // Skip summary rows

          const priority = cells[1].textContent.trim();
          const orderCountText = cells[2].querySelector('p:first-child')?.textContent?.trim() || cells[2].textContent.trim();
          const orderType = cells[2].querySelector('p:nth-child(2)')?.textContent?.trim() || '';
          const shipoutTimeText = cells[4].textContent.trim();
          const channel = cells[5].textContent.trim();

          if (!channel || channel.toLowerCase().includes('total')) return null;

          let marketplace = 'Amazon';
          if (channel.toLowerCase().includes('flipkart')) {
            marketplace = 'Flipkart';
          } else if (channel.toLowerCase().includes('meesho')) {
            marketplace = 'Meesho';
          }

          const cleanChannel = channel.replace(/\s+/g, '');
          const cleanTime = shipoutTimeText.replace(/\s+|:/g, '-');
          const orderId = `${cleanChannel}_${cleanTime}_${datePrefix}`;

          return {
            orderId,
            marketplace,
            status: 'pending',
            customer: `Priority ${priority}`,
            sku: `${orderCountText} orders (${orderType || 'Standard'})`,
            orderValue: orderCountText,
            timeText: shipoutTimeText
          };
        }).filter(Boolean);
      }, { sel: '#awui-pick-recommended-table table tbody tr', datePrefix: dateStr });

      // Map recommended lists
      recommendedPickLists.forEach(list => {
        let [time, modifier] = list.timeText.split(' ');
        let [hours, minutes] = time.split(':');
        hours = parseInt(hours, 10);
        
        if (modifier === 'PM' && hours < 12) {
          hours = hours + 12;
        }
        if (modifier === 'AM' && hours === 12) {
          hours = 0;
        }
        
        const pad = (num) => String(num).padStart(2, '0');
        const createdTime = `${dateStr}T${pad(hours)}:${pad(minutes)}:00+05:30`;

        allOrders.push({
          orderId: list.orderId,
          marketplace: list.marketplace,
          createdTime,
          status: list.status,
          customer: list.customer,
          sku: list.sku,
          orderValue: list.orderValue,
          isFromActiveTab: false
        });
      });

      console.log(`[Scraper] Successfully scraped ${recommendedPickLists.length} pick lists from Create tab.`);
    } catch (createScrapeErr) {
      console.error('[Scraper] Error scraping Create tab pick lists:', createScrapeErr.message);
    }
  }

  // ==========================================
  // STEP 2: SCRAPE ACTIVE PICK LISTS TAB
  // ==========================================
  try {
    console.log('[Scraper] Clicking on "Active pick lists" tab...');
    await page.locator('label').filter({ hasText: 'Active pick lists' }).click();
    
    // Wait for the active table to load and become visible
    await waitTablePopulated('#awui-pick-active-table');

    // Capture screenshot of the fully populated active table
    try {
      await page.screenshot({ path: screenshotActivePath });
      console.log(`Active pick lists tab screenshot successfully captured at: ${screenshotActivePath}`);
    } catch (err) {
      console.error('Failed to capture Active tab screenshot:', err);
    }

    // Helper to generate today's label matching column format (e.g. "Thursday 28th")
    const getTodayLabelString = () => {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const today = new Date();
      const dayName = days[today.getDay()];
      const date = today.getDate();
      let suffix = 'th';
      if (date === 1 || date === 21 || date === 31) suffix = 'st';
      else if (date === 2 || date === 22) suffix = 'nd';
      else if (date === 3 || date === 23) suffix = 'rd';
      return `${dayName} ${date}${suffix}`;
    };

    const targetLabel = getTodayLabelString();
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    console.log(`[Scraper] Active list date match criteria: "${targetLabel}" or "Missed"`);

    // Extract active lists from table
    const activePickLists = await page.evaluate(({ sel, targetLabel, datePrefix }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 8) return null; // Skip summary / partial rows

        const picklistId = cells[1].querySelector('a')?.textContent?.trim() || cells[1].textContent.trim();
        const priority = cells[2].textContent.trim();
        const shipout = cells[4].textContent.trim(); // "Missed" or "Thursday 28th" etc.
        const channel = cells[5].textContent.trim();
        const orderCountText = cells[6].textContent.trim();
        const attributes = cells[7].textContent.trim();

        // Check if Missed or matches today's label
        const isMissed = shipout.toLowerCase() === 'missed';
        const isToday = shipout.toLowerCase().includes(targetLabel.toLowerCase());

        if (!isMissed && !isToday) return null;

        let marketplace = 'Amazon';
        if (channel.toLowerCase().includes('flipkart')) {
          marketplace = 'Flipkart';
        } else if (channel.toLowerCase().includes('meesho')) {
          marketplace = 'Meesho';
        }

        const orderId = `${picklistId}_${isMissed ? 'Missed' : 'Today'}_${datePrefix}`;

        return {
          orderId,
          marketplace,
          status: isMissed ? 'missed' : 'pending',
          customer: `Priority ${priority}`,
          sku: `${orderCountText} orders (${attributes || 'Standard'}, Active list ID: ${picklistId})`,
          orderValue: orderCountText,
          shipoutText: shipout
        };
      }).filter(Boolean);
    }, { sel: '#awui-pick-active-table table tbody tr', targetLabel, datePrefix: dateStr });

    // Map and calculate createdTime for Active list items
    const fs = require('fs');
    const slaConfigPath = path.join(__dirname, '..', 'config', 'sla.json');
    const slaConfig = JSON.parse(fs.readFileSync(slaConfigPath, 'utf8'));

    activePickLists.forEach(list => {
      // Calculate createdTime based on marketplace SLA
      const now = new Date();
      
      // If it is already marked as missed, set SlaDate to yesterday to ensure rules engine triggers critical severity
      if (list.status === 'missed') {
        const yesterday = new Date();
        yesterday.setDate(now.getDate() - 1);
        yesterday.setHours(8, 0, 0, 0); // Yesterday 08:00 AM
        
        allOrders.push({
          orderId: list.orderId,
          marketplace: list.marketplace,
          createdTime: yesterday.toISOString(),
          status: list.status,
          customer: list.customer,
          sku: list.sku,
          orderValue: list.orderValue,
          isFromActiveTab: true
        });
      } else {
        // Today's active list
        const slaTime = slaConfig.slas[list.marketplace] || '12:00';
        const [hours, minutes] = slaTime.split(':').map(Number);
        
        const slaDate = new Date();
        slaDate.setHours(hours, minutes, 0, 0);

        allOrders.push({
          orderId: list.orderId,
          marketplace: list.marketplace,
          createdTime: slaDate.toISOString(),
          status: list.status,
          customer: list.customer,
          sku: list.sku,
          orderValue: list.orderValue,
          isFromActiveTab: true
        });
      }
    });

    console.log(`[Scraper] Successfully scraped ${activePickLists.length} pick lists from Active tab.`);
  } catch (activeScrapeErr) {
    console.error('[Scraper] Error scraping Active tab pick lists:', activeScrapeErr.message);
  }

  // Fallback to error if absolutely no data scraped on both tabs (excluding empty days)
  if (clicked && allOrders.length === 0 && !fs.existsSync(screenshotPath)) {
    throw new Error('Both Network Interception and DOM Scraping failed.');
  }

  return allOrders;
}

module.exports = { fetchOrders };
