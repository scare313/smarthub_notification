const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { authPath, performLogin } = require('./login');
const { ApiInterceptor } = require('./apiClient');

const screenshotsDir = path.join(__dirname, '..', '..', 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}
const screenshotPath = path.join(screenshotsDir, 'dashboard.png');
const screenshotActivePath = path.join(screenshotsDir, 'active_dashboard.png');

// ============================================================
// Sales Channel → Marketplace Mapping
// ============================================================
const CHANNEL_MAP = {
  'SELLER_FLEX': 'Amazon',
  'FBA': 'Amazon',
  'EASY_SHIP': 'Amazon',
  'MFN': 'Amazon',
  'FKSTANDARD': 'Flipkart',
  'MEESHO': 'Meesho',
  'SHOPIFY': 'Shopify'
};

function mapSalesChannelToMarketplace(salesChannel, displayableName) {
  if (CHANNEL_MAP[salesChannel]) return CHANNEL_MAP[salesChannel];
  if (CHANNEL_MAP[displayableName]) return CHANNEL_MAP[displayableName];
  
  // Fallback: try substring matching
  const combined = `${salesChannel} ${displayableName}`.toLowerCase();
  if (combined.includes('flipkart') || combined.includes('fkstandard')) return 'Flipkart';
  if (combined.includes('meesho')) return 'Meesho';
  if (combined.includes('shopify')) return 'Shopify';
  
  return 'Amazon'; // Default fallback
}

// ============================================================
// Main entry point
// ============================================================
async function fetchOrders(useDefaultDate = false) {
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

  const dashboardPath = process.env.OMS_DASHBOARD_PATH || '/pick';
  const safeJoinUrl = (base, pathStr) => {
    const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const cleanPath = pathStr.startsWith('/') ? pathStr : `/${pathStr}`;
    return `${cleanBase}${cleanPath}`;
  };
  const dashboardUrl = safeJoinUrl(url, dashboardPath);

  // Set up API Interception BEFORE navigating
  const interceptor = new ApiInterceptor(page);

  try {
    console.log(`Navigating to dashboard: ${dashboardUrl}`);
    await page.goto(dashboardUrl, { waitUntil: 'load', timeout: 20000 });

    // Wait for either the dashboard cards OR the login page password input to appear
    console.log('[Scraper] Waiting for dashboard elements or login screen...');
    try {
      await Promise.race([
        page.waitForSelector('.awui-pick-create-card', { timeout: 15000 }),
        page.waitForSelector('input[type="password"]', { timeout: 15000 })
      ]);
    } catch (err) {
      console.warn('[Scraper] Warning: Neither dashboard cards nor login password input appeared within 15 seconds.');
    }

    // ========================================
    // Verify Session Status (Logged-Out Detection)
    // ========================================
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

    // ========================================
    // Extract data using API-first approach
    // ========================================
    return await extractData(page, interceptor, useDefaultDate);

  } catch (err) {
    console.error('Error fetching orders from dashboard:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

// ============================================================
// Data Extraction — API-first with DOM fallback
// ============================================================
async function extractData(page, interceptor, useDefaultDate = false) {
  const allOrders = [];
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];

  // ==========================================
  // STEP 1: HANDLE CREATE TAB
  // ==========================================

  // Click date card (needed to trigger lists/recommended API and for screenshots)
  let clickedDateCard = false;
  let todayStr = getTodayDateString();

  if (useDefaultDate) {
    // Test mode: use whatever card is already selected
    try {
      const selected = await page.$('.awui-pick-create-card-selected');
      if (selected) {
        const cardText = await selected.textContent();
        todayStr = cardText.split('\n')[0].trim();
        console.log(`[Scraper] Test Mode: Using default selected card: "${todayStr}"`);
      } else {
        const firstCard = await page.$('.awui-pick-create-card');
        if (firstCard) {
          await firstCard.click();
          const cardText = await firstCard.textContent();
          todayStr = cardText.split('\n')[0].trim();
          console.log(`[Scraper] Test Mode: Clicked first available card: "${todayStr}"`);
        }
      }
      clickedDateCard = true;
    } catch (e) {
      console.warn('[Scraper] Warning: Failed to extract default selected date:', e.message);
    }
  } else {
    // Production mode: find today's date card
    console.log(`[Scraper] Production Mode: Target date is today: "${todayStr}"`);
    try {
      const cards = await page.$$('.awui-pick-create-card');
      for (const card of cards) {
        const text = await card.textContent();
        if (text.includes(todayStr)) {
          console.log(`[Scraper] Found today's date card. Clicking...`);
          await card.click();
          clickedDateCard = true;
          break;
        }
      }
    } catch (cardErr) {
      console.warn('[Scraper] Warning: Error checking date cards:', cardErr.message);
    }

    if (!clickedDateCard) {
      console.log(`[Scraper] Card matching "${todayStr}" not found. Skipping Create tab.`);
    }
  }

  // Wait for Create tab APIs to complete
  if (clickedDateCard) {
    await page.waitForTimeout(3000); // Give time for lists/recommended to fire after card click

    // Wait for table to load (for screenshot), but don't depend on it for data
    try {
      await page.waitForSelector('#awui-pick-recommended-table table', { state: 'visible', timeout: 10000 });
    } catch {
      console.log('[Scraper] Create tab table not visible (may be empty or loading)');
    }
    await page.waitForTimeout(2000);
  }

  // Capture Create tab screenshot
  try {
    await page.screenshot({ path: screenshotPath });
    console.log(`Create tab screenshot captured at: ${screenshotPath}`);
  } catch (err) {
    console.error('Failed to capture Create tab screenshot:', err);
  }

  // Wait for Create tab API data
  console.log('[Scraper] Waiting for Create tab API data...');
  const createData = await interceptor.waitForCreateTabData(12000);

  // ==========================================
  // STEP 2: HANDLE ACTIVE TAB
  // ==========================================
  try {
    console.log('[Scraper] Clicking on "Active pick lists" tab...');
    await page.locator('label').filter({ hasText: 'Active pick lists' }).click();

    // Wait for Active tab table to render (for screenshot)
    try {
      await page.waitForSelector('#awui-pick-active-table table', { state: 'visible', timeout: 15000 });
      await page.waitForTimeout(3000);
    } catch {
      console.log('[Scraper] Active tab table not visible within timeout');
    }

    // Capture Active tab screenshot
    try {
      await page.screenshot({ path: screenshotActivePath });
      console.log(`Active tab screenshot captured at: ${screenshotActivePath}`);
    } catch (err) {
      console.error('Failed to capture Active tab screenshot:', err);
    }
  } catch (err) {
    console.error('[Scraper] Error switching to Active tab:', err.message);
  }

  // Wait for Active tab API data (GraphQL)
  console.log('[Scraper] Waiting for Active tab API data (GraphQL)...');
  const activeTabLists = await interceptor.waitForActiveTabData(12000);

  // ==========================================
  // STEP 3: PROCESS API DATA → ORDERS
  // ==========================================
  const apiData = interceptor.getData();
  let usedApi = false;

  // --- Process Create tab data ---
  if (clickedDateCard && createData.createTabLists && createData.createTabLists.length > 0) {
    console.log(`[Scraper] API: Processing ${createData.createTabLists.length} create tab lists...`);
    usedApi = true;

    for (let i = 0; i < createData.createTabLists.length; i++) {
      const list = createData.createTabLists[i];
      const channel = list.displayableSalesChannel || {};
      const salesChannel = channel.salesChannel || channel.name || 'Unknown';
      const displayName = channel.name || salesChannel;
      const marketplace = mapSalesChannelToMarketplace(salesChannel, displayName);

      // Convert epoch to ISO datetime
      const shipEpoch = list.expectedShipEpoch;
      const shipDate = new Date(shipEpoch * 1000);
      const shipTimeStr = shipDate.toISOString();

      // Build a unique order ID: channel + epoch + index + date
      const cleanChannel = displayName.replace(/\s+/g, '');
      const orderId = `${cleanChannel}_${shipEpoch}_${i}_${dateStr}`;

      const orderCount = list.numberOfOrders || 0;
      const attributes = [];
      if (list.hasFastTrackOrders) attributes.push('FastTrack');
      if (list.hasSingleOrders === false) attributes.push('Multi');
      if (list.hasSingleOrders === true) attributes.push('Single');
      const attrStr = attributes.length > 0 ? attributes.join(', ') : 'Standard';

      allOrders.push({
        orderId,
        marketplace,
        createdTime: shipTimeStr,
        status: list.status === 'NEW' ? 'pending' : list.status?.toLowerCase() || 'pending',
        customer: `Priority ${list.pickTaskType || 'CUSTOMER'}`,
        sku: `${orderCount} orders (${attrStr})`,
        orderValue: String(orderCount),
        isFromActiveTab: false
      });
    }

    console.log(`[Scraper] API: Mapped ${allOrders.length} orders from Create tab.`);
  } else if (clickedDateCard) {
    // Fallback: DOM scraping for Create tab
    console.log('[Scraper] API data not available for Create tab. Falling back to DOM scraping...');
    const domCreateOrders = await domScrapeCreateTab(page, dateStr);
    allOrders.push(...domCreateOrders);
  }

  // --- Process Active tab data ---
  if (activeTabLists && activeTabLists.length > 0) {
    console.log(`[Scraper] API: Processing ${activeTabLists.length} active tab pick tasks...`);
    usedApi = true;

    const slaConfigPath = path.join(__dirname, '..', 'config', 'sla.json');
    const slaConfig = JSON.parse(fs.readFileSync(slaConfigPath, 'utf8'));
    const now = new Date();

    for (const task of activeTabLists) {
      const shipEpoch = task.expectedShipEpoch;
      const shipDate = new Date(shipEpoch * 1000);
      const isMissed = shipDate < now; // Deadline already passed

      // Determine marketplace from sales channel attributes
      const channelList = task.attributes?.salesChannelWithAttributesList || [];
      let marketplace = 'Amazon'; // default
      if (channelList.length > 0) {
        const ch = channelList[0];
        marketplace = mapSalesChannelToMarketplace(ch.salesChannel, ch.displayableSalesChannel);
      }

      const taskId = task.id || `ACTIVE_${shipEpoch}`;
      const orderCount = task.attributes?.numberOfOrders || 0;
      const orderId = `${taskId}_${isMissed ? 'Missed' : 'Today'}_${dateStr}`;

      // Build descriptive attributes
      const attrs = [];
      if (task.attributes?.hasFastTrackOrders) attrs.push('FastTrack');
      if (task.attributes?.hasSingleOrders === true) attrs.push('Single');
      if (task.attributes?.hasSingleOrders === false) attrs.push('Multi');
      const attrStr = attrs.length > 0 ? attrs.join(', ') : 'Standard';

      // Calculate createdTime
      let createdTime;
      if (isMissed) {
        // Use yesterday 08:00 AM to trigger critical alerts
        const yesterday = new Date();
        yesterday.setDate(now.getDate() - 1);
        yesterday.setHours(8, 0, 0, 0);
        createdTime = yesterday.toISOString();
      } else {
        // Use SLA time for marketplace
        const slaTime = slaConfig.slas[marketplace] || '12:00';
        const [hours, minutes] = slaTime.split(':').map(Number);
        const slaDate = new Date();
        slaDate.setHours(hours, minutes, 0, 0);
        createdTime = slaDate.toISOString();
      }

      allOrders.push({
        orderId,
        marketplace,
        createdTime,
        status: isMissed ? 'missed' : 'pending',
        customer: `Pick Task ${taskId}`,
        sku: `${orderCount} orders (${attrStr}, Active list ID: ${taskId})`,
        orderValue: String(orderCount),
        isFromActiveTab: true
      });
    }

    console.log(`[Scraper] API: Mapped ${activeTabLists.length} orders from Active tab.`);
  } else {
    // Fallback: DOM scraping for Active tab
    console.log('[Scraper] API data not available for Active tab. Falling back to DOM scraping...');
    const domActiveOrders = await domScrapeActiveTab(page, dateStr);
    allOrders.push(...domActiveOrders);
  }

  if (usedApi) {
    console.log(`[Scraper] ✅ API-first extraction complete. Total orders: ${allOrders.length}`);
  } else {
    console.log(`[Scraper] ⚠️ Full DOM fallback used. Total orders: ${allOrders.length}`);
  }

  return allOrders;
}

// ============================================================
// DOM Scraping Fallbacks (kept as safety net)
// ============================================================

/**
 * DOM Fallback: Scrape the Create tab recommended pick table
 */
async function domScrapeCreateTab(page, dateStr) {
  const orders = [];
  try {
    await page.waitForSelector('#awui-pick-recommended-table table', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(3000);

    const recommendedPickLists = await page.evaluate(({ sel, datePrefix }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 6) return null;

        const priority = cells[1].textContent.trim();
        const orderCountText = cells[2].querySelector('p:first-child')?.textContent?.trim() || cells[2].textContent.trim();
        const orderType = cells[2].querySelector('p:nth-child(2)')?.textContent?.trim() || '';
        const shipoutTimeText = cells[4].textContent.trim();
        const channel = cells[5].textContent.trim();

        if (!channel || channel.toLowerCase().includes('total')) return null;

        let marketplace = 'Amazon';
        if (channel.toLowerCase().includes('flipkart')) marketplace = 'Flipkart';
        else if (channel.toLowerCase().includes('meesho')) marketplace = 'Meesho';

        const cleanChannel = channel.replace(/\s+/g, '');
        const cleanTime = shipoutTimeText.replace(/\s+|:/g, '-');
        const orderId = `${cleanChannel}_${cleanTime}_${datePrefix}`;

        return { orderId, marketplace, status: 'pending', customer: `Priority ${priority}`, sku: `${orderCountText} orders (${orderType || 'Standard'})`, orderValue: orderCountText, timeText: shipoutTimeText };
      }).filter(Boolean);
    }, { sel: '#awui-pick-recommended-table table tbody tr', datePrefix: dateStr });

    recommendedPickLists.forEach(list => {
      let [time, modifier] = list.timeText.split(' ');
      let [hours, minutes] = time.split(':');
      hours = parseInt(hours, 10);
      if (modifier === 'PM' && hours < 12) hours += 12;
      if (modifier === 'AM' && hours === 12) hours = 0;
      const pad = (num) => String(num).padStart(2, '0');
      const createdTime = `${dateStr}T${pad(hours)}:${pad(minutes)}:00+05:30`;

      orders.push({
        orderId: list.orderId, marketplace: list.marketplace, createdTime,
        status: list.status, customer: list.customer, sku: list.sku,
        orderValue: list.orderValue, isFromActiveTab: false
      });
    });

    console.log(`[Scraper] DOM Fallback: Scraped ${orders.length} from Create tab.`);
  } catch (err) {
    console.error('[Scraper] DOM Fallback Create tab failed:', err.message);
  }
  return orders;
}

/**
 * DOM Fallback: Scrape the Active pick lists tab
 */
async function domScrapeActiveTab(page, dateStr) {
  const orders = [];
  try {
    await page.waitForSelector('#awui-pick-active-table table', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(3000);

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

    const activePickLists = await page.evaluate(({ sel, targetLabel, datePrefix }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 8) return null;

        const picklistId = cells[1].querySelector('a')?.textContent?.trim() || cells[1].textContent.trim();
        const priority = cells[2].textContent.trim();
        const shipout = cells[4].textContent.trim();
        const channel = cells[5].textContent.trim();
        const orderCountText = cells[6].textContent.trim();
        const attributes = cells[7].textContent.trim();

        const isMissed = shipout.toLowerCase().includes('missed');
        const isToday = shipout.toLowerCase().includes(targetLabel.toLowerCase());

        if (!isMissed && !isToday) return null;

        let marketplace = 'Amazon';
        if (channel.toLowerCase().includes('flipkart')) marketplace = 'Flipkart';
        else if (channel.toLowerCase().includes('meesho')) marketplace = 'Meesho';

        const orderId = `${picklistId}_${isMissed ? 'Missed' : 'Today'}_${datePrefix}`;
        return { orderId, marketplace, status: isMissed ? 'missed' : 'pending', customer: `Priority ${priority}`, sku: `${orderCountText} orders (${attributes || 'Standard'}, Active list ID: ${picklistId})`, orderValue: orderCountText, shipoutText: shipout };
      }).filter(Boolean);
    }, { sel: '#awui-pick-active-table table tbody tr', targetLabel, datePrefix: dateStr });

    const slaConfigPath = path.join(__dirname, '..', 'config', 'sla.json');
    const slaConfig = JSON.parse(fs.readFileSync(slaConfigPath, 'utf8'));
    const now = new Date();

    activePickLists.forEach(list => {
      if (list.status === 'missed') {
        const yesterday = new Date();
        yesterday.setDate(now.getDate() - 1);
        yesterday.setHours(8, 0, 0, 0);
        orders.push({ orderId: list.orderId, marketplace: list.marketplace, createdTime: yesterday.toISOString(), status: list.status, customer: list.customer, sku: list.sku, orderValue: list.orderValue, isFromActiveTab: true });
      } else {
        const slaTime = slaConfig.slas[list.marketplace] || '12:00';
        const [hours, minutes] = slaTime.split(':').map(Number);
        const slaDate = new Date();
        slaDate.setHours(hours, minutes, 0, 0);
        orders.push({ orderId: list.orderId, marketplace: list.marketplace, createdTime: slaDate.toISOString(), status: list.status, customer: list.customer, sku: list.sku, orderValue: list.orderValue, isFromActiveTab: true });
      }
    });

    console.log(`[Scraper] DOM Fallback: Scraped ${orders.length} from Active tab.`);
  } catch (err) {
    console.error('[Scraper] DOM Fallback Active tab failed:', err.message);
  }
  return orders;
}

// ============================================================
// Helpers
// ============================================================
function getTodayDateString() {
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
}

module.exports = { fetchOrders };
