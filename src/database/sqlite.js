const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'oms_alerts.db');

let db;

function init() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Failed to connect to SQLite:', err);
        return reject(err);
      }
      
      db.serialize(() => {
        // Create orders table
        db.run(`
          CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT UNIQUE,
            marketplace TEXT,
            status TEXT,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Create notifications table
        db.run(`
          CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT,
            marketplace TEXT,
            alert_level TEXT,
            sent_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(order_id, alert_level)
          )
        `);
      });
      console.log('SQLite Database initialized successfully at:', dbPath);
      resolve();
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function saveOrder(order) {
  const sql = `
    INSERT INTO orders (order_id, marketplace, status, last_seen)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET
      status = excluded.status,
      last_seen = CURRENT_TIMESTAMP
  `;
  return run(sql, [order.orderId, order.marketplace, order.status]);
}

async function hasBeenNotified(orderId, alertLevel) {
  const sql = `
    SELECT id FROM notifications 
    WHERE order_id = ? AND alert_level = ?
  `;
  const row = await get(sql, [orderId, alertLevel]);
  return !!row;
}

async function recordNotification(orderId, marketplace, alertLevel) {
  const sql = `
    INSERT OR IGNORE INTO notifications (order_id, marketplace, alert_level, sent_time)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `;
  return run(sql, [orderId, marketplace, alertLevel]);
}

function close() {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  init,
  run,
  get,
  all,
  saveOrder,
  hasBeenNotified,
  recordNotification,
  close
};
