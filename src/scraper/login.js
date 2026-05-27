const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const authDir = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}
const authPath = path.join(authDir, 'auth.json');

async function performLogin(url, username, password, headless = true) {
  const usernameSelector = process.env.OMS_LOGIN_USERNAME_SELECTOR || '#username';
  const passwordSelector = process.env.OMS_LOGIN_PASSWORD_SELECTOR || '#password';
  const submitButtonSelector = process.env.OMS_LOGIN_SUBMIT_SELECTOR || '#loginBtn';
  const dashboardUrlPattern = process.env.OMS_DASHBOARD_URL_PATTERN || '**/dashboard';

  console.log(`Starting automated login to SmartHUB OMS at ${url}...`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to login page
    await page.goto(url, { waitUntil: 'networkidle' });

    // Fill in credentials using configurable selectors
    await page.waitForSelector(usernameSelector, { timeout: 10000 });
    await page.fill(usernameSelector, username);
    await page.fill(passwordSelector, password);

    // Click Sign In and wait for redirect to dashboard
    await Promise.all([
      page.click(submitButtonSelector),
      page.waitForURL(dashboardUrlPattern, { timeout: 15000 })
    ]);

    // Save session storage state
    await context.storageState({ path: authPath });
    console.log(`Login successful! Session state saved to ${authPath}`);
    return true;
  } catch (err) {
    console.error('Login automation failed:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { performLogin, authPath };
