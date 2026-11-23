# Strategy

A long-biased cbBTC trend bot. It buys the full cash balance on the first
tradable bar and stays long by default, because on this market one-minute
noise is about 8 bps while a full-size round trip costs about 26 bps in
fees, slippage and price impact — frequent trading only pays the pool.

## Rules

1. **Enter long.** On the first tradable batch (after any warm-up), buy
   CBBTC with all available cash, up to the position-weight cap.
2. **Crash guard.** Track the trailing peak of closes. If the latest close
   falls 2% below that peak, sell the entire position. Shallow pullbacks
   (the dev window's were under 1%) do not trigger it.
3. **Re-enter on strength only.** After a guard exit, buy back in full
   only when the 30-minute return is above +0.5% **and** the close is above
   its 120-minute EMA. Weak bounces are ignored.
4. **Never trade warm-up batches**, never trade a minute with no bar for
   the symbol, and never use the wall clock, the environment, or
   randomness — every decision is a pure function of the bars, fills and
   account the harness sends, so two runs produce identical orders.

## Why this shape

The dev window rises 3.6% overall, mostly in one fast two-hour move, with
the rest of the day chopping inside a ~1% range. Fast EMA crosses and
short-window momentum signals were tested offline against the dev bars and
all lost money after costs: their fills land a bar late, after the move
they chase. Being long through the chop and cutting only a genuine 2%
drawdown keeps the upside of the trend while capping the downside on a
falling race window. The 2% guard never fired on the dev window, so the
dev result equals buy-and-hold there; its value is insurance for the race.

## Local grade (dev window, `grade-local`, process driver)

- Net PnL: **+32.167313 USDC** (return +3.22%)
- Trades: 1, max drawdown: 1.98%, fees: 0.813 USDC
- Guardrails met; two runs byte-identical
  (`result_sha256 c3409e9660fe45e04210a548091de32b896017a96c71f5be09da8be9a280f4ea`)
