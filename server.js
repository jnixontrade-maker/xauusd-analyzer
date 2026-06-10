const express = require('express');
const path    = require('path');
const webpush = require('web-push');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'YOUR_VAPID_PUBLIC_KEY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'YOUR_VAPID_PRIVATE_KEY';
webpush.setVapidDetails('mailto:trader@xauusd.app', VAPID_PUBLIC, VAPID_PRIVATE);

let subscriptions = [];
let lastSignal    = null;

// ══════════════════════════════════════════
// DATA — Yahoo Finance XAUUSD=X (spot gold)
// No API key, no daily limit, correct prices
// ══════════════════════════════════════════

async function fetchPrice() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD%3DX?interval=1m&range=1d';
  const res = await fetch(url);
  const d   = await res.json();
  const p   = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (p) return parseFloat(p);
  throw new Error('Price fetch failed');
}

async function fetchCandles(interval, count) {
  // Yahoo Finance supported intervals for XAUUSD=X: 5m, 60m, 1d
  // We map 15m -> 5m (more granular), 4h -> 1d (daily for trend)
  const intervalMap = { '15m':'5m',  '1h':'60m', '4h':'1d' };
  const rangeMap    = { '15m':'5d',  '1h':'2y',  '4h':'5y' };
  const yInterval   = intervalMap[interval] || '60m';
  const yRange      = rangeMap[interval]    || '1mo';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD%3DX?interval=${yInterval}&range=${yRange}`;
  const res = await fetch(url);
  const d   = await res.json();
  const result = d?.chart?.result?.[0];
  if (!result) throw new Error(`No candle data for ${interval}`);
  const ts = result.timestamp;
  const q  = result.indicators.quote[0];
  const out = [];
  for (let i = Math.max(0, ts.length - count); i < ts.length; i++) {
    if (q.open[i] == null) continue;
    out.push({ t: ts[i]*1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  if (out.length === 0) throw new Error(`Empty candles for ${interval}`);
  return out;
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
  const sl    = candles.slice(-20);
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
  const recent    = candles.slice(-10);
  const swingHigh = Math.max(...recent.slice(0,-3).map(c=>c.h));
  const swingLow  = Math.min(...recent.slice(0,-3).map(c=>c.l));
  const prev      = recent[recent.length-2];
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
  const t   = now.getUTCHours() * 60 + now.getUTCMinutes();
  return {
    isOpen:        (t >= 8*60 && t < 17*60) || (t >= 13*60 && t < 22*60),
    isLondonOpen:   t >= 8*60  && t < 9*60,
    isNYOpen:       t >= 13*60 && t < 14*60,
    london:         t >= 8*60  && t < 17*60,
    ny:             t >= 13*60 && t < 22*60
  };
}

// ══════════════════════════════════════════
// 6 STRATEGIES
// ══════════════════════════════════════════

function scoreBSLSweep(bias4h, bias1h, sweep, choch, fvg, session) {
  if (sweep !== 'BSL') return { score:0, valid:false };
  let score = 0;
  if (bias4h === 'BEARISH') score += 25;
  if (bias1h === 'BEARISH') score += 20;
  score += 20; // BSL confirmed
  if (choch === 'BEARISH')  score += 20;
  if (fvg   === 'BEARISH')  score += 10;
  if (session.isOpen)       score += 5;
  return { score, valid: score >= 60, direction:'SHORT', name:'BSL Sweep → Short' };
}

function scoreSSLSweep(bias4h, bias1h, sweep, choch, fvg, session) {
  if (sweep !== 'SSL') return { score:0, valid:false };
  let score = 0;
  if (bias4h === 'BULLISH') score += 25;
  if (bias1h === 'BULLISH') score += 20;
  score += 20;
  if (choch === 'BULLISH')  score += 20;
  if (fvg   === 'BULLISH')  score += 10;
  if (session.isOpen)       score += 5;
  return { score, valid: score >= 60, direction:'LONG', name:'SSL Sweep → Long' };
}

function scoreFVG(bias4h, bias1h, sweep, choch, fvg, session) {
  if (fvg === 'NONE') return { score:0, valid:false };
  const isBull = fvg === 'BULLISH';
  let score = 0;
  if (isBull  && bias4h === 'BULLISH') score += 25;
  if (!isBull && bias4h === 'BEARISH') score += 25;
  if (isBull  && bias1h === 'BULLISH') score += 20;
  if (!isBull && bias1h === 'BEARISH') score += 20;
  if (isBull  && choch  === 'BULLISH') score += 20;
  if (!isBull && choch  === 'BEARISH') score += 20;
  if (isBull  && sweep  === 'SSL')     score += 10;
  if (!isBull && sweep  === 'BSL')     score += 10;
  if (session.isOpen) score += 5;
  return { score, valid: score >= 60, direction: isBull ? 'LONG':'SHORT', name:'FVG / IFVG Entry' };
}

function scoreExpansion(bias4h, sweep, choch, fvg, session) {
  if (sweep === 'NONE' || choch === 'NONE' || fvg === 'NONE') return { score:0, valid:false };
  let score = 30 + 30 + 30; // All 3 criteria met
  if (session.isLondonOpen || session.isNYOpen) score += 10;
  const isBull = sweep === 'SSL' || (choch === 'BULLISH' && bias4h === 'BULLISH');
  return { score, valid: true, direction: isBull ? 'LONG':'SHORT', name:'Expansion Model (3-Criteria)' };
}

function detectNoWick(candles) {
  if (!candles || candles.length < 2) return 'NONE';
  const last = candles[candles.length-1];
  const body = Math.abs(last.c - last.o);
  if (body === 0) return 'NONE';
  const topWick    = last.h - Math.max(last.c, last.o);
  const bottomWick = Math.min(last.c, last.o) - last.l;
  const thresh     = body * 0.1;
  if (last.c > last.o && bottomWick < thresh) return 'BULLISH';
  if (last.c < last.o && topWick    < thresh) return 'BEARISH';
  return 'NONE';
}

function scoreNoWick(c15m, bias4h, bias1h, fvg, session) {
  const nw = detectNoWick(c15m);
  if (nw === 'NONE') return { score:0, valid:false };
  const isBull = nw === 'BULLISH';
  let score = 35;
  if (isBull  && bias4h === 'BULLISH') score += 25;
  if (!isBull && bias4h === 'BEARISH') score += 25;
  if (isBull  && bias1h === 'BULLISH') score += 20;
  if (!isBull && bias1h === 'BEARISH') score += 20;
  if (isBull  && fvg   === 'BULLISH')  score += 10;
  if (!isBull && fvg   === 'BEARISH')  score += 10;
  if (session.isOpen) score += 5;
  const adj = Math.min(100, Math.round(score * 1.1));
  return { score: adj, valid: adj >= 65, direction: isBull ? 'LONG':'SHORT', name:'No-Wick Candle Entry (85% WR)' };
}

let orbRange = null;

function updateORB(c15m, session) {
  const t = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if ((t >= 8*60 && t < 8*60+20) || (t >= 13*60+30 && t < 13*60+50)) {
    const open = c15m.slice(-3);
    if (open.length >= 2) {
      orbRange = {
        high: Math.max(...open.map(c=>c.h)),
        low:  Math.min(...open.map(c=>c.l)),
        time: Date.now()
      };
    }
  }
}

function scoreORB(c15m, price, session) {
  if (!orbRange || !session.isOpen) return { score:0, valid:false };
  if (Date.now() - orbRange.time > 2*60*60*1000) return { score:0, valid:false };
  const range   = orbRange.high - orbRange.low;
  const nearHigh = Math.abs(price - orbRange.high) < range * 0.15;
  const nearLow  = Math.abs(price - orbRange.low)  < range * 0.15;
  if (!nearHigh && !nearLow) return { score:0, valid:false };
  let score  = 40;
  const isBull = nearHigh && price > orbRange.high;
  const isBear = nearLow  && price < orbRange.low;
  if (!isBull && !isBear) return { score:0, valid:false };
  if (session.isLondonOpen || session.isNYOpen) score += 20;
  const last = c15m[c15m.length-1];
  if (isBull && last.c > last.o) score += 25;
  if (isBear && last.c < last.o) score += 25;
  return { score, valid: score >= 60, direction: isBull ? 'LONG':'SHORT', name:'ORB Opening Range Breakout' };
}

// ══════════════════════════════════════════
// MASTER ANALYSIS
// ══════════════════════════════════════════

async function runAnalysis() {
  try {
    console.log('[AUTO] Running analysis...');
    const [c15m, c1h, c4h, price] = await Promise.all([
      fetchCandles('15m', 50),
      fetchCandles('1h',  50),
      fetchCandles('4h',  60),
      fetchPrice()
    ]);

    const bias4h  = getBias(c4h);
    const bias1h  = getBias(c1h);
    const bias15m = getBias(c15m);
    const sweep   = detectSweep(c1h);
    const choch   = detectChoch(c15m);
    const fvg     = detectFVG(c15m);
    const session = isSession();
    const atr     = calcATR(c1h);

    updateORB(c15m, session);

    const strategies = [
      scoreBSLSweep(bias4h, bias1h, sweep, choch, fvg, session),
      scoreSSLSweep(bias4h, bias1h, sweep, choch, fvg, session),
      scoreFVG(bias4h, bias1h, sweep, choch, fvg, session),
      scoreExpansion(bias4h, sweep, choch, fvg, session),
      scoreNoWick(c15m, bias4h, bias1h, fvg, session),
      scoreORB(c15m, price, session)
    ];

    const stratNames = ['BSL Sweep → Short','SSL Sweep → Long','FVG / IFVG Entry','Expansion Model (3-Criteria)','No-Wick Candle Entry (85% WR)','ORB Opening Range Breakout'];
    strategies.forEach((s,i) => { if (!s.name) s.name = stratNames[i]; });

    const valid = strategies.filter(s => s.valid).sort((a,b) => b.score - a.score);
    const best  = valid[0];

    if (!best) {
      const top = Math.max(...strategies.map(s=>s.score));
      console.log(`[AUTO] No valid setup — top score: ${top}%`);
      lastSignal = {
        signal:'WAIT', confidence:0, strategy:'None',
        reason:'No strategy meets minimum confluence',
        bias_4h:bias4h, bias_1h:bias1h, sweep, choch, fvg,
        in_session:session.isOpen,
        all_strategies: strategies.map((s,i)=>({ name:stratNames[i], score:s.score||0, valid:s.valid||false, direction:s.direction||'—' })),
        timestamp: Date.now()
      };
      return;
    }

    const isLong = best.direction === 'LONG';
    const slDist = atr * 0.8;
    const rr     = 3;
    const entry  = price;
    const sl     = isLong ? entry - slDist : entry + slDist;
    const tp1    = isLong ? entry + slDist*rr*0.5 : entry - slDist*rr*0.5;
    const tp2    = isLong ? entry + slDist*rr      : entry - slDist*rr;
    const be     = isLong ? entry + slDist*0.5     : entry - slDist*0.5;

    let signal;
    if (isLong) signal = best.score >= 70 ? 'BUY LONG'  : 'BUY SHORT';
    else        signal = best.score >= 70 ? 'SELL SHORT' : 'SELL LONG';

    const reason = `${best.name} | 4H: ${bias4h} | Sweep: ${sweep} | CHoCH: ${choch} | FVG: ${fvg}`;

    lastSignal = {
      signal, confidence: best.score, strategy: best.name, reason,
      is_long: isLong,
      entry: +entry.toFixed(2), sl: +sl.toFixed(2),
      tp1:   +tp1.toFixed(2),   tp2: +tp2.toFixed(2), be: +be.toFixed(2),
      bias_4h: bias4h, bias_1h: bias1h, bias_15m: bias15m,
      sweep, choch, fvg, in_session: session.isOpen,
      all_strategies: strategies.map((s,i) => ({
        name: stratNames[i], score: s.score||0, valid: s.valid||false, direction: s.direction||'—'
      })),
      timestamp: Date.now()
    };

    console.log(`[AUTO] ${signal} | ${best.name} | ${best.score}% | Entry: ${entry.toFixed(2)} | SL: ${sl.toFixed(2)} | TP: ${tp2.toFixed(2)}`);

    if (best.score >= 65 && subscriptions.length > 0) {
      const payload = JSON.stringify({
        title: `XAUUSD ${signal}`,
        body:  `${best.name} | ${best.score}% | Entry: ${entry.toFixed(2)} | SL: ${sl.toFixed(2)} | TP: ${tp2.toFixed(2)}`
      });
      subscriptions.forEach(sub => webpush.sendNotification(sub, payload).catch(()=>{}));
    }

  } catch(e) {
    console.error('[AUTO] Analysis failed:', e.message);
  }
}

// Smart scheduling — ~792 API calls/day
// Prime (08:00-22:00 UTC): every 5 mins
// Asian/dead (22:00-08:00 UTC): every 20 mins
function scheduleNext() {
  const t  = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const ms = (t >= 8*60 && t < 22*60) ? 5*60*1000 : 20*60*1000;
  setTimeout(() => { runAnalysis(); scheduleNext(); }, ms);
}

runAnalysis();
scheduleNext();

// ══════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error:'Invalid subscription' });
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) subscriptions.push(sub);
  res.json({ ok:true });
});

app.post('/api/unsubscribe', (req, res) => {
  subscriptions = subscriptions.filter(s => s.endpoint !== req.body.endpoint);
  res.json({ ok:true });
});

app.get('/api/signal', (req, res) => {
  if (!lastSignal) return res.status(404).json({ error:'No signal yet' });
  const age = (Date.now() - lastSignal.timestamp) / 1000 / 60;
  if (age > 6) return res.status(404).json({ error:`Signal stale (${age.toFixed(1)} min)` });
  res.json(lastSignal);
});

app.post('/api/notify', async (req, res) => {
  const { signal, confidence, entry, sl, strategy } = req.body;
  if (!signal) return res.status(400).json({ error:'Missing signal' });
  const payload = JSON.stringify({ title:`XAUUSD ${signal}`, body:`${strategy||''} | ${confidence}% | Entry: ${entry} | SL: ${sl}` });
  await Promise.allSettled(subscriptions.map(sub => webpush.sendNotification(sub, payload).catch(()=>{})));
  res.json({ ok:true });
});

// ── TRADE TRACKING ──
let tradeLog     = [];
let stratStats   = {};
let liveSignal   = null;
let liveBalance  = 0;

// EA posts signal updates here
app.post('/api/signal-update', (req, res) => {
  const { strategy, direction, confidence, price, account } = req.body;
  liveSignal  = { strategy, direction, confidence, price, timestamp: Date.now() };
  liveBalance = account || liveBalance;
  console.log(`[SIGNAL] ${direction} | ${strategy} | ${confidence}% | ${price}`);

  // Push notification
  if (confidence >= 65 && subscriptions.length > 0) {
    const payload = JSON.stringify({
      title: `XAUUSD ${direction}`,
      body:  `${strategy} | ${confidence}% | Entry: ${price}`
    });
    subscriptions.forEach(sub => webpush.sendNotification(sub, payload).catch(()=>{}));
  }
  res.json({ ok: true });
});

// EA posts trade results here
app.post('/api/trade-result', (req, res) => {
  const { strategy, won, pnl, pips, entry, confidence, balance, totalWins, totalLosses } = req.body;
  
  // Add to trade log
  tradeLog.unshift({
    id:         Date.now(),
    strategy,
    won,
    pnl:        +parseFloat(pnl).toFixed(2),
    pips:       +parseFloat(pips).toFixed(1),
    entry:      +parseFloat(entry).toFixed(2),
    confidence: +parseFloat(confidence).toFixed(0),
    time:       new Date().toISOString()
  });
  if (tradeLog.length > 200) tradeLog.pop();

  // Update strategy stats
  if (!stratStats[strategy]) stratStats[strategy] = { wins:0, losses:0, pips:0, pnl:0, trades:0 };
  stratStats[strategy].trades++;
  stratStats[strategy].pnl  += parseFloat(pnl);
  stratStats[strategy].pips += parseFloat(pips);
  if (won) stratStats[strategy].wins++;
  else     stratStats[strategy].losses++;

  liveBalance = balance || liveBalance;

  // Push notification
  const emoji = won ? '✅' : '❌';
  const payload = JSON.stringify({
    title: `${emoji} Trade Closed`,
    body:  `${strategy} | ${won ? 'WIN' : 'LOSS'} | £${parseFloat(pnl).toFixed(2)} | ${parseFloat(pips).toFixed(1)} pips`
  });
  subscriptions.forEach(sub => webpush.sendNotification(sub, payload).catch(()=>{}));

  console.log(`[TRADE] ${won?'WIN':'LOSS'} | ${strategy} | £${pnl} | ${pips} pips`);
  res.json({ ok: true });
});

// Dashboard data endpoint
app.get('/api/dashboard', (req, res) => {
  const totalTrades = tradeLog.length;
  const totalWins   = tradeLog.filter(t => t.won).length;
  const totalPnl    = tradeLog.reduce((a,t) => a + t.pnl, 0);
  const totalPips   = tradeLog.reduce((a,t) => a + t.pips, 0);

  // Build leaderboard
  const leaderboard = Object.entries(stratStats).map(([name, s]) => ({
    name,
    trades:  s.trades,
    wins:    s.wins,
    losses:  s.losses,
    winRate: s.trades > 0 ? Math.round((s.wins/s.trades)*100) : 0,
    pnl:     +s.pnl.toFixed(2),
    pips:    +s.pips.toFixed(1),
    avgPips: s.trades > 0 ? +(s.pips/s.trades).toFixed(1) : 0
  })).sort((a,b) => b.winRate - a.winRate);

  res.json({
    balance:      liveBalance,
    totalTrades,
    totalWins,
    totalLosses:  totalTrades - totalWins,
    winRate:      totalTrades > 0 ? Math.round((totalWins/totalTrades)*100) : 0,
    totalPnl:     +totalPnl.toFixed(2),
    totalPips:    +totalPips.toFixed(1),
    liveSignal,
    leaderboard,
    recentTrades: tradeLog.slice(0, 20)
  });
});

app.get('/health', (req, res) => res.json({
  status:'ok', uptime: process.uptime(),
  lastSignal: lastSignal?.signal || 'none',
  confidence: lastSignal?.confidence || 0,
  strategy:   lastSignal?.strategy  || 'none',
  subscribers: subscriptions.length
}));

app.get('/api/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.listen(PORT, () => {
  console.log(`XAUUSD Analyzer running on port ${PORT}`);
  console.log(`6 strategies active | Smart scheduling enabled`);
});
