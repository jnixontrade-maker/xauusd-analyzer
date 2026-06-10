const express = require('express');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'YOUR_VAPID_PUBLIC_KEY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'YOUR_VAPID_PRIVATE_KEY';
webpush.setVapidDetails('mailto:trader@xauusd.app', VAPID_PUBLIC, VAPID_PRIVATE);

const FINNHUB_KEY    = 'd8kop49r01qut1f6mbe0d8kop49r01qut1f6mbeg';
const FINNHUB_SYMBOL = 'OANDA:XAU_USD';

let subscriptions = [];
let lastSignal = null;

// ══════════════════════════════════════════
// DATA FETCHING — Twelve Data only
// ══════════════════════════════════════════

async function fetchPrice() {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${FINNHUB_SYMBOL}&token=${FINNHUB_KEY}`);
  const d = await r.json();
  if (d.c) return parseFloat(d.c);
  throw new Error('Finnhub price failed: ' + JSON.stringify(d));
}

async function fetchCandles(interval, count) {
  const resMap = { '15m':'15','1h':'60','4h':'D','1d':'D' };
  const resolution = resMap[interval] || '60';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - (count * parseInt(resolution === 'D' ? 86400 : resolution) * 60);
  const r = await fetch(`https://finnhub.io/api/v1/forex/candle?symbol=${FINNHUB_SYMBOL}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
  const d = await r.json();
  if (!d.c || d.s === 'no_data') throw new Error('Finnhub candles failed: ' + JSON.stringify(d));
  return d.t.map((t, i) => ({
    t: t * 1000,
    o: d.o[i],
    h: d.h[i],
    l: d.l[i],
    c: d.c[i]
  }));
}

// ══════════════════════════════════════════
// TECHNICAL HELPERS
// ══════════════════════════════════════════

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
  for (let i = candles.length-3; i >= Math.max(0,candles.length-8); i--) {
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
  const london = t >= 8*60  && t < 17*60;
  const ny     = t >= 13*60 && t < 22*60;
  const isOpen = london || ny;
  const isLondonOpen = t >= 8*60  && t < 9*60;
  const isNYOpen     = t >= 13*60 && t < 14*60;
  return { isOpen, isLondonOpen, isNYOpen, london, ny };
}

// ══════════════════════════════════════════
// STRATEGY 1 — BSL SWEEP SHORT
// Buy side liquidity swept → short trade
// ══════════════════════════════════════════
function scoreBSLSweep(c1h, c15m, bias4h, bias1h, sweep, choch, fvg, session) {
  if (sweep !== 'BSL') return { score: 0, valid: false };
  let score = 0;
  if (bias4h === 'BEARISH') score += 25;
  if (bias1h === 'BEARISH') score += 20;
  if (sweep === 'BSL')      score += 20;
  if (choch === 'BEARISH')  score += 20;
  if (fvg === 'BEARISH')    score += 10;
  if (session.isOpen)       score += 5;
  return { score, valid: score >= 60, direction: 'SHORT', name: 'BSL Sweep → Short' };
}

// ══════════════════════════════════════════
// STRATEGY 2 — SSL SWEEP LONG
// Sell side liquidity swept → long trade
// ══════════════════════════════════════════
function scoreSSLSweep(c1h, c15m, bias4h, bias1h, sweep, choch, fvg, session) {
  if (sweep !== 'SSL') return { score: 0, valid: false };
  let score = 0;
  if (bias4h === 'BULLISH') score += 25;
  if (bias1h === 'BULLISH') score += 20;
  if (sweep === 'SSL')      score += 20;
  if (choch === 'BULLISH')  score += 20;
  if (fvg === 'BULLISH')    score += 10;
  if (session.isOpen)       score += 5;
  return { score, valid: score >= 60, direction: 'LONG', name: 'SSL Sweep → Long' };
}

// ══════════════════════════════════════════
// STRATEGY 3 — FVG / IFVG ENTRY
// Price returns into fair value gap
// ══════════════════════════════════════════
function scoreFVG(c1h, c15m, bias4h, bias1h, sweep, choch, fvg, session) {
  if (fvg === 'NONE') return { score: 0, valid: false };
  let score = 0;
  const isBull = fvg === 'BULLISH';
  if (isBull && bias4h === 'BULLISH') score += 25;
  if (!isBull && bias4h === 'BEARISH') score += 25;
  if (isBull && bias1h === 'BULLISH') score += 20;
  if (!isBull && bias1h === 'BEARISH') score += 20;
  if (isBull && choch === 'BULLISH') score += 20;
  if (!isBull && choch === 'BEARISH') score += 20;
  if (session.isOpen) score += 5;
  // Bonus if sweep aligns
  if (isBull && sweep === 'SSL') score += 10;
  if (!isBull && sweep === 'BSL') score += 10;
  return {
    score,
    valid: score >= 60,
    direction: isBull ? 'LONG' : 'SHORT',
    name: 'FVG / IFVG Entry'
  };
}

// ══════════════════════════════════════════
// STRATEGY 4 — TRADER ZED EXPANSION MODEL
// BSL/SSL sweep + CHoCH + FVG on 4H
// Same Model. Same Time. Same Results.
// ══════════════════════════════════════════
function scoreExpansion(c4h, c1h, bias4h, sweep, choch, fvg, session) {
  let score = 0;
  const isBull = sweep === 'SSL' || (choch === 'BULLISH' && bias4h === 'BULLISH');
  // Criterion 1: Liquidity grab
  if (sweep !== 'NONE') score += 30;
  // Criterion 2: Structure shift
  if (choch !== 'NONE') score += 30;
  // Criterion 3: FVG at shift
  if (fvg !== 'NONE') score += 30;
  // Session bonus — this model works best at opens
  if (session.isLondonOpen || session.isNYOpen) score += 10;
  return {
    score,
    valid: score >= 70 && sweep !== 'NONE' && choch !== 'NONE' && fvg !== 'NONE',
    direction: isBull ? 'LONG' : 'SHORT',
    name: 'Expansion Model (3-Criteria)'
  };
}

// ══════════════════════════════════════════
// STRATEGY 5 — BARD.FX NO-WICK CANDLE
// 85%+ WR — candle with no opposing wick
// at key level = pure momentum entry
// ══════════════════════════════════════════
function detectNoWickCandle(candles) {
  if (!candles || candles.length < 3) return 'NONE';
  const last = candles[candles.length - 1];
  const body = Math.abs(last.c - last.o);
  if (body === 0) return 'NONE';
  const topWick    = last.h - Math.max(last.c, last.o);
  const bottomWick = Math.min(last.c, last.o) - last.l;
  const wickThreshold = body * 0.1; // Wick must be less than 10% of body
  const bullish = last.c > last.o && bottomWick < wickThreshold; // No bottom wick = bullish momentum
  const bearish = last.c < last.o && topWick < wickThreshold;    // No top wick = bearish momentum
  if (bullish) return 'BULLISH';
  if (bearish) return 'BEARISH';
  return 'NONE';
}

function scoreNoWickCandle(c15m, c1h, bias4h, bias1h, fvg, session) {
  const noWick = detectNoWickCandle(c15m);
  if (noWick === 'NONE') return { score: 0, valid: false };
  let score = 0;
  const isBull = noWick === 'BULLISH';
  // No-wick candle at key level
  score += 35;
  // Must align with higher timeframe bias
  if (isBull && bias4h === 'BULLISH') score += 25;
  if (!isBull && bias4h === 'BEARISH') score += 25;
  if (isBull && bias1h === 'BULLISH') score += 20;
  if (!isBull && bias1h === 'BEARISH') score += 20;
  // FVG alignment bonus
  if (isBull && fvg === 'BULLISH') score += 10;
  if (!isBull && fvg === 'BEARISH') score += 10;
  if (session.isOpen) score += 5;
  // This strategy has high WR — boost base score
  const adjustedScore = Math.min(100, score * 1.1);
  return {
    score: Math.round(adjustedScore),
    valid: adjustedScore >= 65,
    direction: isBull ? 'LONG' : 'SHORT',
    name: 'No-Wick Candle Entry (85% WR)',
    noWick
  };
}

// ══════════════════════════════════════════
// STRATEGY 6 — ORB OPENING RANGE BREAKOUT
// Mark range at open, wait for breakout,
// enter on retest of range high/low
// ══════════════════════════════════════════
let orbRange = null;
let orbResetTime = null;

function updateORB(candles5m, session) {
  const now = new Date();
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Reset ORB at London open (08:00) and NY open (13:30)
  const isLondonOpen = t >= 8*60 && t < 8*60+15;
  const isNYOpen     = t >= 13*60+30 && t < 13*60+45;

  if (isLondonOpen || isNYOpen) {
    // Build range from first 5-15 mins of session
    const openCandles = candles5m.slice(-3); // Last 3 x 5min candles = 15 mins
    if (openCandles.length >= 3) {
      orbRange = {
        high: Math.max(...openCandles.map(c=>c.h)),
        low:  Math.min(...openCandles.map(c=>c.l)),
        time: Date.now()
      };
      console.log(`[ORB] Range set: High ${orbRange.high.toFixed(2)} Low ${orbRange.low.toFixed(2)}`);
    }
  }
}

function scoreORB(candles15m, price, session) {
  if (!orbRange) return { score: 0, valid: false };
  // Range must be less than 2 hours old
  if (Date.now() - orbRange.time > 2 * 60 * 60 * 1000) return { score: 0, valid: false };
  if (!session.isOpen) return { score: 0, valid: false };

  const rangeSize = orbRange.high - orbRange.low;
  const aboveRange = price > orbRange.high;
  const belowRange = price < orbRange.low;
  const nearHigh   = Math.abs(price - orbRange.high) < rangeSize * 0.1;
  const nearLow    = Math.abs(price - orbRange.low)  < rangeSize * 0.1;

  // Need breakout + retest
  if (!nearHigh && !nearLow) return { score: 0, valid: false };

  let score = 0;
  const isBull = nearHigh && aboveRange;
  const isBear = nearLow  && belowRange;

  if (isBull || isBear) score += 40;
  if (session.isLondonOpen || session.isNYOpen) score += 20;
  // Check last candle direction aligns
  const last = candles15m[candles15m.length-1];
  if (isBull && last.c > last.o) score += 25;
  if (isBear && last.c < last.o) score += 25;

  return {
    score,
    valid: score >= 60,
    direction: isBull ? 'LONG' : 'SHORT',
    name: 'ORB Opening Range Breakout',
    orbHigh: orbRange.high,
    orbLow: orbRange.low
  };
}

// ══════════════════════════════════════════
// MASTER ANALYSIS ENGINE
// Runs all 6 strategies, picks the best
// ══════════════════════════════════════════
async function runAnalysis() {
  try {
    console.log('[AUTO] Running analysis...');

    // Batch to 4 API calls to stay under daily limit
    // 1m candles derived from 15m, 5m from 15m
    const [c15m, c1h, c4h, price] = await Promise.all([
      fetchCandles('15m', 50),
      fetchCandles('1h',  50),
      fetchCandles('4h',  60),
      fetchPrice()
    ]);
    const c1m = c15m.slice(-10);  // Approximate 1m from recent 15m candles
    const c5m = c15m.slice(-20);  // Approximate 5m from recent 15m candles

    const bias4h  = getBias(c4h);
    const bias1h  = getBias(c1h);
    const bias15m = getBias(c15m);
    const sweep   = detectSweep(c1h);
    const choch   = detectChoch(c15m);
    const fvg     = detectFVG(c15m);
    const session = isSession();
    const atr     = calcATR(c1h);

    // Update ORB range if at session open
    updateORB(c5m, session);

    // Score all 6 strategies
    const strategies = [
      scoreBSLSweep(c1h, c15m, bias4h, bias1h, sweep, choch, fvg, session),
      scoreSSLSweep(c1h, c15m, bias4h, bias1h, sweep, choch, fvg, session),
      scoreFVG(c1h, c15m, bias4h, bias1h, sweep, choch, fvg, session),
      scoreExpansion(c4h, c1h, bias4h, sweep, choch, fvg, session),
      scoreNoWickCandle(c15m, c1h, bias4h, bias1h, fvg, session),
      scoreORB(c15m, price, session)
    ];

    // Pick highest scoring valid strategy
    const valid = strategies.filter(s => s.valid).sort((a,b) => b.score - a.score);
    const best  = valid[0];

    if (!best) {
      console.log(`[AUTO] No valid setup — best score: ${Math.max(...strategies.map(s=>s.score))}%`);
      lastSignal = {
        signal: 'WAIT',
        confidence: 0,
        strategy: 'None',
        reason: 'No strategy meets minimum confluence',
        bias_4h: bias4h, bias_1h: bias1h,
        sweep, choch, fvg,
        in_session: session.isOpen,
        timestamp: Date.now()
      };
      return;
    }

    const isLong  = best.direction === 'LONG';
    const slDist  = atr * 0.8;
    const rr      = 3;

    const entry = price;
    const sl    = isLong ? entry - slDist : entry + slDist;
    const tp1   = isLong ? entry + slDist * rr * 0.5 : entry - slDist * rr * 0.5;
    const tp2   = isLong ? entry + slDist * rr        : entry - slDist * rr;
    const be    = isLong ? entry + slDist * 0.5       : entry - slDist * 0.5;

    // Determine signal type based on confidence
    let signal;
    if (isLong)  signal = best.score >= 70 ? 'BUY LONG'   : 'BUY SHORT';
    else         signal = best.score >= 70 ? 'SELL SHORT'  : 'SELL LONG';

    // Build reason string for the site to display
    const reason = `${best.name} | 4H: ${bias4h} | Sweep: ${sweep} | CHoCH: ${choch} | FVG: ${fvg}`;

    // All strategies and their scores for the site
    const allStrategies = strategies.map((s,i) => ({
      name: s.name || ['BSL Sweep','SSL Sweep','FVG/IFVG','Expansion','No-Wick','ORB'][i],
      score: s.score,
      valid: s.valid,
      direction: s.direction || '—'
    }));

    lastSignal = {
      signal,
      confidence: best.score,
      strategy: best.name,
      reason,
      is_long: isLong,
      entry:   +entry.toFixed(2),
      sl:      +sl.toFixed(2),
      tp1:     +tp1.toFixed(2),
      tp2:     +tp2.toFixed(2),
      be:      +be.toFixed(2),
      bias_4h: bias4h,
      bias_1h: bias1h,
      bias_15m: bias15m,
      sweep, choch, fvg,
      in_session: session.isOpen,
      all_strategies: allStrategies,
      timestamp: Date.now()
    };

    console.log(`[AUTO] SIGNAL: ${signal} | Strategy: ${best.name} | Confidence: ${best.score}%`);
    console.log(`[AUTO] Entry: ${entry.toFixed(2)} | SL: ${sl.toFixed(2)} | TP2: ${tp2.toFixed(2)}`);

    // Push notification if confidence >= 65
    if (best.score >= 65 && subscriptions.length > 0) {
      const payload = JSON.stringify({
        title: `⚡ XAUUSD ${signal}`,
        body: `${best.name} | ${best.score}% | Entry: ${entry.toFixed(2)} | SL: ${sl.toFixed(2)} | TP: ${tp2.toFixed(2)}`
      });
      subscriptions.forEach(sub => webpush.sendNotification(sub, payload).catch(()=>{}));
    }

  } catch(e) {
    console.error('[AUTO] Analysis failed:', e.message);
  }
}

// Smart scheduling — stays under 800 API credits/day
// Asian session (00:00-08:00 UTC): every 20 mins = 24 cycles
// Prime session (08:00-22:00 UTC): every 5 mins = 168 cycles
// Dead zone (22:00-00:00 UTC): every 20 mins = 6 cycles
// Total cycles: ~198 x 4 calls = ~792 credits/day

function getIntervalMs() {
  const t = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (t >= 8*60 && t < 22*60) return 5 * 60 * 1000;   // Prime: every 5 mins
  return 20 * 60 * 1000;                                 // Asian/dead: every 20 mins
}

function scheduleNext() {
  setTimeout(() => {
    runAnalysis();
    scheduleNext();
  }, getIntervalMs());
}

runAnalysis();
scheduleNext();

// ══════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) subscriptions.push(sub);
  console.log(`[PUSH] Subscriber added. Total: ${subscriptions.length}`);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  subscriptions = subscriptions.filter(s => s.endpoint !== req.body.endpoint);
  res.json({ ok: true });
});

// Bot polls this every minute
app.get('/api/signal', (req, res) => {
  if (!lastSignal) return res.status(404).json({ error: 'No signal yet — starting up' });
  const age = (Date.now() - lastSignal.timestamp) / 1000 / 60;
  if (age > 3) return res.status(404).json({ error: `Signal stale (${age.toFixed(1)} min old)` });
  res.json(lastSignal);
});

app.post('/api/notify', async (req, res) => {
  const { signal, confidence, entry, sl, tp1, tp2, strategy } = req.body;
  if (!signal) return res.status(400).json({ error: 'Missing signal' });
  const payload = JSON.stringify({
    title: `⚡ XAUUSD ${signal}`,
    body: `${strategy || ''} | ${confidence}% | Entry: ${entry} | SL: ${sl}`
  });
  await Promise.allSettled(subscriptions.map(sub => webpush.sendNotification(sub, payload).catch(()=>{})));
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    lastSignal: lastSignal ? lastSignal.signal : 'none',
    confidence: lastSignal ? lastSignal.confidence : 0,
    strategy: lastSignal ? lastSignal.strategy : 'none',
    subscribers: subscriptions.length
  });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.listen(PORT, () => {
  console.log(`\n🚀 XAUUSD Analyzer running on port ${PORT}`);
  console.log(`   All 6 strategies active\n`);
});
