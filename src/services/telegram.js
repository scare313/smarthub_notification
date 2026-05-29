const fs = require('fs');
const path = require('path');
const db = require('../database/sqlite');

function formatShipTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });
  } catch {
    return 'Unknown';
  }
}

function getBeautifulChannelName(o) {
  const rawChannel = o.orderId.split('_')[0];
  switch (rawChannel) {
    case 'SELLER_FLEX':
      return 'Amazon Seller Flex';
    case 'EASY_SHIP':
      return 'Amazon Easy Ship';
    case 'FBA':
      return 'Amazon FBA';
    case 'MFN':
      return 'Amazon Merchant Fulfilled';
    case 'FKSTANDARD':
      return 'Flipkart Standard';
    case 'MEESHO':
      return 'Meesho';
    case 'SHOPIFY':
      return 'Shopify';
    default:
      if (rawChannel.startsWith('P17')) {
        return o.marketplace;
      }
      return rawChannel || o.marketplace;
  }
}

function getChannelEmoji(name) {
  const lower = name.toLowerCase();
  if (lower.includes('amazon')) return '📦';
  if (lower.includes('flipkart')) return '🛍️';
  if (lower.includes('meesho')) return '⚡';
  if (lower.includes('shopify')) return '🛒';
  return '📦';
}

async function sendTelegramAlert(groupAlert, screenshotPath = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';
  const chatIds = rawChatIds.split(',').map(id => id.trim()).filter(Boolean);

  const { marketplace, alertLevel, remainingMins, orders } = groupAlert;

  // Construct message text
  let messageText = '';
  if (orders.length === 1 && orders[0].orderId === 'All Clear') {
    messageText = `<b>🌟 SmartHUB Shipping Assistant 🌟</b>\n`;
    messageText += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    messageText += `<b>✅ STATUS:</b> All Clear!\n`;
    messageText += `<b>🏢 Marketplace:</b> SmartHUB\n\n`;
    messageText += `🎉 No pending or scheduled pick lists found for today. Your dashboard is completely clean!\n`;
    messageText += `━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  } else if (orders.length === 1 && orders[0].orderId === 'Session Logged Out') {
    messageText = `<b>🔥 CRITICAL EMERGENCY: ACTION REQUIRED</b> 🔥\n`;
    messageText += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    messageText += `<b>🚨 SYSTEM STATUS:</b> SESSION LOGGED OUT ❌\n`;
    messageText += `<b>🏢 Portal:</b> SmartHUB Dashboard\n`;
    messageText += `<b>⚠️ Urgency:</b> Immediate / High\n\n`;
    messageText += `Your automated Shipping Alert Assistant has been logged out and can no longer scan for orders!\n\n`;
    messageText += `<b>🛠️ HOW TO RESTORE THE SESSION:</b>\n`;
    messageText += `1️⃣ Open your server/terminal.\n`;
    messageText += `2️⃣ Execute the command:\n`;
    messageText += `   <code>npm run manual-login</code>\n`;
    messageText += `3️⃣ Complete the login process (solve CAPTCHAs/OTP/2FA).\n\n`;
    messageText += `<i>Do not delay! Pending orders might be missed while the session is offline.</i>\n`;
    messageText += `━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  } else {
    let levelEmoji = 'ℹ️';
    if (alertLevel === 'warning') levelEmoji = '⚠️';
    else if (alertLevel === 'urgent') levelEmoji = '🔥';
    else if (alertLevel === 'critical') levelEmoji = '🚨';

    const levelText = `[${levelEmoji}${alertLevel.toUpperCase()}]`;

    messageText = `<b>${levelText} SmartHUB Shipping Alert</b>\n`;
    messageText += `Pending Lists: <b>${orders.length}</b>\n\n`;

    // Group orders by fulfillment channel/type
    const groups = {};
    orders.forEach(o => {
      const channelName = getBeautifulChannelName(o);
      if (!groups[channelName]) {
        groups[channelName] = [];
      }
      groups[channelName].push(o);
    });

    // Append each group's listings
    Object.keys(groups).forEach(channel => {
      const emoji = getChannelEmoji(channel);
      messageText += `<b>${emoji} ${channel.toUpperCase()}</b>\n`;

      groups[channel].forEach(o => {
        const isMissed = o.status === 'missed';
        
        // Clean up sku string for display
        let cleanSku = o.sku;
        const activeListIndex = cleanSku.indexOf(', Active list ID:');
        if (activeListIndex !== -1) {
          cleanSku = cleanSku.substring(0, activeListIndex) + ')';
        }
        if (cleanSku) {
          cleanSku = cleanSku.charAt(0).toUpperCase() + cleanSku.slice(1);
        }

        const shipTimeStr = formatShipTime(o.createdTime);
        const timeLabel = isMissed ? 'MISSED' : `Ship by: ${shipTimeStr}`;
        const finalTimeLabel = isMissed ? `⚠️ <b>[MISSED]</b>` : `Ship by: ${shipTimeStr}`;

        messageText += `- <i>${cleanSku}</i> - ${finalTimeLabel}\n`;
      });
      messageText += `\n`;
    });

    messageText = messageText.trim();
    messageText += `\n\n<i>Please take action to process these orders.</i>`;
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
          formData.append('parse_mode', 'HTML');

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
              parse_mode: 'HTML'
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
