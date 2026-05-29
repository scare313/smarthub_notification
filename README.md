# SmartHUB OMS Shipping Alert Assistant

A production-ready, automated alert and monitoring system that periodically checks pending orders inside SmartHUB OMS, processes them against marketplace SLA/escalation deadlines, and dispatches urgent notifications with dashboard screenshot attachments to Telegram.

---

## Technical Features
- **Intelligent Playwright Extraction**: Uses network request inspection (Priority 1 XHR interception of `/api/orders`) and DOM scraping (Priority 2 fallback `table > tbody > tr`) to ensure robust data extraction even if the dashboard interface updates.
- **Session Persistence**: Maintains persistent authorization states in `src/storage/auth.json` to prevent repeated logins. Automatically detects expired cookies and performs automatic re-logins.
- **Dynamic Scheduler**: Node-cron task executing every 5 minutes. It automatically toggles into **Fast Mode (5m)** if any orders are within 60 minutes of their SLA deadlines, and falls back to **Normal Mode (15m)** once deadlines are clear.
- **Duplicate Prevention**: Keeps an indexed SQLite database of all historical alerts (`notifications` table) to guarantee merchants are never messaged multiple times for the same order and severity level.
- **Resilient Fallback Mode**: Contains built-in mock handlers for Telegram notifications so developers can test logic and view alerts in local logs without any real-world tokens.

---

## Folder Structure
```
c:\Automation\Smarthub_Notification/
├── package.json             # App dependencies
├── .env.example             # Configuration templates
├── .env                     # Production environment settings
├── Dockerfile               # Playwright/Chromium isolated container definition
├── docker-compose.yml       # Devops configuration for fast launch and persistent volumes
├── README.md                # System documentation
├── src/
│   ├── scraper/
│   │   ├── login.js         # Automated Playwright login state generator
│   │   ├── orders.js        # Main orders extractor (interception & DOM fallback)
│   │   └── networkInterceptor.js # Sniffs background JSON calls
│   ├── services/
│   │   ├── telegram.js      # Robust Telegram alert client with retry loops
│   │   └── rulesEngine.js   # SLA rules matcher & alert grouper
│   ├── scheduler/
│   │   └── cron.js          # Dynamic scheduler controller
│   ├── database/
│   │   └── sqlite.js        # Promise-based SQLite helper
│   ├── config/
│   │   └── sla.json         # SLA and escalation levels mapping rules
│   ├── storage/             # Contains auth.json session and SQLite database files
│   └── app.js               # Application bootstrap
├── screenshots/             # Storage for dashboard capture artifacts
├── logs/                    # Folder for app.log files
└── mock-server/             # Local testing framework simulating SmartHUB OMS
    ├── public/              # High-fidelity dashboard & login page mockup
    └── server.js            # Mock backend endpoint controller
```

---

## Setup & Execution

### 1. Environment Variables (`.env`)
Create a `.env` file in the root directory (pre-configured to run against local Mock Server):
```ini
OMS_URL=http://localhost:3000
OMS_USERNAME=admin
OMS_PASSWORD=supersecurepassword
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_TELEGRAM_CHAT_ID
CHECK_INTERVAL=15
HEADLESS=true
```

### 2. Standard Local Start
If Node/NPM are installed locally:
```bash
# Install dependencies
npm install

# Start the mock SmartHUB OMS Server (running on port 3000)
npm run mock-server

# In a new terminal, launch the Alert System orchestrator
npm start
```

### 3. Isolated Docker Start
If Docker is installed:
```bash
# Build and run the entire ecosystem (Mock OMS + Alert System) in an isolated container
docker compose up --build
```
> All logs, SQLite databases (`src/storage/`), credentials (`auth.json`), and dashboard screenshots (`screenshots/`) will persist on your host machine via mapped container volumes.

---

## 4. Manual Session Setup & 2-Step Verification (2FA) Automation

To bypass Multi-Factor Authentication (OTP, 2-Step Verification) securely, this system implements two advanced mechanisms:

### Option A: Persistent Browser Context Profile (Device Authorization)
The system stores full browser configurations (cookies, LocalStorage, IndexedDB, and browser device fingerprints) in the persistent folder: `src/storage/browser_profile`.
When you perform your manual login:
1. Run the manual session builder:
   ```bash
   npm run manual-login
   ```
2. A visible browser window will open. Perform your login manually, and complete any CAPTCHAs, OTPs, or 2FA checks.
3. **CRITICAL:** Make sure you check the **"Don't ask for codes on this device"** checkbox in the browser!
4. Once you reach the dashboard page (`/pick`), the script will automatically close and save your browser profile and authorized device token on the disk.
5. The automated checks (`npm start`) will now reuse the exact same browser profile fingerprint, bypassing 2FA prompts entirely for months!

### Option B: 100% Programmatic 2-Step Verification (TOTP Generator)
If you want the assistant to be completely self-healing and perform automated logins even if Amazon expires your session, you can automate OTP generation:
1. Go to your Amazon Seller Account settings under **Login & security** -> **2-Step Verification**.
2. Click **Add new Authenticator App**.
3. Amazon will show a QR Code. Look for the link below it that says: **"Can't scan the barcode? Click here"**.
4. Copy the alphanumeric **Secret Key** string displayed (e.g. `JBSWY3DPEHPK3PXP`).
5. Paste this key in your `.env` file:
   ```ini
   OMS_2FA_SECRET=JBSWY3DPEHPK3PXP
   ```
6. The assistant will now automatically generate the required 6-digit verification code using the standard TOTP algorithm (zero dependencies) and complete 2FA login steps completely on its own!

---

## SLA & Escalation Rules (`src/config/sla.json`)
The rules can be fine-tuned directly in the JSON mapping:
```json
{
  "slas": {
    "Meesho": "11:00",
    "Flipkart": "12:00",
    "Amazon": "15:00"
  },
  "escalations": {
    "Meesho": [
      { "time": "10:00", "level": "warning" },
      { "time": "10:30", "level": "urgent" },
      { "time": "10:50", "level": "critical" }
    ],
    ...
  }
}
```
- **Meesho**: Dispatch SLA at 11:00 AM. Triggers `warning` at 10:00, `urgent` at 10:30, and `critical` at 10:50.
- **Flipkart**: Dispatch SLA at 12:00 PM. Triggers `warning` at 11:00, `urgent` at 11:30, and `critical` at 11:50.
- **Amazon**: Dispatch SLA at 3:00 PM. Triggers `warning` at 14:00, `urgent` at 14:30, and `critical` at 14:50.

---

## Log Entries format (`logs/app.log`)
The system records all lifecycle statuses, run cycles, task durations, and exceptions in a standardized format:
```
[2026-05-27T04:25:00.000Z] Task: FetchOrdersCycle | Status: STARTED
[2026-05-27T04:25:03.120Z] Task: FetchOrders | Status: SUCCESS | Duration: 3120ms
[2026-05-27T04:25:03.140Z] Task: RulesEngine | Status: SUCCESS
[2026-05-27T04:25:03.150Z] Task: SendTelegramAlert:Meesho:warning | Status: STARTED
[2026-05-27T04:25:03.580Z] Task: SendTelegramAlert:Meesho:warning | Status: SUCCESS
[2026-05-27T04:25:03.600Z] Task: FetchOrdersCycle | Status: SUCCESS | Duration: 3600ms
```
