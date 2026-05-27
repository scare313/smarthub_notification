require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const authDir = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}
const authPath = path.join(authDir, 'auth.json');

async function startManualLogin() {
  const url = process.env.OMS_URL;
  if (!url || url.includes('localhost:3000')) {
    console.error('\n[Error] Please configure your real OMS_URL in the .env file first!');
    console.error('Example: OMS_URL=https://real-smarthub-url.com\n');
    process.exit(1);
  }

  const dashboardPath = process.env.OMS_DASHBOARD_PATH || '/pick';
  const dashboardPattern = process.env.OMS_DASHBOARD_URL_PATTERN || '**/{dashboard,pick,home}';

  console.log('\n================================================================');
  console.log('         SMARTHUB MANUAL LOGIN SESSION INITIALIZER              ');
  console.log('================================================================');
  console.log(`Launching visible browser and navigating to: ${url}`);
  console.log('1. Please perform your login manually in the browser window.');
  console.log('2. Complete any CAPTCHAs, OTPs, or 2FA if required.');
  console.log(`3. Once you reach the dashboard page (${dashboardPath}), the script`);
  console.log('   will automatically intercept and save your session state.');
  console.log('================================================================\n');

  // Launch headful browser so the user can interact with the page
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'load' });

    // Wait for the dashboard URL pattern to be matched (up to 5 minutes)
    console.log('Waiting for you to log in manually...');
    await page.waitForURL(dashboardPattern, { timeout: 300000 });

    // Wait a brief moment for all session cookies/localstorage to settle
    await page.waitForTimeout(4000);

    // Save session storage state
    await context.storageState({ path: authPath });
    
    console.log('\n================================================================');
    console.log('SUCCESS! Session state saved successfully.');
    console.log(`Session file path: ${authPath}`);
    console.log('Your session is now authorized. You can close the window.');
    console.log('================================================================\n');
  } catch (err) {
    console.error('Error during manual login session initialization:', err.message || err);
  } finally {
    await browser.close();
  }
}

startManualLogin();
