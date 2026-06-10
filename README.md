# XAUUSD SMC Dream Bot — Setup Guide

Date last updated: 10 June 2026

## WHO YOU ARE

- Name: Josh Nixon
- Goal: £50 → £1,000+ compounding
- Broker: VT Markets
- MT5 Account: 29170194
- Server: VTMarkets-Live 6
- Symbol: XAUUSD-STD

## WHAT WE BUILT

A complete autonomous trading system:

1. **MT5 Expert Advisor** (`XAUUSD_SMC_Bot.mq5`)
- Runs entirely inside MT5 — no CMD, no Python, no external dependencies
- Pulls candle data directly from MT5 (unlimited, broker-accurate)
- 6 SMC strategies scored every 60 seconds
- Self-adjusting strategy weights based on recent performance
- Dynamic TP levels based on real liquidity (BSL/SSL on 1H, 4H, Daily)
- 25% partial close at each of 4 TP levels
- Trailing stop on final 25% — rides big multi-day moves
- Target extension when momentum confirmed strong
- Pyramid scaling on exceptional setups (max 2 positions)
- ATR volatility filter — skips dead markets
- Daily bias flip emergency exit
- 15% risk auto-scales to 10% at £500 balance
- Posts all signals and results to Render server
1. **Render Server** (`server.js`)
- Receives signals and trade results from EA
- Sends push notifications to phone
- Hosts strategy leaderboard and trade log
- Dashboard API endpoint at /api/dashboard
- Health check at /health
1. **Web Dashboard** (`public/index.html`)
- Live signal display
- Entry/SL/TP visible immediately on load
- Strategy leaderboard with 👑 crown on top performer
- Full trade log — every trade, strategy, pips, P&L
- Win rate per strategy
- Running balance tracker
- Phase plan £50 → £1,000

## THE 6 STRATEGIES

1. BSL Sweep → Short (~68% WR)
1. SSL Sweep → Long (~65% WR)
1. FVG / IFVG Entry (~72% WR)
1. Expansion Model — Trader Zed (~70% WR)
1. No-Wick Candle Entry — Bard.fx (~85% WR)
1. ORB Opening Range Breakout (~67% WR)

## LIVE URLS

- Dashboard: <https://xauusd-analyzer.onrender.com>
- Health: <https://xauusd-analyzer.onrender.com/health>
- Signal: <https://xauusd-analyzer.onrender.com/api/signal>
- Dashboard data: <https://xauusd-analyzer.onrender.com/api/dashboard>

## GITHUB REPO

<https://github.com/jnixontrade-maker/xauusd-analyzer>

## REPO STRUCTURE

```
xauusd-analyzer/
├── public/
│   ├── index.html        ← Web dashboard
│   └── sw.js             ← Push notification service worker
├── XAUUSD_SMC_Bot.mq5    ← MT5 Expert Advisor (the bot)
├── server.js             ← Render backend
├── package.json          ← Node dependencies
└── README.md             ← This file
```

## HOW TO INSTALL THE EA IN MT5

1. Open MT5
1. File → Open Data Folder
1. Navigate to MQL5 → Experts
1. Copy XAUUSD_SMC_Bot.mq5 into that folder
1. Back in MT5 → Tools → MetaEditor (F4)
1. Find the file, press F7 to compile
1. Should show 0 errors, 0 warnings
1. Close MetaEditor
1. In MT5 Navigator panel → Expert Advisors → refresh
1. Drag XAUUSD_SMC_Bot onto the XAUUSD-STD chart
1. Settings:
- ServerURL: <https://xauusd-analyzer.onrender.com>
- RiskPercent: 15
- MinConfidence: 65
1. Common tab: tick Allow Live Trading + Allow DLL imports
1. Tools → Options → Expert Advisors:
- Allow algorithmic trading ✅
- Allow WebRequest for: <https://xauusd-analyzer.onrender.com> ✅
1. Click OK — look for smiley face on chart
1. Check Journal tab at bottom for bot logs

## RENDER DEPLOYMENT

- Platform: render.com
- Build: npm install
- Start: node server.js
- Environment variables: VAPID_PUBLIC, VAPID_PRIVATE

## PHASE PLAN

|Phase|From|To   |
|-----|----|-----|
|1    |£50 |£100 |
|2    |£100|£200 |
|3    |£200|£350 |
|4    |£350|£500 |
|5    |£500|£750 |
|6    |£750|£1000|

## NEXT STEPS

- Add VPS so bot runs without PC being on
- News API integration for news filter
- Re-upload TSA course PDF for additional strategy refinements
- Change MT5 password after first profitable week

## IMPORTANT NOTES

- Bot uses XAUUSD-STD (VT Markets symbol name)
- Risk auto-scales: 15% until £500, then 10%
- Max 2 concurrent positions
- Partial closes at 4 TP levels protect profit
- Self-adjusting weights mean bot learns which strategies work best
- Never interfere with open trades manually