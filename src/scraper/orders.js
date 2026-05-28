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

async function fetchOrders() {
  const url = process.env.OMS_URL || 'http://localhost:3000';
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
    const response = await page.goto(dashboardUrl, { waitUntil: 'load', timeout: 15000 });

    // Step 2: Session Expiration Handling
    const currentUrl = page.url();
    if (currentUrl === `${url}/` || currentUrl.includes('/login') || response.status() === 401) {
      console.log('Session expired. Refreshing authentication...');
      await page.close();
      await context.close();
      
      // Perform re-login
      await performLogin(url, username, password, headless);
      
      // Create new context & page
      const newContext = await browser.newContext({ storageState: authPath });
      const newPage = await newContext.newPage();
      
      // Setup interception on new page
      const newInterceptor = await setupInterception(newPage, apiInterceptPattern);
      
      const newDashboardUrl = safeJoinUrl(url, dashboardPath);
      console.log('Re-navigating to dashboard after fresh login...');
      await newPage.goto(newDashboardUrl, { waitUntil: 'load', timeout: 15000 });
      
      return await extractData(newPage, newInterceptor, screenshotPath);
    }

    return await extractData(page, interceptor, screenshotPath);

  } catch (err) {
    console.error('Error fetching orders from dashboard:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

async function extractData(page, interceptor, screenshotPath) {
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

  // 1. Locate and click today's date card
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

  // If today's date card was NOT found on the page, stop, capture screenshot, and return empty list
  if (!clicked) {
    console.log(`[Scraper] Card matching "${todayStr}" not explicitly found for today. Skipping click and table wait.`);
    try {
      const screenshotsDir = path.dirname(screenshotPath);
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      await page.screenshot({ path: screenshotPath });
      console.log(`Dashboard screenshot successfully captured (No date card today) at: ${screenshotPath}`);
    } catch (err) {
      console.error('Failed to capture dashboard screenshot:', err);
    }
    return [];
  }

  // Priority 1: Network Interceptor data (fallback if background requests are intercepted)
  const apiData = interceptor.getData();
  if (apiData && apiData.orders) {
    // Capture screenshot since we have successfully got data
    try {
      await page.screenshot({ path: screenshotPath });
      console.log(`Dashboard screenshot successfully captured (Priority 1) at: ${screenshotPath}`);
    } catch (err) {
      console.error('Failed to capture dashboard screenshot:', err);
    }
    console.log(`Priority 1: Successfully extracted ${apiData.orders.length} orders via network interception.`);
    return apiData.orders;
  }

  // Priority 2: DOM Scraping Fallback (Scrapes the recommended pick table)
  console.log('Priority 1 Interception did not capture standard data. Scraping recommended pick table...');
  try {
    // 2. Robust Table Wait: Wait for recommended table to load and become visible
    console.log('[Scraper] Waiting for recommended table to load and become visible...');
    await page.waitForSelector('#awui-pick-recommended-table table', { state: 'visible', timeout: 15000 });
    
    // Wait for any background API calls/rendering network to settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 4000 });
    } catch (e) {
      // Ignore networkidle timeout
    }
    
    // 3. Render Buffer: Wait a solid 3 seconds for DOM rows to fully render visually
    await page.waitForTimeout(3000);

    // Capture the fully loaded pick table screenshot
    try {
      await page.screenshot({ path: screenshotPath });
      console.log(`Dashboard screenshot successfully captured (Priority 2) at: ${screenshotPath}`);
    } catch (err) {
      console.error('Failed to capture dashboard screenshot:', err);
    }

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    const pickLists = await page.evaluate(({ sel, datePrefix }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 6) return null; // Skip summary rows

        const priority = cells[1].textContent.trim();
        const orderCountText = cells[2].querySelector('p:first-child')?.textContent?.trim() || cells[2].textContent.trim();
        const orderType = cells[2].querySelector('p:nth-child(2)')?.textContent?.trim() || '';
        const shipoutTimeText = cells[4].textContent.trim(); // E.g., "12:00 PM"
        const channel = cells[5].textContent.trim();

        if (!channel || channel.toLowerCase().includes('total')) return null;

        // Map channel to supported marketplace names for rules integration
        let marketplace = 'Amazon';
        if (channel.toLowerCase().includes('flipkart')) {
          marketplace = 'Flipkart';
        } else if (channel.toLowerCase().includes('meesho')) {
          marketplace = 'Meesho';
        }

        // Generate a virtual unique orderId to avoid duplicate notifications
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

    // Map extracted pick lists to standard SLA createdTime
    const mappedOrders = pickLists.map(list => {
      // Parse "12:00 PM" and set createdTime to today's date with that time
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

      return {
        orderId: list.orderId,
        marketplace: list.marketplace,
        createdTime,
        status: list.status,
        customer: list.customer,
        sku: list.sku,
        orderValue: list.orderValue
      };
    });

    console.log(`Priority 2: Successfully scraped ${mappedOrders.length} pick lists from DOM.`);
    return mappedOrders;
  } catch (domErr) {
    console.error('Priority 2: DOM Scraping of pick table failed:', domErr.message);
    throw new Error('Both Network Interception and DOM Scraping failed.');
  }
}

module.exports = { fetchOrders };
