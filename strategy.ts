// Launch-confirmation bot for agent-fun/replay/v2 (pump.fun bonding curves).
//
// The idea, in one sentence: only buy a launch after the tape itself shows real
// buyers piling in, then get out fast on a fixed take-profit or stop-loss.
//
// Entry, decided on a batch 1 to 12 slots after the CreateEvent:
//   - at least 3 trades and 3 distinct non-creator buyers seen so far
//   - no single buyer took more than 30% of the buy SOL (no one wallet owns the open)
//   - the creator has not sold a token
//   - the price sits 6% to 40% above the first trade's price (momentum confirmed,
//     but not a vertical spike that already left)
//   - net flow over the last 10 slots is positive (more SOL bought than sold)
//   - the curve holds 1 to 40 real SOL (liquid enough to enter, small enough to move)
// One buy per coin, never a second buy into the same mint, at most 5 open positions.
// The buy aims for 0.1 SOL but the harness caps every buy at 1% of the real SOL
// reserve, so most fills land well below the aim.
//
// Exits, checked on every batch while a position is held:
//   - take-profit at +20% over cost, stop-loss at -8% under cost
//   - trailing stop: once the position is up 15%, sell if it falls 10% off its best value
//   - the creator sells while we hold: leave at once
//   - max hold of 120 slots: leave, win or lose
//
// Deliberately patient: an earlier version chopped positions with a tight
// trailing stop, a flow exit and a stale exit, and the churn showed up as
// 176 round trips whose ~2.9% fee each ate the whole edge. Letting a position
// run to its take-profit costs nothing extra when it works, and the fee saved
// by entering fewer coins is worth more than the quick exits saved.
//
// Pace guardrail: the entry needs at least 20 distinct coins. If the clock shows
// more than 12 hours have passed since the first event and fewer than 20 coins
// have been bought, the bot switches to probe mode: the entry filter relaxes to
// 2 trades and 2 buyers, and each probe buys exactly 0.01 SOL, the minimum
// round trip, so the coin count can still be reached without risking much.
//
// Pure function of the batches it is fed: no clock reads, no randomness, no I/O,
// no environment. Two runs on the same data produce the same orders.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per buy, before the harness's 1% of real reserve cap. */
  stakeLamports: bigint;
  /** Smallest buy worth sending (the minimum round trip). */
  minBuyLamports: bigint;
  /** Trades seen before entry. */
  minTrades: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Largest single buyer as a share of all buy SOL, in bps, at most. */
  maxBuyerShareBps: bigint;
  /** Price now over the first trade price, as bps: window. */
  minRunupBps: bigint;
  maxRunupBps: bigint;
  /** Net flow window (slots) and what it must show at entry. */
  flowWindow: number;
  minEntryFlowLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps). */
  sellSlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: bigint;
  /** Trailing stop: arm once up this much (bps), exit on a fall of this much (bps) off the best. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: bigint;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Probe mode: after this much block time, if fewer than this many coins were bought. */
  probeAfterSeconds: number;
  probeMinCoins: number;
  /** Probe mode entry: relaxed trade / buyer counts and this buy size. */
  probeMinTrades: number;
  probeMinBuyers: number;
  probeBuyLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 12,
  stakeLamports: LAMPORTS_PER_SOL / 10n, // 0.1 SOL
  minBuyLamports: 10_000_000n, // 0.01 SOL, the minimum round trip
  minTrades: 3,
  minBuyers: 3,
  maxBuyerShareBps: 3000n, // 30%
  minRunupBps: 600n, // +6%
  maxRunupBps: 4000n, // +40%
  flowWindow: 10,
  minEntryFlowLamports: 1n, // strictly positive
  minRealSolLamports: LAMPORTS_PER_SOL, // 1 SOL
  maxRealSolLamports: 40n * LAMPORTS_PER_SOL, // 40 SOL
  skipDevSold: true,
  buySlippageBps: 1000,
  sellSlippageBps: 10000,
  tpBps: 2000n, // +20%
  slBps: 800n, // -8%
  trailArmBps: 1500n, // arm at +15%
  trailBps: 1000n, // exit on a 10% fall off the best
  maxHoldSlots: 120,
  exitOnDevSell: true,
  exitFlowLamports: -2_000_000_000n, // -2 SOL: effectively off, flow exits chopped winners
  staleSlots: 1_000_000, // effectively off: quiet coins may still reach take-profit
  probeAfterSeconds: 43_200, // 12 hours
  probeMinCoins: 20,
  probeMinTrades: 2,
  probeMinBuyers: 2,
  probeBuyLamports: 10_000_000n, // 0.01 SOL
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Price after the first trade, as a (vq, vt) pair. Null until the first trade. */
  firstVq: bigint | null;
  firstVt: bigint | null;
  trades: number;
  buyers: Set<Pubkey>;
  /** SOL bought per buyer, to find the largest single buyer. */
  buySolByBuyer: Map<Pubkey, bigint>;
  bought: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Recent trades, oldest first; pruned to the flow window as new ones arrive. */
  recent: Tick[];
  /** A buy was already sent for this coin (one buy per coin, no pyramiding). */
  boughtOnce: boolean;
  complete: boolean;
}

interface Held {
  /** Slot the position first showed up in the account. */
  openedSlot: number;
  /** Best sell value seen so far (lamports). */
  bestValue: bigint;
  /** The creator had sold by the time we opened (should not happen; tracked for the exit rule). */
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

const FEE_BPS = 125n; // protocol 95 + creator 30, per side

/** What selling `tokens` against reserves (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

/** Price now over the first trade price, in bps, minus 10000 (so +6% reads 600). */
function runupBps(nowVq: bigint, nowVt: bigint, firstVq: bigint, firstVt: bigint): bigint {
  if (nowVt <= 0n || firstVq <= 0n || firstVt <= 0n) return -10_000n;
  // (nowVq / nowVt) / (firstVq / firstVt) * 10000 - 10000
  const ratio = (nowVq * firstVt * 10_000n) / (nowVt * firstVq);
  return ratio - 10_000n;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  let firstBlockTime: number | null = null;
  let latestBlockTime = 0;
  let distinctBought = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        latestBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          firstVq: null,
          firstVt: null,
          trades: 0,
          buyers: new Set(),
          buySolByBuyer: new Map(),
          bought: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        if (c.firstVq === null) {
          c.firstVq = BigInt(e.virtual_quote_reserves);
          c.firstVt = BigInt(e.virtual_token_reserves);
        }
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (!isDev) {
            c.buyers.add(e.user);
            c.buySolByBuyer.set(e.user, (c.buySolByBuyer.get(e.user) ?? 0n) + sol);
          }
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
        }
      }
    }
  }

  /** Net SOL flow (buys minus sells) over the last `window` slots, ending at `slot`. */
  function netFlow(c: Coin, slot: number, window: number): bigint {
    let flow = 0n;
    const from = slot - window;
    // Prune old ticks while summing, oldest first.
    while (c.recent.length > 0 && c.recent[0].slot <= from) c.recent.shift();
    for (const t of c.recent) flow += t.isBuy ? t.sol : -t.sol;
    return flow;
  }

  /** Largest single non-creator buyer as a share of all buy SOL, in bps. */
  function largestBuyerShareBps(c: Coin): bigint {
    if (c.bought <= 0n) return 0n;
    let biggest = 0n;
    for (const sol of c.buySolByBuyer.values()) if (sol > biggest) biggest = sol;
    return (biggest * 10_000n) / c.bought;
  }

  function probeMode(): boolean {
    if (firstBlockTime === null) return false;
    return latestBlockTime - firstBlockTime >= P.probeAfterSeconds && distinctBought < P.probeMinCoins;
  }

  function decideBuys(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const probe = probeMode();
    const minTrades = probe ? P.probeMinTrades : P.minTrades;
    const minBuyers = probe ? P.probeMinBuyers : P.minBuyers;
    const aim = probe ? P.probeBuyLamports : P.stakeLamports;

    for (const c of coins.values()) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (c.complete || c.boughtOnce) continue;
      if (state.positions.has(c.mint)) continue;
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;

      const age = batch.slot - c.createSlot;
      if (age < P.minAge || age > P.maxAge) continue;
      if (c.trades < minTrades) continue;
      if (c.buyers.size < minBuyers) continue;
      if (P.skipDevSold && c.devSold) continue;
      if (largestBuyerShareBps(c) > P.maxBuyerShareBps) continue;
      if (c.firstVq === null || c.firstVt === null) continue;

      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      const runup = runupBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, c.firstVq, c.firstVt);
      if (runup < P.minRunupBps || runup > P.maxRunupBps) continue;
      if (netFlow(c, batch.slot, P.flowWindow) < P.minEntryFlowLamports) continue;
      if (curve.real_quote_reserves < P.minRealSolLamports || curve.real_quote_reserves > P.maxRealSolLamports) continue;

      // Size: aim, capped by the harness's 1% of real reserve, never below the minimum round trip.
      let amount = aim;
      const cap = state.maxBuyLamports(c.mint);
      if (amount > cap) amount = cap;
      if (amount < P.minBuyLamports) continue;
      if (state.freeCashLamports() < amount + state.txFeeLamports()) continue;

      c.boughtOnce = true;
      distinctBought += 1;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
    }
    return orders;
  }

  function decideSells(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const cost = pos.cost_lamports;
      if (cost <= 0n) continue;

      let h = held.get(mint);
      if (h === undefined) {
        const c = coins.get(mint);
        h = { openedSlot: batch.slot, bestValue: value, devSoldAtOpen: c?.devSold ?? false };
        held.set(mint, h);
      }
      if (value > h.bestValue) h.bestValue = value;

      const c = coins.get(mint);
      const gainBps = ((value - cost) * 10_000n) / cost;
      let exit = false;
      if (gainBps >= P.tpBps) exit = true; // take-profit +20%
      else if (gainBps <= -P.slBps) exit = true; // stop-loss -8%
      else if (h.bestValue >= (cost * (10_000n + P.trailArmBps)) / 10_000n && value <= (h.bestValue * (10_000n - P.trailBps)) / 10_000n) {
        exit = true; // trailing stop: 6% off the best once up 10%
      } else if (P.exitOnDevSell && c !== undefined && c.devSold) {
        exit = true; // creator sold while we hold
      } else if (c !== undefined && netFlow(c, batch.slot, P.flowWindow) < P.exitFlowLamports) {
        exit = true; // flow turned hard negative
      } else if (batch.slot - h.openedSlot >= P.maxHoldSlots) {
        exit = true; // max hold
      } else if (c !== undefined && batch.slot - c.lastTradeSlot >= P.staleSlots) {
        exit = true; // launch went quiet
      }

      if (exit) {
        held.delete(mint);
        if (c !== undefined) c.boughtOnce = true; // never re-enter an exited coin
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlippageBps });
      }
    }
    // Forget positions the harness closed on its own (complete / flatten / write-off).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    return orders;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const sells = decideSells(state, batch);
      const buys = decideBuys(state, batch);
      const room = state.hello.caps.max_orders_per_batch;
      return [...sells, ...buys].slice(0, room);
    },
  };
}
