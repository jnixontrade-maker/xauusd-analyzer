const express = require('express');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// VAPID keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'YOUR_VAPID_PUBLIC_KEY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'YOUR_VAPID_PRIVATE_KEY';
webpush.setVapidDetails('mailto:trader@xauusd.app', VAPID_PUBLIC, VAPID_PRIVATE);

let subscriptions = [];
let lastSignal = null;

// ── AUTO ANALYSIS ENGINE ──
// Runs every 5 minutes on the server — no button needed

async function fetchPrice() {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d');
  const d = await r.json();
  return d.chart.result[0].meta.regularMarketPrice;
}

async function fetchCandles(interval, count) {
  const rangeMap = { '1m':'1d', '15m':'5d', '60m':'1mo', '1d':'3mo' };
  const range = rangeMap[interval] || '1mo';
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`);
  const d = await r.json();
  const result = d.chart.result[0];
  const ts = result.timestamp;
  const q  = result.indicators.quote[0];
  const out = [];
  for (let i = Math.max(0, ts.length - count); i < ts.length; i++) {
    if (q.open[i] == null) continue;
    out.push({ t: ts[i]*1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}

function ema(data, period) {
  const k = 2 / (period + 1);
  let e = data[0];
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

function getBias(candles) {
  if (!candles || candles.length < 10) return 'NEUTRAL';
  const sl = candles.slice(-20);
  const highs = sl.map(c => c.h);
  const lows  = sl.map(c => c.l);
  const hh = highs[highs.length-1] > Math.max(...highs.slice(0,-5));
  const hl = lows[lows.length-1]   > Math.min(...lows.slice(0,-5));
  const lh = highs[highs.length-1] < Math.max(...highs.slice(0,-5));
  const ll = lows[lows.length-1]   < Math.min(...lows.slice(0,-5));
  if (hh && hl) return 'BULLISH';
  if (lh && ll) return 'BEARISH';
  const closes = sl.map(c => c.c);
  if (ema(closes, 9) > ema(closes, 21)) return 'BULLISH';
  if (ema(closes, 9) < ema(closes, 21)) return 'BEARISH';
  return 'NEUTRAL';
}

function detectSweep(candles) {
  if (!candles || candles.length < 10) return 'NONE';
  const recent = candles.slice(-10);
  const swingHigh = Math.max(...recent.slice(0,-3).map(c=>c.h));
  const swingLow  = Math.min(...recent.slice(0,-3).map(c=>c.l));
  const prev = recent[recent.length-2];
  if (prev.h > swingHigh && prev.c < swingHigh) return 'BSL';
  if (prev.l < swingLow  && prev.c > swingLow)  return 'SSL';
  return 'NONE';
}

function detectChoch(candles) {
  if (!candles || candles.length < 10) return 'NONE';
  const recent = candles.slice(-15);
  for (let i = recent.length-1; i >= 5; i--) {
    const swingHigh = Math.max(...recent.slice(i-5,i).map(c=>c.h));
    const swingLow  = Math.min(...recent.slice(i-5,i).map(c=>c.l));
    if (recent[i].c > swingHigh) return 'BULLISH';
    if (recent[i].c < swingLow)  return 'BEARISH';
  }
  return 'NONE';
}

function detectFVG(candles) {
  for (let i = candles.length-3; i >= Math.max(0, candles.length-8); i--) {
    const c1 = candles[i], c3 = candles[i+2];
    if (!c3) continue;
    if (c3.l > c1.h) return 'BULLISH';
    if (c3.h < c1.l) return 'BEARISH';
  }
  return 'NONE';
}

function calcATR(candles, period=14) {
  if (!candles || candles.length < period+1) return 5;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    ));
  }
  return trs.slice(-period).reduce((a,b)=>a+b,0) / period;
}

function isSession() {
  const now = new Date();
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (t >= 8*60 && t < 17*60) || (t >= 13*60 && t < 22*60);
}

async function runAnalysis() {
  try {
    console.log('[AUTO] Running analysis...');
    const [c1m, c15m, c1h, c4h, price] = await Promise.all([
      fetchCandles('1m',  30),
      fetchCandles('15m', 50),
      fetchCandles('60m', 50),
      fetchCandles('1d',  60),
      fetchPrice()
    ]);

    const bias4h  = getBias(c4h);
    const bias1h  = getBias(c1h);
    const bias15m = getBias(c15m);
    const sweep   = detectSweep(c1h);
    const choch   = detectChoch(c15m);
    const fvg     = detectFVG(c15m);
    const session = isSession();

    let bull = 0, bear = 0;
    if (bias4h  === 'BULLISH') bull += 2; else if (bias4h  === 'BEARISH') bear += 2;
    if (bias1h  === 'BULLISH') bull += 2; else if (bias1h  === 'BEARISH') bear += 2;
    if (bias15m === 'BULLISH') bull += 1; else if (bias15m === 'BEARISH') bear += 1;
    if (sweep === 'SSL') bull += 2; else if (sweep === 'BSL') bear += 2;
    if (choch === 'BULLISH') bull += 2; else if (choch === 'BEARISH') bear += 2;
    if (fvg   === 'BULLISH') bull += 1; else if (fvg   === 'BEARISH') bear += 1;

    const isBull     = bull >= bear;
    const confidence = Math.round((Math.max(bull, bear) / 10) * 100);
    const atr        = calcATR(c1h);
    const slDist     = atr * 0.8;
    const rr         = 3;

    let signal;
    if (isBull)  signal = confidence >= 70 ? 'BUY LONG'   : 'BUY SHORT';
    else         signal = confidence >= 70 ? 'SELL SHORT'  : 'SELL LONG';

    const entry = price;
    const sl    = isBull ? entry - slDist : entry + slDist;
    const tp1   = isBull ? entry + slDist * rr * 0.5 : entry - slDist * rr * 0.5;
    const tp2   = isBull ? entry + slDist * rr        : entry - slDist * rr;
    const be    = isBull ? entry + slDist * 0.5       : entry - slDist * 0.5;

    lastSignal = {
      signal, confidence,
      is_long: isBull,
      entry:   +entry.toFixed(2),
      sl:      +sl.toFixed(2),
      tp1:     +tp1.toFixed(2),
      tp2:     +tp2.toFixed(2),
      be:      +be.toFixed(2),
      bias_4h: bias4h, bias_1h: bias1h,
      sweep, choch, fvg,
      in_session: session,
      timestamp: Date.now()
    };

    console.log(`[AUTO] Signal: ${signal} | Confidence: ${confidence}% | 4H: ${bias4h} | Sweep: ${sweep} | CHoCH: ${choch}`);

    // Push notification if high confidence
    if (confidence >= 65 && subscriptions.length > 0) {
      const payload = JSON.stringify({
        title: `XAUUSD ${signal}`,
        body: `${confidence}% confidence | Entry: ${entry.toFixed(2)} | TP: ${tp2.toFixed(2)} | SL: ${sl.toFixed(2)}`
      });
      subscriptions.forEach(sub => webpush.sendNotification(sub, payload).catch(()=>{}));
    }

  } catch(e) {
    console.error('[AUTO] Analysis failed:', e.message);
  }
}

// Run immediately on server start, then every 5 minutes
runAnalysis();
setInterval(runAnalysis, 5 * 60 * 1000);

// ── ROUTES ──

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) subscriptions.push(sub);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  subscriptions = subscriptions.filter(s => s.endpoint !== req.body.endpoint);
  res.json({ ok: true });
});

// Bot polls this every minute
app.get('/api/signal', (req, res) => {
  if (!lastSignal) return res.status(404).json({ error: 'No signal yet' });
  const age = (Date.now() - lastSignal.timestamp) / 1000 / 60;
  if (age > 10) return res.status(404).json({ error: 'Signal stale' });
  res.json(lastSignal);
});

app.post('/api/notify', async (req, res) => {
  const { signal, confidence, entry, sl, tp1, tp2 } = req.body;
  if (!signal) return res.status(400).json({ error: 'Missing signal' });
  const payload = JSON.stringify({ title: `XAUUSD ${signal}`, body: `${confidence}% | Entry: ${entry} | SL: ${sl}` });
  await Promise.allSettled(subscriptions.map(sub => webpush.sendNotification(sub, payload).catch(()=>{})));
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), lastSignal: lastSignal ? lastSignal.signal : 'none', confidence: lastSignal ? lastSignal.confidence : 0 });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.listen(PORT, () => {
  console.log(`XAUUSD Analyzer running on port ${PORT}`);
});
