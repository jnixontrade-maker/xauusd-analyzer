# XAUUSD SMC Analyzer v4 — Setup Guide

## FILES IN THIS PROJECT

```
xauusd-analyzer/
├── public/
│   ├── index.html    ← The full trading tool
│   └── sw.js         ← Service worker (push notifications)
├── server.js         ← Express server (runs on Render)
├── package.json      ← Node dependencies
├── mt5_bot.py        ← MT5 auto-trader (runs on your PC)
└── .gitignore
```

-----

## STEP 1 — Push to GitHub

```bash
# In terminal, navigate to this folder then:
git init
git add .
git commit -m "XAUUSD SMC Analyzer v4"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/xauusd-analyzer.git
git push -u origin main
```

-----

## STEP 2 — Deploy to Render (free tier)

1. Go to <https://render.com> → New → Web Service
1. Connect your GitHub repo
1. Settings:
- **Name:** xauusd-analyzer
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `node server.js`
1. Add Environment Variables:
- `VAPID_PUBLIC`  → (see Step 3)
- `VAPID_PRIVATE` → (see Step 3)
1. Click **Deploy**

Your app will be live at: `https://xauusd-analyzer.onrender.com`

-----

## STEP 3 — Generate VAPID Keys (push notifications)

Run this ONCE on your machine:

```bash
npm install -g web-push
npx web-push generate-vapid-keys
```

Copy the Public Key and Private Key into Render environment variables.

Then open `public/index.html` and replace:

```
YOUR_VAPID_PUBLIC_KEY_HERE
```

with your actual public key (search for it in the HTML).

-----

## STEP 4 — Enable Push Notifications on Phone

1. Open your Render URL on your phone browser
1. Click **Enable Alerts**
1. Allow notifications when prompted
1. You’ll now get pinged whenever confidence ≥ 70%

-----

## STEP 5 — Run the MT5 Bot (on your Windows PC)

```bash
# Install Python dependencies
pip install MetaTrader5 requests schedule

# Edit mt5_bot.py — fill in:
MT5_LOGIN    = 123456          # Your account number
MT5_PASSWORD = "yourpassword"
MT5_SERVER   = "ICMarkets-Demo"  # Your broker server
ANALYZER_URL = "https://your-app.onrender.com"

# Run the bot
python mt5_bot.py
```

The bot will:

- Analyse every 1 minute
- Only trade if confidence ≥ 70%
- Auto-calculate lot size (5% risk)
- Move SL to breakeven when TP1 is hit
- Notify your phone via Render
- Stop after 3 losses in a day

-----

## SIGNAL GUIDE

|Signal    |Meaning                           |When                     |
|----------|----------------------------------|-------------------------|
|BUY LONG  |Big move up expected (≥70% conf)  |Strong bullish confluence|
|BUY SHORT |Small scalp up (50–70% conf)      |Moderate bullish bias    |
|SELL SHORT|Big move down expected (≥70% conf)|Strong bearish confluence|
|SELL LONG |Small scalp down (50–70% conf)    |Moderate bearish bias    |
|WAIT      |No clear setup                    |Confluence too weak      |

-----

## PHASE PLAN — £20 → £1,000

|Phase|From|To   |Multiplier|
|-----|----|-----|----------|
|1    |£20 |£50  |2.5x      |
|2    |£50 |£100 |2x        |
|3    |£100|£200 |2x        |
|4    |£200|£350 |1.75x     |
|5    |£350|£500 |1.43x     |
|6    |£500|£750 |1.5x      |
|7    |£750|£1000|1.33x     |

-----

## ⚠️ IMPORTANT

- Always test on a **DEMO account** first
- The bot is a tool — not a guarantee
- Never risk money you can’t afford to lose
- Watch the first 10 trades live before leaving it unattended