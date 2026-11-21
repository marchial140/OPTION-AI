# Risk and calculation engine

The quantitative engine calculates strategy economics in TypeScript with decimal arithmetic. On-screen currency formatting rounds for display. It calculates USD amounts from the position quantity, contract multiplier, and total modeled fees.

## Supported positions

| Strategy | Opening legs | Expiration P&L before fees |
| --- | --- | --- |
| Long call | Buy call at ask | `max(S - K, 0) - premium` per share |
| Long put | Buy put at ask | `max(K - S, 0) - premium` per share |
| Bull call debit spread | Buy lower strike call at ask and sell higher strike call at bid | Long call intrinsic value less short call intrinsic value and net debit per share |
| Bear put debit spread | Buy higher strike put at ask and sell lower strike put at bid | Long put intrinsic value less short put intrinsic value and net debit per share |

Here `S` is the hypothetical expiration underlying price and `K` is the option strike. Return on risk divides maximum profit by maximum loss where both are finite. A long call has no finite maximum expiration profit. A long put reaches maximum expiration profit at an underlying price of zero. The expiry break-even includes modeled fees and depends on the direction of the trade.

### Worked examples

| Inputs | Entry debit | Maximum loss | Maximum profit | Break-even |
| --- | ---: | ---: | ---: | ---: |
| Buy 100 call at $3.20 and sell 105 call at $1.40 | $180 | $180 | $320 | $101.80 |
| Buy 100 put at $4.00 and sell 95 put at $2.00 | $200 | $200 | $300 | $98.00 |

Each example assumes a verified multiplier of 100, one spread, and zero fees.

## Risk and ranking

An eligible position must satisfy the chosen strategy, contract compatibility, expiration window, liquidity, quantity, and capital restrictions. A $450 account with a 5% limit permits $22.50 of loss per trade. The engine rejects a position risking $40. For spreads, the short and long legs must share the same underlying, expiration, currency, contract type, and compatible multipliers. A nonpositive or inconsistent debit fails validation.

The default workspace allows up to 5% of $10,000 account capital per trade and 20% across the portfolio. The default expiration window is 7–30 days. Review contract and position caps, event controls, and liquidity thresholds in **Paramètres** before starting a scan.

The score is a weighted average on a 0–100 scale. The strategy can remain valid with an unavailable score if a required component is missing, including the finite reward/risk ratio for a long call.

| Component | Weight | Rule |
| --- | ---: | --- |
| Liquidity | 30% | Use the least-liquid leg. Combine volume, capped at 500, with open interest, capped at 1,500, at weights of 45% and 55% |
| Payoff | 25% | Scale maximum profit divided by maximum loss, capped at 2.5 |
| Direction | 20% | Use 100 for alignment, 50 for mixed evidence, 35 for neutral evidence, and 0 for opposing direction |
| Execution efficiency | 15% | Subtract three points from 100 for each percentage point of the widest leg spread, with a floor of zero |
| Data quality | 10% | Use 100 for fresh observations and 65 for delayed observations. Demo uses simulated quality |

## Portfolio accounting

An expiration payoff uses intrinsic value at a hypothetical underlying price. A reference mark requires supported market inputs. Paper entry debit and exit credit are in total position dollars for the recorded quantity. Exit P&L subtracts closing fees and the allocated share of the opening debit and fees from the exit credit. Partial exits use cumulative cent allocation so that a fully closed trade reconciles to the original opening cost.

The stated maximum spread loss assumes the legs remain intact through settlement. Early assignment, exercise, pin risk, and broker processing can create operational exposure beyond the payoff chart model.
