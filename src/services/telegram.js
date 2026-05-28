const fs = require('fs');
const path = require('path');
const db = require('../database/sqlite');

async function sendTelegramAlert(groupAlert, screenshotPath = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';
  const chatIds = rawChatIds.split(',').map(id => id.trim()).filter(Boolean);

  const { marketplace, alertLevel, remainingMins, orders } = groupAlert;

  // Choose emoji based on alert level
  let emoji = 'ℹ️';
  if (alertLevel === 'warning') emoji = '⚠️';
  else if (alertLevel === 'urgent') emoji = '🔥';
  else if (alertLevel === 'critical') emoji = '🚨';

  // Construct message text
  let messageText = '';
  if (orders.length === 1 && orders[0].orderId === 'All Clear') {
    messageText = `ℹ️ SHIPPING STATUS UPDATE\n\n`;
    messageText += `*Marketplace:* SmartHUB\n\n`;
    messageText += `*Status:* All Clear ✅\n\n`;
    messageText += `No pending pick lists are present or scheduled for today.\n`;
  } else if (orders.length === 1 && orders[0].orderId === 'Session Logged Out') {
    messageText = `🚨 *EMERGENCY: SESSION LOGGED OUT*\n\n`;
    messageText += `*Marketplace:* SmartHUB\n\n`;
    messageText += `*Status:* Logged Out ❌\n\n`;
    messageText += `⚠️ *ACTION REQUIRED IMMEDIATELY:*\n`;
    messageText += `Your automated Shipping Alert Assistant has been logged out of the portal!\n\n`;
    messageText += `Kindly log in manually on your server immediately to restore the session:\n`;
    messageText += `1. Open your terminal.\n`;
    messageText += `2. Run command: \`npm run manual-login\`\n`;
    messageText += `3. Solve any CAPTCHAs, OTPs, or 2FA credentials.\n`;
  } else {
    messageText = `${emoji} SHIPPING ALERT\n\n`;
    messageText += `*Marketplace:* ${marketplace}\n\n`;
    messageText += `*Pending Orders:* ${orders.length}\n\n`;
    
    if (remainingMins !== undefined) {
      messageText += `*Remaining Time:* ${remainingMins} mins\n\n`;
    }
    
    messageText += `*Order IDs:*\n`;
    orders.forEach(o => {
      messageText += `\`${o.orderId}\` (${o.sku})\n`;
    });
  }

  // If token is placeholder or not configured, fall back to mock logger
  const isMock = !token || token === 'YOUR_TELEGRAM_BOT_TOKEN' || token === 'mock_token' || chatIds.length === 0 || chatIds.includes('mock_chat_id');
  
  if (isMock) {
    console.log('\n=======================================');
    console.log('[Mock Telegram Alert]');
    console.log(`To Chat IDs: ${chatIds.join(', ') || 'Not Configured'}`);
    console.log('---------------------------------------');
    console.log(messageText);
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      console.log(`[Screenshot Attached]: ${screenshotPath}`);
    }
    console.log('=======================================\n');

    // Record notifications in SQLite database so we prevent duplication
    for (const order of orders) {
      await db.recordNotification(order.orderId, marketplace, alertLevel);
    }
    return true;
  }

  // Attempt real Telegram Bot transmission for each configured Chat ID
  let atLeastOneSuccess = false;

  for (const chatId of chatIds) {
    console.log(`Sending Telegram alert to recipient: ${chatId}...`);
    const maxRetries = 3;
    let recipientSuccess = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let response;
        if (screenshotPath && fs.existsSync(screenshotPath)) {
          // Send as Photo
          const url = `https://api.telegram.org/bot${token}/sendPhoto`;
          const formData = new FormData();
          formData.append('chat_id', chatId);
          formData.append('caption', messageText);
          formData.append('parse_mode', 'Markdown');

          const fileBuffer = fs.readFileSync(screenshotPath);
          const blob = new Blob([fileBuffer], { type: 'image/png' });
          formData.append('photo', blob, 'dashboard.png');

          response = await fetch(url, {
            method: 'POST',
            body: formData
          });
        } else {
          // Send as Text Message
          const url = `https://api.telegram.org/bot${token}/sendMessage`;
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: messageText,
              parse_mode: 'Markdown'
            })
          });
        }

        const result = await response.json();
        if (response.ok && result.ok) {
          console.log(`Successfully sent Telegram alert to ${chatId} for ${marketplace} (${alertLevel})`);
          recipientSuccess = true;
          atLeastOneSuccess = true;
          break;
        } else {
          console.warn(`Telegram API error for ${chatId} (Attempt ${attempt}/${maxRetries}):`, result);
        }
      } catch (err) {
        console.error(`Network error sending Telegram alert to ${chatId} (Attempt ${attempt}/${maxRetries}):`, err);
      }

      if (attempt < maxRetries) {
        // Exponential backoff
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  if (atLeastOneSuccess) {
    // Record notifications in database to prevent duplicates
    for (const order of orders) {
      await db.recordNotification(order.orderId, marketplace, alertLevel);
    }
    return true;
  } else {
    throw new Error(`Failed to send Telegram alert to any of the recipients: ${chatIds.join(', ')}`);
  }
}

module.exports = { sendTelegramAlert };
