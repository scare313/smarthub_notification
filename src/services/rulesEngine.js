const fs = require('fs');
const path = require('path');
const db = require('../database/sqlite');

const slaConfigPath = path.join(__dirname, '..', 'config', 'sla.json');
const slaConfig = JSON.parse(fs.readFileSync(slaConfigPath, 'utf8'));

/**
 * Parses a HH:MM time string relative to today's date
 */
function getTodayTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/**
 * Evaluates pending orders against SLA rules and database records
 * to determine which alerts need to be sent.
 */
async function processOrders(orders) {
  const activeAlerts = [];
  const now = new Date();

  for (const order of orders) {
    const { orderId, marketplace } = order;
    
    // Ignore unsupported marketplaces
    if (!slaConfig.slas[marketplace]) {
      continue;
    }

    // Save/update order status in the database
    await db.saveOrder(order);

    // Calculate remaining time in minutes
    const slaTimeStr = slaConfig.slas[marketplace];
    const slaDate = getTodayTime(slaTimeStr);
    const diffMs = slaDate - now;
    const remainingMins = Math.floor(diffMs / (1000 * 60));

    // Determine active alert level based on escalation rules
    let alertLevel = 'informational'; // Default level
    
    const escalations = slaConfig.escalations[marketplace] || [];
    // Sort escalations by time ascending to process chronologically
    const sortedEscalations = [...escalations].sort((a, b) => a.time.localeCompare(b.time));

    for (const esc of sortedEscalations) {
      const escDate = getTodayTime(esc.time);
      if (now >= escDate) {
        alertLevel = esc.level; // Upgraded level
      }
    }

    // Check if we already notified for this order at this level or higher
    const notified = await db.hasBeenNotified(orderId, alertLevel);
    if (!notified) {
      activeAlerts.push({
        ...order,
        alertLevel,
        remainingMins
      });
    }
  }

  // Group alerts by marketplace and alert level for batch notifications
  const groupedAlerts = {};
  for (const alert of activeAlerts) {
    const key = `${alert.marketplace}_${alert.alertLevel}`;
    if (!groupedAlerts[key]) {
      groupedAlerts[key] = {
        marketplace: alert.marketplace,
        alertLevel: alert.alertLevel,
        remainingMins: alert.remainingMins,
        orders: []
      };
    }
    groupedAlerts[key].orders.push(alert);
  }

  return {
    allActiveAlerts: activeAlerts,
    groupedAlerts: Object.values(groupedAlerts)
  };
}

module.exports = { processOrders, getTodayTime, slaConfig };
