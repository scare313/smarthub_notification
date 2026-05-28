const fs = require('fs');
const path = require('path');

function setup() {
  console.log('================================━━━━━━━━━━━━━━━━');
  console.log('     SMARTHUB OMS ASSISTANT - WINDOWS STARTUP SETUP     ');
  console.log('================================================================');

  const appDir = path.resolve(__dirname, '..');
  const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const batPath = path.join(startupDir, 'smarthub-oms-assistant.bat');

  // Ensure logs directory exists
  const logsDir = path.join(appDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  if (!fs.existsSync(startupDir)) {
    console.error('❌ Error: Windows Startup directory not found at:', startupDir);
    process.exit(1);
  }

  // Create a clean batch script that runs on startup
  const batContent = `@echo off
title SmartHUB Shipping Alert Assistant
cd /d "${appDir}"
echo [%date% %time%] System started. Booting Shipping Assistant... >> logs\\startup.log
start /min "SmartHUB OMS Assistant" node src\\app.js
`;

  try {
    fs.writeFileSync(batPath, batContent, 'utf8');
    console.log(`\n✅ Startup script successfully created!`);
    console.log(`📂 Path: ${batPath}`);
    console.log(`\nThe assistant is now configured to start automatically in a minimized window`);
    console.log(`whenever your Windows PC boots/restarts. You do not need to start it manually!`);
    console.log('================================================================\n');
  } catch (err) {
    console.error('❌ Failed to write startup file:', err.message);
    process.exit(1);
  }
}

setup();
