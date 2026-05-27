const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser('oms-secret-key'));
app.use(express.static(path.join(__dirname, 'public')));

// Simple mock credentials from environment or defaults
const USERNAME = process.env.OMS_USERNAME || 'admin';
const PASSWORD = process.env.OMS_PASSWORD || 'supersecurepassword';

// Middleware to protect routes
function requireAuth(req, res, next) {
  if (req.cookies && req.cookies.session_token === 'authenticated-session-123') {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
}

// Authentication route
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    res.cookie('session_token', 'authenticated-session-123', {
      httpOnly: true,
      maxAge: 3600000 // 1 hour session
    });
    return res.json({ success: true, message: 'Login successful' });
  }
  return res.status(401).json({ success: false, message: 'Invalid username or password' });
});

// Session check
app.get('/api/session', (req, res) => {
  if (req.cookies && req.cookies.session_token === 'authenticated-session-123') {
    return res.json({ authenticated: true });
  }
  return res.json({ authenticated: false });
});

// Mock Orders Data
// Create times relative to today to ensure SLA calculation is reliable
const getMockOrders = () => {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];

  return [
    {
      orderId: "ME1001",
      marketplace: "Meesho",
      createdTime: `${dateStr}T08:30:00+05:30`,
      status: "pending",
      customer: "Rahul Sharma",
      sku: "TSHIRT-BLK-L",
      orderValue: "399.00"
    },
    {
      orderId: "ME1002",
      marketplace: "Meesho",
      createdTime: `${dateStr}T09:15:00+05:30`,
      status: "pending",
      customer: "Priyanka Patel",
      sku: "SHOES-RUN-9",
      orderValue: "1299.00"
    },
    {
      orderId: "FK2001",
      marketplace: "Flipkart",
      createdTime: `${dateStr}T09:00:00+05:30`,
      status: "pending",
      customer: "Amit Verma",
      sku: "WATCH-SLV-01",
      orderValue: "2499.00"
    },
    {
      orderId: "AZ3001",
      marketplace: "Amazon",
      createdTime: `${dateStr}T08:15:00+05:30`,
      status: "pending",
      customer: "Sneha Reddy",
      sku: "PHONE-CASE-12",
      orderValue: "299.00"
    },
    {
      orderId: "AZ3002",
      marketplace: "Amazon",
      createdTime: `${dateStr}T09:40:00+05:30`,
      status: "pending",
      customer: "Vikram Singh",
      sku: "EARBUDS-PRO",
      orderValue: "1999.00"
    }
  ];
};

app.get('/api/orders', requireAuth, (req, res) => {
  res.json({ orders: getMockOrders() });
});

// Dashboard page route
app.get('/dashboard', (req, res) => {
  if (req.cookies && req.cookies.session_token === 'authenticated-session-123') {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  } else {
    res.redirect('/');
  }
});

// Logout route
app.post('/api/logout', (req, res) => {
  res.clearCookie('session_token');
  res.json({ success: true, message: 'Logged out successfully' });
});

app.listen(PORT, () => {
  console.log(`Mock SmartHUB OMS Server running on port ${PORT}`);
});
