// Launch-confirmation bot for the Pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// hello: the harness greets the bot once, then hands it one batch per slot.
// batch: each batch carries the slot's events, marks, fills and account.
// orders: the bot answers every batch with the orders decided on that slot.
// slot: all timing here is counted in slots, never wall-clock time.
//
// Strategy: buy a launch only after the tape proves real buyers are in
// (see strategy.ts), exit on take-profit, stop-loss, trailing stop, creator
// sell, bad flow, or max hold. Deterministic: same data, same orders.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
