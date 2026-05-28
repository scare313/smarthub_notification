/**
 * API Discovery Script
 * 
 * Navigates to SmartHUB /pick page, clicks through both Create and Active tabs,
 * and captures EVERY network request & response including:
 *   - Full URL
 *   - Request method & headers
 *   - Response status, headers & body
 *   - Cookies used
 * 
 * Output: logs/api_discovery.json
 * 
 * Usage: npm run discover-api
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { authPath } = require('./login');

const logsDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const outputPath = path.join(logsDir, 'api_discovery.json');
const outputReadablePath = path.join(logsDir, 'api_discovery_readable.txt');

async function discoverApis() {
  const url = process.env.OMS_URL || 'https://smarthub.amazon.in';
  const dashboardPath = process.env.OMS_DASHBOARD_PATH || '/pick';
  const headless = process.env.HEADLESS !== 'false';
  const dashboardUrl = url.replace(/\/$/, '') + dashboardPath;

  console.log('='.repeat(70));
  console.log('  SmartHUB API Discovery Tool');
  console.log('='.repeat(70));
  console.log(`Target URL:  ${dashboardUrl}`);
  console.log(`Output JSON: ${outputPath}`);
  console.log(`Output Text: ${outputReadablePath}`);
  console.log(`Headless:    ${headless}`);
  console.log('='.repeat(70));
  console.log('');

  // Check session exists
  if (!fs.existsSync(authPath)) {
    console.error('❌ No session file found. Run `npm run manual-login` first.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless });
  let context;
  try {
    context = await browser.newContext({ storageState: authPath });
  } catch (err) {
    console.error('❌ Failed to load session. Run `npm run manual-login` to re-authenticate.');
    await browser.close();
    process.exit(1);
  }

  const page = await context.newPage();

  // ============================================================
  // Capture storage: cookies from the browser context
  // ============================================================
  const cookies = await context.cookies();
  console.log(`🍪 Loaded ${cookies.length} cookies from session.\n`);

  // ============================================================
  // Set up request/response capture
  // ============================================================
  const capturedRequests = [];
  let requestIndex = 0;

  // We filter to only capture XHR/Fetch/Document requests (skip images, fonts, CSS, etc.)
  const SKIP_RESOURCE_TYPES = new Set([
    'image', 'media', 'font', 'stylesheet', 'manifest', 'other'
  ]);

  // We specifically want to capture API/data responses — skip static assets
  const SKIP_URL_PATTERNS = [
    /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)(\?|$)/i,
    /^data:/,
    /\/static\//,
    /\/assets\//,
    /google-analytics/,
    /googletagmanager/,
    /cloudfront\.net/,
    /sentry\.io/
  ];

  function shouldCapture(url, resourceType) {
    if (SKIP_RESOURCE_TYPES.has(resourceType)) return false;
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) return false;
    }
    return true;
  }

  page.on('request', (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    if (!shouldCapture(url, resourceType)) return;

    const entry = {
      index: requestIndex++,
      timestamp: new Date().toISOString(),
      phase: 'unknown', // will be set based on when it happens
      url,
      method: request.method(),
      resourceType,
      requestHeaders: request.headers(),
      postData: null,
      response: null
    };

    // Capture POST/PUT body
    try {
      const postData = request.postData();
      if (postData) {
        // Try to parse as JSON for readability
        try {
          entry.postData = JSON.parse(postData);
        } catch {
          entry.postData = postData;
        }
      }
    } catch {}

    capturedRequests.push(entry);
  });

  page.on('response', async (response) => {
    const url = response.url();
    const request = response.request();
    const resourceType = request.resourceType();
    if (!shouldCapture(url, resourceType)) return;

    // Find the matching request entry
    const entry = capturedRequests.find(
      e => e.url === url && e.method === request.method() && !e.response
    );
    if (!entry) return;

    const responseHeaders = await response.allHeaders();
    const contentType = responseHeaders['content-type'] || '';
    
    let responseBody = null;
    let bodyTruncated = false;

    try {
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else if (contentType.includes('text/html')) {
        const text = await response.text();
        if (text.length > 2000) {
          responseBody = text.substring(0, 2000) + `\n... [TRUNCATED - ${text.length} total chars]`;
          bodyTruncated = true;
        } else {
          responseBody = text;
        }
      } else if (contentType.includes('text/')) {
        const text = await response.text();
        if (text.length > 2000) {
          responseBody = text.substring(0, 2000) + `\n... [TRUNCATED - ${text.length} total chars]`;
          bodyTruncated = true;
        } else {
          responseBody = text;
        }
      } else {
        // For XHR/fetch with no content-type (e.g. GraphQL), try JSON first
        try {
          const text = await response.text();
          if (text && text.trim().startsWith('{') || text.trim().startsWith('[')) {
            responseBody = JSON.parse(text);
          } else if (text.length > 2000) {
            responseBody = text.substring(0, 2000) + `\n... [TRUNCATED - ${text.length} total chars]`;
            bodyTruncated = true;
          } else {
            responseBody = text || `[Empty body, content-type: ${contentType}]`;
          }
        } catch {
          responseBody = `[Binary content: ${contentType}]`;
        }
      }
    } catch (err) {
      responseBody = `[Error reading body: ${err.message}]`;
    }

    entry.response = {
      status: response.status(),
      statusText: response.statusText(),
      headers: responseHeaders,
      contentType,
      body: responseBody,
      bodyTruncated
    };
  });

  // ============================================================
  // Phase 1: Navigate to /pick (Create tab is default)
  // ============================================================
  console.log('📡 Phase 1: Navigating to /pick page (Create tab)...\n');
  
  const phaseStartIndex = requestIndex;

  try {
    await page.goto(dashboardUrl, { waitUntil: 'load', timeout: 30000 });
  } catch (err) {
    console.error('❌ Navigation failed:', err.message);
  }

  // Wait for page to fully settle and load data
  await page.waitForTimeout(6000);

  // Try clicking today's date card
  try {
    const cards = await page.$$('.awui-pick-create-card');
    if (cards.length > 0) {
      // Click the first available card (default selected)
      const selectedCard = await page.$('.awui-pick-create-card-selected') || cards[0];
      const cardText = await selectedCard.textContent();
      console.log(`📅 Found date card: "${cardText.split('\n')[0].trim()}"`);
      await selectedCard.click();
      await page.waitForTimeout(4000);
    } else {
      console.log('⚠️  No date cards found - might be logged out');
    }
  } catch (err) {
    console.log('⚠️  Error clicking date card:', err.message);
  }

  // Wait for the Create table to potentially load
  try {
    await page.waitForSelector('#awui-pick-recommended-table table', { state: 'visible', timeout: 10000 });
    console.log('✅ Create tab table is visible');
  } catch {
    console.log('⚠️  Create tab table not found within timeout');
  }

  await page.waitForTimeout(3000);

  // Mark all captured requests up to this point as Phase 1
  capturedRequests.forEach(entry => {
    if (entry.phase === 'unknown') entry.phase = 'Phase1_CreateTab';
  });

  const phase1Count = requestIndex - phaseStartIndex;
  console.log(`   Captured ${phase1Count} requests in Phase 1\n`);

  // ============================================================
  // Phase 2: Click "Active pick lists" tab
  // ============================================================
  console.log('📡 Phase 2: Clicking "Active pick lists" tab...\n');
  const phase2StartIndex = requestIndex;

  try {
    await page.locator('label').filter({ hasText: 'Active pick lists' }).click();
    console.log('✅ Clicked Active pick lists tab');
  } catch (err) {
    console.log('⚠️  Could not click Active tab:', err.message);
  }

  // Wait for active table to load
  await page.waitForTimeout(6000);

  try {
    await page.waitForSelector('#awui-pick-active-table table', { state: 'visible', timeout: 10000 });
    console.log('✅ Active tab table is visible');
  } catch {
    console.log('⚠️  Active tab table not found within timeout');
  }

  await page.waitForTimeout(3000);

  // Mark Phase 2
  capturedRequests.forEach(entry => {
    if (entry.phase === 'unknown') entry.phase = 'Phase2_ActiveTab';
  });

  const phase2Count = requestIndex - phase2StartIndex;
  console.log(`   Captured ${phase2Count} requests in Phase 2\n`);

  // ============================================================
  // Phase 3: Try clicking back to Create tab to see if it re-fetches
  // ============================================================
  console.log('📡 Phase 3: Switching back to Create tab (check re-fetch behavior)...\n');
  const phase3StartIndex = requestIndex;

  try {
    await page.locator('label').filter({ hasText: 'Create' }).click();
    console.log('✅ Clicked Create tab');
  } catch (err) {
    console.log('⚠️  Could not click Create tab:', err.message);
  }

  await page.waitForTimeout(6000);

  capturedRequests.forEach(entry => {
    if (entry.phase === 'unknown') entry.phase = 'Phase3_CreateTabRevisit';
  });

  const phase3Count = requestIndex - phase3StartIndex;
  console.log(`   Captured ${phase3Count} requests in Phase 3\n`);

  // ============================================================
  // Compile & Write Results
  // ============================================================
  console.log('='.repeat(70));
  console.log('  DISCOVERY COMPLETE');
  console.log('='.repeat(70));

  // Filter to only JSON API responses (the ones we care about most)
  const apiResponses = capturedRequests.filter(
    e => e.response && e.response.contentType && e.response.contentType.includes('application/json')
  );

  const htmlResponses = capturedRequests.filter(
    e => e.response && e.response.contentType && e.response.contentType.includes('text/html')
  );

  console.log(`\n📊 Summary:`);
  console.log(`   Total captured requests:  ${capturedRequests.length}`);
  console.log(`   JSON API responses:       ${apiResponses.length}`);
  console.log(`   HTML responses:           ${htmlResponses.length}`);
  console.log('');

  // Print JSON API endpoints to console for quick review
  if (apiResponses.length > 0) {
    console.log('🎯 JSON API ENDPOINTS FOUND:');
    console.log('-'.repeat(70));
    apiResponses.forEach(entry => {
      const bodyPreview = typeof entry.response.body === 'object'
        ? JSON.stringify(entry.response.body).substring(0, 120) + '...'
        : String(entry.response.body).substring(0, 120);
      console.log(`  [${entry.phase}] ${entry.method} ${entry.url}`);
      console.log(`    Status: ${entry.response.status} | Preview: ${bodyPreview}`);
      console.log('');
    });
  } else {
    console.log('⚠️  No JSON API endpoints were captured!');
    console.log('   This means the page might use embedded data, GraphQL, or a different pattern.');
  }

  // Compile full output
  const output = {
    discoveryTimestamp: new Date().toISOString(),
    targetUrl: dashboardUrl,
    sessionCookies: cookies.map(c => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expires: c.expires,
      // Mask cookie values for security (show first 8 chars only)
      value: c.value.length > 8 ? c.value.substring(0, 8) + '...[MASKED]' : c.value
    })),
    summary: {
      totalRequests: capturedRequests.length,
      jsonApiResponses: apiResponses.length,
      htmlResponses: htmlResponses.length,
      phase1Requests: phase1Count,
      phase2Requests: phase2Count,
      phase3Requests: phase3Count
    },
    apiEndpoints: apiResponses.map(e => ({
      url: e.url,
      method: e.method,
      phase: e.phase,
      status: e.response?.status
    })),
    allCapturedRequests: capturedRequests
  };

  // Write full JSON output
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n💾 Full JSON log saved to: ${outputPath}`);

  // Write human-readable text summary
  let readable = '';
  readable += '='.repeat(80) + '\n';
  readable += '  SmartHUB API Discovery Report\n';
  readable += `  Generated: ${output.discoveryTimestamp}\n`;
  readable += `  Target: ${dashboardUrl}\n`;
  readable += '='.repeat(80) + '\n\n';

  readable += `COOKIES (${cookies.length}):\n`;
  readable += '-'.repeat(40) + '\n';
  cookies.forEach(c => {
    readable += `  ${c.name} = ${c.value.substring(0, 20)}... (domain: ${c.domain})\n`;
  });
  readable += '\n';

  readable += `ALL CAPTURED REQUESTS (${capturedRequests.length}):\n`;
  readable += '='.repeat(80) + '\n\n';

  capturedRequests.forEach(entry => {
    readable += `----- Request #${entry.index} [${entry.phase}] -----\n`;
    readable += `Timestamp: ${entry.timestamp}\n`;
    readable += `${entry.method} ${entry.url}\n`;
    readable += `Resource Type: ${entry.resourceType}\n\n`;

    readable += `Request Headers:\n`;
    if (entry.requestHeaders) {
      Object.entries(entry.requestHeaders).forEach(([key, value]) => {
        readable += `  ${key}: ${value}\n`;
      });
    }
    readable += '\n';

    if (entry.postData) {
      readable += `Request Body:\n`;
      readable += `  ${typeof entry.postData === 'object' ? JSON.stringify(entry.postData, null, 2) : entry.postData}\n\n`;
    }

    if (entry.response) {
      readable += `Response: ${entry.response.status} ${entry.response.statusText}\n`;
      readable += `Content-Type: ${entry.response.contentType}\n\n`;

      readable += `Response Headers:\n`;
      if (entry.response.headers) {
        Object.entries(entry.response.headers).forEach(([key, value]) => {
          readable += `  ${key}: ${value}\n`;
        });
      }
      readable += '\n';

      readable += `Response Body:\n`;
      if (typeof entry.response.body === 'object') {
        readable += JSON.stringify(entry.response.body, null, 2) + '\n';
      } else if (entry.response.body) {
        readable += entry.response.body + '\n';
      } else {
        readable += '  [empty]\n';
      }
    } else {
      readable += `Response: [No response captured - may still be pending]\n`;
    }
    readable += '\n' + '='.repeat(80) + '\n\n';
  });

  fs.writeFileSync(outputReadablePath, readable, 'utf8');
  console.log(`📄 Human-readable log saved to: ${outputReadablePath}`);

  // Cleanup
  await browser.close();

  console.log('\n✅ Discovery complete! Review the files above to find the API endpoints.');
  console.log('   Look for JSON responses containing order data, pick list data, etc.\n');
}

// Run
discoverApis().catch(err => {
  console.error('❌ Discovery script failed:', err);
  process.exit(1);
});
