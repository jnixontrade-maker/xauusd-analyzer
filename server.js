const express = require('express');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── VAPID keys for push notifications ──
// Generate once with: npx web-push generate-vapid-keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'YOUR_VAPID_PUBLIC_KEY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'YOUR_VAPID_PRIVATE_KEY';

webpush.setVapidDetails(
  'mailto:trader@xauusd.app',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// In-memory subscription store
let subscriptions = [];

// Last signal posted by the tool — bot polls this
let lastSignal = null;

// ── ROUTES ──

// Serve app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Save push subscription
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  // Avoid duplicates
  const exists = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) subscriptions.push(sub);
  console.log(`[PUSH] New subscriber. Total: ${subscriptions.length}`);
  res.json({ ok: true });
});

// Remove subscription
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  res.json({ ok: true });
});

// Send notification to all subscribers (called by analysis engine)
app.post('/api/notify', async (req, res) => {
  const { signal, confidence, entry, sl, tp1, tp2 } = req.body;
  if (!signal) return res.status(400).json({ error: 'Missing signal data' });

  const payload = JSON.stringify({
    title: `⚡ XAUUSD ${signal}`,
    body: `${confidence}% confidence | Entry: ${entry} | TP1: ${tp1} | SL: ${sl}`,
    signal, confidence, entry, sl, tp1, tp2,
    timestamp: Date.now()
  });

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(sub, payload).catch(err => {
        // Remove dead subscriptions (410 Gone)
        if (err.statusCode === 410) {
          subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
        }
        throw err;
      })
    )
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[PUSH] Sent to ${sent}/${subscriptions.length} subscribers — ${signal} @ ${confidence}%`);
  res.json({ ok: true, sent });
});

// The tool posts its latest signal here after each analysis
app.post('/api/signal', (req, res) => {
  const signal = req.body;
  if (!signal || !signal.signal) return res.status(400).json({ error: 'Missing signal' });
  lastSignal = { ...signal, timestamp: Date.now() };
  console.log('[SIGNAL] Updated:', signal.signal, signal.confidence + '%');
  res.json({ ok: true });
});

// Bot polls this to get the latest signal
app.get('/api/signal', (req, res) => {
  if (!lastSignal) return res.status(404).json({ error: 'No signal yet — run analysis on the tool first' });
  // Only return signals less than 10 minutes old
  const age = (Date.now() - lastSignal.timestamp) / 1000 / 60;
  if (age > 10) return res.status(404).json({ error: 'Signal too old (' + age.toFixed(1) + 'min) — run analysis again' });
  res.json(lastSignal);
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), subscribers: subscriptions.length });
});

// VAPID public key endpoint (needed by frontend to subscribe)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.listen(PORT, () => {
  console.log(`\n🚀 XAUUSD Analyzer running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
