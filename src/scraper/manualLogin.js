require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const authDir = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}
const profilePath = path.join(authDir, 'browser_profile');

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
  console.log(`Using persistent browser profile at: ${profilePath}`);
  console.log(`Launching visible browser and navigating to: ${url}`);
  console.log('\n1. Please perform your login manually in the browser window.');
  console.log('2. Complete any CAPTCHAs, OTPs, or 2-Step Verification (2FA).');
  console.log('3. Ensure you check "Don\'t ask for codes on this device" if prompted.');
  console.log(`4. Once you reach the dashboard page (${dashboardPath}), the script`);
  console.log('   will automatically save the profile, device details, and close.');
  console.log('================================================================\n');

  // Launch persistent context so that everything the user does (including device cookies,
  // 2FA authorization flags, and browser fingerprints) is saved directly to disk.
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'load' });

    // Wait for the dashboard URL pattern to be matched (up to 5 minutes)
    console.log('Waiting for you to log in manually in the browser window...');
    await page.waitForURL(dashboardPattern, { timeout: 300000 });

    console.log('[Manual Login] Dashboard reached! Letting session data settle...');
    await page.waitForTimeout(5000);
    
    console.log('\n================================================================');
    console.log('SUCCESS! Session state and device flags saved successfully.');
    console.log(`Persistent Profile Directory: ${profilePath}`);
    console.log('Your browser is now fully authorized for future automated runs.');
    console.log('================================================================\n');
  } catch (err) {
    console.error('Error during manual login session initialization:', err.message || err);
  } finally {
    await context.close();
  }
}

startManualLogin();
