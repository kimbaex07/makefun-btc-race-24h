// btc-race-24h: a long-biased cbBTC trend bot for agent-fun/bars-replay/v1.
//
// How it talks to the harness: the harness sends one `hello` line (universe,
// capital, caps, fees, seed), then one `batch` per minute — each batch carries
// the bar that just closed, the fills of the orders sent on the previous batch,
// and the account — and the bot answers every batch with exactly one reply
// echoing its seq, carrying its orders for the next bar. Orders decided on a
// batch fill at the next bar's open, so every signal here is computed on
// closes the bot has already seen.
//
// Strategy (written fresh for this round):
//   * Buy the full cash balance on the first tradable batch and stay long by
//     default. One-minute noise is ~8 bps and a full-size round trip costs
//     ~26 bps, so frequent trading only pays the pool; the edge is in
//     holding through chop and cutting only a real drawdown.
//   * Crash guard: track the trailing peak of closes; if the latest close
//     falls 2% below that peak, sell the whole position.
//   * Re-entry: after an exit, buy back in full only on a strong recovery —
//     the 30-minute return above +0.5% while the close sits above its
//     120-minute EMA. No re-entry on weak bounces.
//   * Deterministic: no wall clock, no environment, no randomness. The only
//     inputs are the bars, fills and account the harness sends.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Trailing-stop distance below the peak close, in percent.
const TRAIL_PCT = 2.0;
// Re-entry needs a 30-bar return above this, in percent, with the close
// above its 120-bar EMA.
const REENTRY_30M_PCT = 0.5;
const REENTRY_EMA_BARS = 120;
// Max slippage vs the latest close the harness may fill against.
const BUY_MAX_SLIPPAGE_BPS = 300;
const SELL_MAX_SLIPPAGE_BPS = 500;

// ---------------------------------------------------------------- helpers

// Close prices in USDC (floats are fine for signals; money math stays in
// integer quote units through the SDK shim).
const closes: number[] = [];

// Highest close seen while holding (the trailing peak for the crash guard).
let peakClose = 0;
// True once the initial buy has been placed; re-entries are governed by the
// recovery rule below, not by this flag.
let entered = false;

// EMA of the closes array, computed from scratch each batch (at most 1440
// bars, so this is cheap and keeps the code obviously deterministic).
function emaLast(values: number[], n: number): number {
  const k = 2 / (n + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

// Latest close in USDC, or null before the first bar for the symbol.
function latestClose(state: BarsState): number | null {
  const raw = state.close(SYMBOL);
  if (raw === null) return null;
  const meta = state.symbols.get(SYMBOL);
  if (meta === undefined) return null;
  return Number(raw) / 10 ** meta.price_scale;
}

// The quantity of CBBTC currently held, in the symbol's qty units.
function heldQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
}

// ---------------------------------------------------------------- decision

function decide(state: BarsState, batch: Batch) {
  // No bar for the symbol in this batch (a gap minute): hold, send no orders.
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = latestClose(state);
  if (close === null) return [];

  closes.push(close);
  const qty = heldQty(state);

  // Holding: maintain the peak and cut on a 2% drawdown from it.
  if (qty > 0n) {
    if (close > peakClose) peakClose = close;
    if (close < peakClose * (1 - TRAIL_PCT / 100)) {
      return [
        {
          side: 'sell' as const,
          symbol: SYMBOL,
          qty,
          max_slippage_bps: SELL_MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Flat, warm-up batches cannot trade (the harness rejects warmup orders).
  if (state.warmingUp) return [];

  // First tradable batch: buy in full, like a long-biased holder.
  if (!entered) {
    entered = true;
    peakClose = close;
    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional <= 0n) return [];
    return [
      {
        side: 'buy' as const,
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: BUY_MAX_SLIPPAGE_BPS,
      },
    ];
  }

  // Re-entry after a crash-guard exit: only on a strong, confirmed recovery.
  if (closes.length > REENTRY_EMA_BARS && closes.length > 30) {
    const r30 = (close / closes[closes.length - 31]! - 1) * 100;
    const ema120 = emaLast(closes, REENTRY_EMA_BARS);
    if (r30 > REENTRY_30M_PCT && close > ema120) {
      peakClose = close;
      const room = state.weightRoom(SYMBOL);
      const notional = state.cash < room ? state.cash : room;
      if (notional <= 0n) return [];
      return [
        {
          side: 'buy' as const,
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: BUY_MAX_SLIPPAGE_BPS,
        },
      ];
    }
  }
  return [];
}

await runBars({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
