"""
XAUUSD SMC Auto-Trader for MetaTrader 5
Goal: £20 → £1,000 in 24 hours
Strategy: Smart Money Concepts (BSL/SSL sweep + CHoCH + FVG entry)

REQUIREMENTS:
  pip install MetaTrader5 requests schedule

SETUP:
  1. Install MetaTrader 5 desktop app
  2. Enable "Algo Trading" in MT5 settings
  3. Set your broker login details below (or use env vars)
  4. Run: python mt5_bot.py
"""

import MetaTrader5 as mt5
import requests
import schedule
import time
import json
import logging
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Optional

# ── CONFIG ─────────────────────────────────────────────────────────────
SYMBOL       = "XAUUSD"
MAGIC_NUMBER = 20241001          # Unique ID for bot's trades
TIMEFRAME_MAP = {
  "1m":  mt5.TIMEFRAME_M1,
  "15m": mt5.TIMEFRAME_M15,
  "1h":  mt5.TIMEFRAME_H1,
  "4h":  mt5.TIMEFRAME_H4,
}

# Risk management
START_BALANCE    = 20.0          # Starting balance £
TARGET_BALANCE   = 1000.0        # End goal £
RISK_PCT         = 0.10          # 10% risk per trade
BASE_RR          = 3.0           # Minimum reward:risk ratio
MIN_CONFIDENCE   = 65            # Only trade if analysis ≥ 65%
MAX_DAILY_LOSSES = 999           # No daily loss limit — bot runs all day

# MT5 login
MT5_LOGIN    = 29170194
MT5_PASSWORD = "7Q#cDVHs"
MT5_SERVER   = "VTMarkets-Live6"

# Analyzer server
ANALYZER_URL = "https://xauusd-analyzer.onrender.com"

# ── LOGGING ────────────────────────────────────────────────────────────
logging.basicConfig(
  level=logging.INFO,
  format="%(asctime)s [%(levelname)s] %(message)s",
  handlers=[
    logging.StreamHandler(),
    logging.FileHandler("bot.log")
  ]
)
log = logging.getLogger("XAU-BOT")

# ── STATE ──────────────────────────────────────────────────────────────
@dataclass
class BotState:
  daily_losses:    int   = 0
  daily_trades:    int   = 0
  daily_pnl:       float = 0.0
  current_phase:   int   = 1
  trade_open:      bool  = False
  trade_ticket:    int   = 0
  session_start_balance: float = 0.0

state = BotState()

# ── MT5 CONNECTION ─────────────────────────────────────────────────────
def connect():
  if not mt5.initialize():
    log.error(f"MT5 init failed: {mt5.last_error()}")
    return False
  if MT5_LOGIN:
    ok = mt5.login(MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)
    if not ok:
      log.error(f"MT5 login failed: {mt5.last_error()}")
      return False
  info = mt5.account_info()
  if info:
    log.info(f"Connected: {info.name} | Balance: {info.currency}{info.balance:.2f} | Server: {info.server}")
    state.session_start_balance = info.balance
  return True

def disconnect():
  mt5.shutdown()
  log.info("MT5 disconnected")

# ── PRICE & CANDLES ────────────────────────────────────────────────────
def get_price() -> Optional[float]:
  tick = mt5.symbol_info_tick(SYMBOL)
  return (tick.bid + tick.ask) / 2 if tick else None

def get_candles(tf_key: str, count: int = 50):
  tf = TIMEFRAME_MAP.get(tf_key)
  if tf is None:
    return []
  rates = mt5.copy_rates_from_pos(SYMBOL, tf, 0, count)
  if rates is None:
    return []
  return [{"t":r[0],"o":r[1],"h":r[2],"l":r[3],"c":r[4]} for r in rates]

# ── ANALYSIS ENGINE ────────────────────────────────────────────────────
def ema(prices: list, period: int) -> float:
  k = 2 / (period + 1)
  e = prices[0]
  for p in prices[1:]:
    e = p * k + e * (1 - k)
  return e

def get_bias(candles: list) -> str:
  if len(candles) < 10:
    return "NEUTRAL"
  sl = candles[-20:]
  highs = [c["h"] for c in sl]
  lows  = [c["l"] for c in sl]
  hh = highs[-1] > max(highs[:-5])
  hl = lows[-1]  > min(lows[:-5])
  lh = highs[-1] < max(highs[:-5])
  ll = lows[-1]  < min(lows[:-5])
  if hh and hl: return "BULLISH"
  if lh and ll: return "BEARISH"
  closes = [c["c"] for c in sl]
  if ema(closes, 9) > ema(closes, 21): return "BULLISH"
  if ema(closes, 9) < ema(closes, 21): return "BEARISH"
  return "NEUTRAL"

def detect_sweep(candles: list) -> str:
  if len(candles) < 10:
    return "NONE"
  recent = candles[-10:]
  prev_highs = [c["h"] for c in recent[:-3]]
  prev_lows  = [c["l"] for c in recent[:-3]]
  swing_high = max(prev_highs)
  swing_low  = min(prev_lows)
  prev = recent[-2]
  if prev["h"] > swing_high and prev["c"] < swing_high: return "BSL"
  if prev["l"] < swing_low  and prev["c"] > swing_low:  return "SSL"
  return "NONE"

def detect_choch(candles: list) -> str:
  if len(candles) < 10:
    return "NONE"
  recent = candles[-15:]
  for i in range(len(recent)-1, 4, -1):
    swing_high = max(c["h"] for c in recent[i-5:i])
    swing_low  = min(c["l"] for c in recent[i-5:i])
    if recent[i]["c"] > swing_high: return "BULLISH"
    if recent[i]["c"] < swing_low:  return "BEARISH"
  return "NONE"

def detect_fvg(candles: list) -> str:
  for i in range(len(candles)-3, max(0, len(candles)-8), -1):
    c1, c3 = candles[i], candles[i+2]
    if c3["l"] > c1["h"]: return "BULLISH"
    if c3["h"] < c1["l"]: return "BEARISH"
  return "NONE"

def calc_atr(candles: list, period: int = 14) -> float:
  if len(candles) < period + 1:
    return 5.0
  trs = []
  for i in range(1, len(candles)):
    tr = max(
      candles[i]["h"] - candles[i]["l"],
      abs(candles[i]["h"] - candles[i-1]["c"]),
      abs(candles[i]["l"] - candles[i-1]["c"])
    )
    trs.append(tr)
  return sum(trs[-period:]) / period

def is_prime_session() -> bool:
  now = datetime.now(timezone.utc)
  t = now.hour * 60 + now.minute
  return (8*60 <= t < 17*60) or (13*60 <= t < 22*60)

def analyse() -> dict:
  """Run full SMC analysis. Returns signal dict."""
  c1m  = get_candles("1m",  30)
  c15m = get_candles("15m", 50)
  c1h  = get_candles("1h",  50)
  c4h  = get_candles("4h",  60)

  bias4h  = get_bias(c4h)
  bias1h  = get_bias(c1h)
  bias15m = get_bias(c15m)
  sweep   = detect_sweep(c1h)
  choch   = detect_choch(c15m)
  fvg     = detect_fvg(c15m)
  session = is_prime_session()

  # Score
  bull, bear = 0, 0
  if bias4h  == "BULLISH": bull += 2
  elif bias4h  == "BEARISH": bear += 2
  if bias1h  == "BULLISH": bull += 2
  elif bias1h  == "BEARISH": bear += 2
  if bias15m == "BULLISH": bull += 1
  elif bias15m == "BEARISH": bear += 1
  if sweep == "SSL": bull += 2
  elif sweep == "BSL": bear += 2
  if choch == "BULLISH": bull += 2
  elif choch == "BEARISH": bear += 2
  if fvg == "BULLISH": bull += 1
  elif fvg == "BEARISH": bear += 1

  max_score = 10
  is_bull   = bull >= bear
  confidence = int((max(bull, bear) / max_score) * 100)

  price  = get_price() or (c1m[-1]["c"] if c1m else 2000)
  atr    = calc_atr(c1h)
  sl_dist = atr * 0.8
  rr     = BASE_RR

  if is_bull:
    signal   = "BUY LONG" if confidence >= 70 else "BUY SHORT"
    entry    = price
    sl       = entry - sl_dist
    tp1      = entry + sl_dist * rr * 0.5
    tp2      = entry + sl_dist * rr
    be       = entry + sl_dist * 0.5
  else:
    signal   = "SELL SHORT" if confidence >= 70 else "SELL LONG"
    entry    = price
    sl       = entry + sl_dist
    tp1      = entry - sl_dist * rr * 0.5
    tp2      = entry - sl_dist * rr
    be       = entry - sl_dist * 0.5

  # Lot size
  balance   = mt5.account_info().balance if mt5.account_info() else 20
  risk_amt  = balance * RISK_PCT
  sl_pips   = abs(entry - sl) * 10
  pip_value = 1.0  # $1 per pip per 0.01 lot for XAUUSD — verify with broker
  lot_size  = max(0.01, round(risk_amt / (sl_pips * pip_value * 100), 2))

  return {
    "signal":     signal,
    "confidence": confidence,
    "is_long":    is_bull,
    "entry":      round(entry, 2),
    "sl":         round(sl, 2),
    "tp1":        round(tp1, 2),
    "tp2":        round(tp2, 2),
    "be":         round(be, 2),
    "lot_size":   lot_size,
    "risk_amt":   round(risk_amt, 2),
    "sl_pips":    round(sl_pips, 1),
    "in_session": session,
    "bias_4h":    bias4h,
    "bias_1h":    bias1h,
    "sweep":      sweep,
    "choch":      choch,
    "fvg":        fvg,
  }

# ── TRADE EXECUTION ────────────────────────────────────────────────────
def open_trade(result: dict) -> bool:
  """Open a trade on MT5 based on analysis result."""
  if state.trade_open:
    log.warning("Trade already open — skipping")
    return False

  if state.daily_losses >= MAX_DAILY_LOSSES:
    log.warning(f"Daily loss limit hit ({MAX_DAILY_LOSSES}) — no more trades today")
    return False

  if result["confidence"] < MIN_CONFIDENCE:
    log.info(f"Confidence {result['confidence']}% < {MIN_CONFIDENCE}% minimum — skipping")
    return False

  # Session check removed — bot trades 24/7

  signal  = result["signal"]
  is_long = result["is_long"]
  lot     = result["lot_size"]
  sl      = result["sl"]
  tp      = result["tp2"]  # Use TP2 as main target

  order_type = mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL

  # Get current price
  tick = mt5.symbol_info_tick(SYMBOL)
  if not tick:
    log.error("Cannot get tick data")
    return False
  price = tick.ask if is_long else tick.bid

  request = {
    "action":      mt5.TRADE_ACTION_DEAL,
    "symbol":      SYMBOL,
    "volume":      lot,
    "type":        order_type,
    "price":       price,
    "sl":          sl,
    "tp":          tp,
    "deviation":   10,
    "magic":       MAGIC_NUMBER,
    "comment":     f"XAUBOT {signal} {result['confidence']}%",
    "type_time":   mt5.ORDER_TIME_GTC,
    "type_filling": mt5.ORDER_FILLING_IOC,
  }

  result_mt5 = mt5.order_send(request)
  if result_mt5 is None:
    log.error(f"order_send failed: {mt5.last_error()}")
    return False

  if result_mt5.retcode != mt5.TRADE_RETCODE_DONE:
    log.error(f"Order failed: {result_mt5.retcode} — {result_mt5.comment}")
    return False

  state.trade_open   = True
  state.trade_ticket = result_mt5.order
  state.daily_trades += 1
  log.info(f"✅ Trade opened: {signal} | Lot: {lot} | Entry: {price:.2f} | SL: {sl:.2f} | TP: {tp:.2f} | Ticket: {result_mt5.order}")
  return True

def check_open_trade():
  """Monitor open trade — move SL to breakeven at TP1."""
  if not state.trade_open:
    return

  positions = mt5.positions_get(ticket=state.trade_ticket)
  if not positions:
    # Trade closed
    state.trade_open = False
    # Check if profit or loss
    history = mt5.history_deals_get(position=state.trade_ticket)
    if history:
      pnl = sum(d.profit for d in history)
      state.daily_pnl += pnl
      if pnl < 0:
        state.daily_losses += 1
        log.warning(f"❌ Loss: £{pnl:.2f} | Daily losses: {state.daily_losses}/{MAX_DAILY_LOSSES}")
      else:
        log.info(f"✅ Win: £{pnl:.2f} | Daily P&L: £{state.daily_pnl:.2f}")
    return

  pos = positions[0]
  price = get_price()
  if not price:
    return

  is_long = pos.type == mt5.POSITION_TYPE_BUY

  # Work out TP1 level from original levels
  sl_dist = abs(pos.price_open - pos.sl) if pos.sl else 5
  tp1     = pos.price_open + sl_dist * BASE_RR * 0.5 if is_long else pos.price_open - sl_dist * BASE_RR * 0.5
  be      = pos.price_open + sl_dist * 0.5 if is_long else pos.price_open - sl_dist * 0.5

  # Move SL to breakeven once price hits TP1
  tp1_hit = (is_long and price >= tp1) or (not is_long and price <= tp1)
  sl_already_be = abs(pos.sl - be) < 0.5

  if tp1_hit and not sl_already_be:
    log.info(f"🔔 TP1 hit — moving SL to breakeven ({be:.2f})")
    modify_sl(pos.ticket, be)

def modify_sl(ticket: int, new_sl: float):
  """Modify the stop loss of an open position."""
  positions = mt5.positions_get(ticket=ticket)
  if not positions:
    return
  pos = positions[0]
  request = {
    "action":   mt5.TRADE_ACTION_SLTP,
    "symbol":   SYMBOL,
    "position": ticket,
    "sl":       new_sl,
    "tp":       pos.tp,
  }
  result = mt5.order_send(request)
  if result and result.retcode == mt5.TRADE_RETCODE_DONE:
    log.info(f"SL moved to {new_sl:.2f}")
  else:
    log.error(f"SL modify failed: {mt5.last_error()}")

# ── NOTIFY SERVER ──────────────────────────────────────────────────────
def notify_server(result: dict):
  """Send signal to Render server to push to phone."""
  try:
    requests.post(
      f"{ANALYZER_URL}/api/notify",
      json={
        "signal":     result["signal"],
        "confidence": result["confidence"],
        "entry":      result["entry"],
        "sl":         result["sl"],
        "tp1":        result["tp1"],
        "tp2":        result["tp2"],
      },
      timeout=5
    )
  except Exception as e:
    log.warning(f"Server notify failed: {e}")

# ── MAIN LOOP ──────────────────────────────────────────────────────────
def run_cycle():
  """Main bot cycle — runs every minute."""
  log.info("── Running analysis cycle ──")
  result = analyse()
  log.info(
    f"Signal: {result['signal']} | "
    f"Confidence: {result['confidence']}% | "
    f"4H: {result['bias_4h']} | 1H: {result['bias_1h']} | "
    f"Sweep: {result['sweep']} | CHoCH: {result['choch']} | "
    f"FVG: {result['fvg']} | Session: {'✓' if result['in_session'] else '✗'}"
  )

  # Notify phone regardless of trade
  if result["confidence"] >= MIN_CONFIDENCE:
    notify_server(result)

  # Open trade if criteria met
  if not state.trade_open and result["confidence"] >= MIN_CONFIDENCE:
    open_trade(result)

  # Monitor existing trade
  check_open_trade()

  # Log account status
  info = mt5.account_info()
  if info:
    log.info(f"Balance: £{info.balance:.2f} | Equity: £{info.equity:.2f} | Daily P&L: £{state.daily_pnl:.2f}")

def daily_reset():
  """Reset daily counters at midnight UTC."""
  state.daily_losses = 0
  state.daily_trades = 0
  state.daily_pnl    = 0.0
  log.info("── Daily reset ──")

def main():
  log.info("=" * 50)
  log.info("  XAUUSD SMC BOT — £20 → £1,000")
  log.info("=" * 50)

  if not connect():
    log.error("Cannot connect to MT5. Exiting.")
    return

  # Schedule cycles
  schedule.every(1).minutes.do(run_cycle)
  schedule.every().day.at("00:00").do(daily_reset)

  log.info("Bot running. Press Ctrl+C to stop.")
  run_cycle()  # Run immediately on start

  try:
    while True:
      schedule.run_pending()
      time.sleep(10)
  except KeyboardInterrupt:
    log.info("Bot stopped by user")
  finally:
    disconnect()

if __name__ == "__main__":
  main()
