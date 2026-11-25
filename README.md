# Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/tunnelmoon/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/tunnelmoon/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper trading bot for the make.fun Pump.fun Sharpe Sprint. It trades a 6 hour pump.fun replay on paper, ranked by hourly Sharpe ratio, with a 10 SOL paper bankroll and at most 5 open positions.

## Strategy: launch confirmation

Buy a launch only after the tape itself proves real buyers are in, then get out fast. One buy per coin, never a second buy into the same mint.

Entry, decided 1 to 12 slots after the CreateEvent:

- at least 3 trades and 3 distinct non-creator buyers seen so far
- no single buyer took more than 30% of the buy SOL
- the creator has not sold a token
- price sits 6% to 40% above the first trade's price
- net flow over the last 10 slots is positive
- the curve holds 1 to 40 real SOL

Each buy aims for 0.1 SOL, capped by the harness at 1% of the real SOL reserve. The minimum round trip is 0.01 SOL.

Exits, checked on every batch while a position is held:

- take profit at +20% over cost, stop loss at -8% under cost
- trailing stop: once up 15%, sell on a 10% fall off the best value
- the creator sells while we hold: leave at once
- max hold of 120 slots: leave, win or lose

The exits are deliberately patient: tight trailing stops and flow exits chopped positions early in testing, and the churn showed up as extra round trips whose fees ate the edge.

Pace guardrail: the entry needs at least 20 distinct coins. If more than 12 hours of block time have passed since the first event and fewer than 20 coins were bought, the bot switches to probe mode: the filter relaxes to 2 trades and 2 buyers, and each probe buys exactly 0.01 SOL.

## Dev results

Graded locally with the kit grader on the dev dataset, run twice, byte identical:

- Sharpe per hour, Net PnL, coins traded and max drawdown are recorded in the submission report
- The design brief measured this region at about -0.07 Sharpe per hour and about -0.02 SOL net on dev, with a 90% interval spanning zero, so the edge is inside noise and a positive final PnL is roughly a coin flip

## Layout

- `main.ts`: entrypoint, hands each batch to the strategy
- `strategy.ts`: the launch confirmation strategy, all parameters in one place
- `vendor/makefun-bot.ts`: the kit SDK, copied unchanged

## Run it

Requires Node 22.18 or later. The grader runs `node main.ts` with the harness on stdin and stdout. To grade locally:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

## License

MIT. See [LICENSE](LICENSE).
