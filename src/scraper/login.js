const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { generateTOTP } = require('./totp');

const authDir = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}
const profilePath = path.join(authDir, 'browser_profile');

async function performLogin(url, username, password, headless = true) {
  // Configurable selectors with robust default fallbacks for both Mock Server and real Amazon OMS
  const usernameSelectors = [
    process.env.OMS_LOGIN_USERNAME_SELECTOR,
    '#username',
    '#ap_email',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]'
  ].filter(Boolean);

  const passwordSelectors = [
    process.env.OMS_LOGIN_PASSWORD_SELECTOR,
    '#password',
    '#ap_password',
    'input[type="password"]',
    'input[name="password"]'
  ].filter(Boolean);

  const submitSelectors = [
    process.env.OMS_LOGIN_SUBMIT_SELECTOR,
    '#loginBtn',
    '#signInSubmit',
    'input[type="submit"]',
    'button[type="submit"]',
    '#continue' // Amazon "Continue" button for 2-step username entry
  ].filter(Boolean);

  const dashboardUrlPattern = process.env.OMS_DASHBOARD_URL_PATTERN || '**/{dashboard,pick,home}';

  console.log(`\nStarting automated login using persistent profile at: ${profilePath}`);
  console.log(`Navigating to: ${url}`);

  // Launch with persistent browser context to retain cookies, device fingerprints, and TOTP remember-tokens
  const context = await chromium.launchPersistentContext(profilePath, {
    headless,
    viewport: { width: 1280, height: 800 }
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    // Navigate to login page
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });

    // 1. Resolve and wait for Username Input
    let foundUsernameSelector = null;
    console.log('[Login] Searching for username/email input field...');
    for (const sel of usernameSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 2000 });
        foundUsernameSelector = sel;
        break;
      } catch {}
    }
    if (!foundUsernameSelector) {
      throw new Error(`Could not locate username/email input. Checked: ${usernameSelectors.join(', ')}`);
    }

    // Fill Username
    console.log(`[Login] Filling username: "${username}"`);
    await page.fill(foundUsernameSelector, username);

    // 2. Check if the password field is already visible (One-Step Login)
    let isTwoStepLogin = true;
    let activePasswordSelector = null;
    
    for (const sel of passwordSelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        console.log(`[Login] One-Step Login detected. Password input is already visible.`);
        await el.fill(password);
        activePasswordSelector = sel;
        isTwoStepLogin = false;
        break;
      }
    }

    // 3. Resolve the submit/continue button
    let foundSubmitSelector = null;
    for (const sel of submitSelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        foundSubmitSelector = sel;
        break;
      }
    }
    if (!foundSubmitSelector) {
      throw new Error(`Could not locate visible sign-in submit button. Checked: ${submitSelectors.join(', ')}`);
    }

    if (isTwoStepLogin) {
      console.log('[Login] Two-Step Login detected. Clicking "Continue" to reveal password field...');
      await page.click(foundSubmitSelector);
      await page.waitForTimeout(1000);
      
      // Wait for the password field to become visible
      console.log('[Login] Waiting for password field to appear...');
      for (const sel of passwordSelectors) {
        try {
          await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
          activePasswordSelector = sel;
          break;
        } catch {}
      }
      if (!activePasswordSelector) {
        throw new Error(`Password input did not become visible after clicking Continue. Checked: ${passwordSelectors.join(', ')}`);
      }

      console.log('[Login] Filling password...');
      await page.fill(activePasswordSelector, password);

      // Resolve the password submission button (on two-step, it's often the same or a new button)
      let foundPassSubmitSelector = null;
      for (const sel of submitSelectors) {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          foundPassSubmitSelector = sel;
          break;
        }
      }
      if (!foundPassSubmitSelector) {
        throw new Error(`Could not locate password submit button. Checked: ${submitSelectors.join(', ')}`);
      }

      console.log('[Login] Submitting password...');
      await page.click(foundPassSubmitSelector);
    } else {
      console.log('[Login] Submitting credentials...');
      await page.click(foundSubmitSelector);
    }

    // Wait for either the dashboard redirect OR the 2FA page to load
    try {
      await Promise.race([
        page.waitForURL(dashboardUrlPattern, { timeout: 12000 }),
        page.waitForSelector('input[name="otpCode"], input#auth-mfa-otpcode, input[id*="otp"], input[id*="mfa"]', { timeout: 8000 })
      ]);
    } catch (err) {
      console.log('[Login] Direct dashboard redirect or 2FA screen did not load instantly. Checking page state...');
    }

    // Check if 2-Step Verification (2FA) page is present
    const otpInput = await page.$('input[name="otpCode"], input#auth-mfa-otpcode, input[id*="otp"], input[id*="mfa"]');
    if (otpInput) {
      console.log('[Login] ⚠️ 2-Step Verification (MFA) screen detected!');
      
      const mfaSecret = process.env.OMS_2FA_SECRET;
      if (!mfaSecret) {
        throw new Error(
          '2-Step Verification (2FA) is active on this account, but OMS_2FA_SECRET is not configured in your .env file!\n' +
          'Please obtain your base32 2FA Secret Key from Amazon, add it to your .env file, or run manual-login first.'
        );
      }

      console.log('[Login] Programmatically generating 6-digit TOTP verification code from secret...');
      const otpCode = generateTOTP(mfaSecret);
      console.log(`[Login] Generated Code: ${otpCode}. Autofilling OTP...`);
      await otpInput.fill(otpCode);

      // Check "Don't ask for codes on this device" if present
      const rememberCheckbox = await page.$('input[name="rememberDevice"], #auth-mfa-remember-device, input[id*="remember"]');
      if (rememberCheckbox) {
        console.log('[Login] Checking "Don\'t ask for codes on this device" checkbox...');
        await rememberCheckbox.check().catch(() => {});
      }

      // Click verify / submit and wait for dashboard redirect
      const mfaSubmit = await page.$('#auth-mfa-submit-button, input[type="submit"], button[type="submit"]');
      if (mfaSubmit) {
        console.log('[Login] Submitting OTP verification code...');
        await Promise.all([
          mfaSubmit.click(),
          page.waitForURL(dashboardUrlPattern, { timeout: 20000 })
        ]);
      } else {
        throw new Error('Found 2FA input but could not locate the verification submit button!');
      }
    }

    console.log(`[Login] Successful! Browser profile at ${profilePath} is now authenticated.`);
    return true;
  } catch (err) {
    console.error('[Login] Automated login failed:', err.message || err);
    throw err;
  } finally {
    await context.close();
  }
}

module.exports = { performLogin, profilePath };
