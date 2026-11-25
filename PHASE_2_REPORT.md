# OPTIONS AI PRO — Phase 2 expected value engine

November 25, 2026 · Eastern time · Financial outputs in USD

## 1. Executive summary

The offline research engine evaluates all four existing strategies with two independent terminal-price models. Ten synthetic analytical cases agreed with independent numerical integration. The largest absolute expected gross payoff difference was **$2.03 × 10⁻¹¹**. All twelve Monte Carlo comparisons passed the frozen four-standard-error tolerance. Both model outputs and both decision modes remain separate.

Phase 1 reproduced −$544.90 on 23 AAPL trades. The old payoff component left 576 eligible calls unscored and saturated the component for 595 eligible puts. Phase 2 computes finite expected payoffs for both sides. The point-in-time AAPL archive contains only 251 closes. Phase 2 requires 253 available closes at each forecast, so no historical EV, realized Phase 2 P&L, or predictive validation is reported.

The research modules live under [`scripts/phase-2`](scripts/phase-2). The production score, risk settings, and application routes are unchanged. The Phase 1 comparison CSV was reproduced byte-for-byte and the browser regression for the portfolio correction passed.

## 2. Frozen research configuration and commit

The full protocol was committed before implementation and validation in **`4cec1d6addda59e0dec56c271cb162fe09044cce`**. The versioned configuration is [`scripts/phase-2/config.ts`](scripts/phase-2/config.ts).

| Parameter | Frozen value |
|---|---|
| Annualization | 252 trading sessions |
| Volatility and empirical return lookbacks | 252 completed daily returns each |
| Minimum prices | 253 consecutive completed closes |
| Historical volatility | Sample standard deviation of daily log returns, denominator 251, times √252 |
| Lognormal benchmark drift | 0% annualized arithmetic drift |
| Empirical forecast | Equal-weight contiguous horizon-matched windows from the latest 252 log returns |
| Volatility multipliers | 0.8, 1.0, 1.2 |
| Additive annualized arithmetic drift shocks | −0.05, 0, +0.05, crossed with all three multipliers |
| Standard and conservative cutoff | Strictly positive expected net dollars after costs, at baseline or at all nine points respectively |
| P&L quantiles and expected shortfall | 5%, 50%, 95% quantiles and mean of the worst 5% |
| Numerical comparison | Greater of $0.00001 absolute and 10⁻⁹ times the reference payoff. Probability rounding tolerance 10⁻⁹. |
| Monte Carlo | Seed 42, nested counts of 10,000, 100,000 and 1,000,000 with tolerance of four estimated standard errors |

The mathematical parameters and selection policy stayed fixed. A synthetic tie-break regression found a floating-point aggregation residual when many empirical observations were exactly identical. The implementation now collapses those observations to one point mass and uses the shared payoff for its exact net dollars. The correction is in `83f05f3ab8ea011c6b70831ed3aa5dda838de646`. It preserves the distribution and the frozen tie-break. Re-running the synthetic validation artifact after the correction gave identical bytes. There was no historical comparison to rerun for Phase 2.

## 3. Market clock and point-in-time history

[`history.ts`](scripts/phase-2/history.ts) counts New York regular session closes strictly after the forecast instant through the expiry close, inclusive. A session still in progress counts once, a shortened session counts once, and weekends and modeled exchange holidays count zero. A non-session expiry is invalid. At the expiry close the raw mathematical horizon is zero. Existing production eligibility still prevents a research trade at or after the expiry cutoff. It uses its existing calendar-day DTE window for screening. The forecast uses the separate session count for its annualization. The research clock uses the application's U.S. options calendar, including daylight saving, Good Friday, Juneteenth and standard early closes. Individual products can trade beyond the U.S. underlying close. A future adapter must reconcile exchange exceptions and the matching product settlement convention. [NYSE calendar](https://www.nyse.com/trade/hours-calendars) · [OCC equity specifications](https://www.theocc.com/clearance-and-settlement/clearing/equity-options-product-specifications) · [OCC ETF specifications](https://www.theocc.com/clearance-and-settlement/clearing/etf-options)

The history validator requires the latest 253 consecutive sessions at the forecast with positive closes and explicit availability times. It rejects observations claiming availability before the session close, skips future observations and unavailable revisions, and distinguishes missing closes, conflicting prints, and a post-forecast adjustment basis. The data contract requires point-in-time split-consistent price levels on the forecast's share basis. No dividend reinvestment enters the physical return series. Cash dividends remain in the corresponding ex-date price changes. The adapter supplying the history must build that basis from raw prices and actions effective and known by the forecast instant. Vendor split-adjusted or total-return series downloaded later cannot by themselves establish that basis. The underlying spot and both legs carry observation and availability times. A spot older than the last completed session and legs available only after the forecast are ineligible.

## 4. Two terminal models

**A · Lognormal.** For remaining session count `h`, use `T = h/252` and `S(T) = S₀ exp[(μ − σ²/2)T + σ√T Z]`, where `Z` is standard normal. Daily log returns are `log(Sᵢ) − log(Sᵢ₋₁)`. At `μ=0`, `E[S(T)]=S₀` exactly. Mean log return is `−σ²T/2`; using zero log drift would raise the mean price. This is a physical-distribution benchmark with undiscounted nominal expiration P&L. The optional pricing diagnostic uses a different measure.

**B · Empirical.** Sum the log returns in each of the `252−h+1` contiguous trailing `h`-return windows and exponentiate to compound. Multiply each ratio by current spot and give it equal mass. A zero horizon gives a point at spot. A horizon exceeding 252 sessions cannot be evaluated. The API gives the chronological window count, arithmetic mean and sample standard deviation of the `h`-session returns, the daily historical log mean, annualized log volatility, and sorted modeled prices. The window count includes overlapping observations. It gives no independent sample size, no reliable estimate of rare tails, and no adjustment for regime shifts or known future jumps.

[`distributions.ts`](scripts/phase-2/distributions.ts) implements both models. [`implied-volatility.ts`](scripts/phase-2/implied-volatility.ts) provides a separate European Black–Scholes diagnostic for a single option. It requires observed spot and per-share premium, strike, trading-session horizon, annualized rate and explicitly supplied continuous dividend yield. It checks strict discounted no-arbitrage price bounds and reprices the numerical root. Phase 1 had no trustworthy supplied IV or Greeks. IV does not enter the forecasts and its risk-neutral pricing assumptions cannot be used as realized volatility or probability calibration. American early exercise, especially around discrete dividends, can make the European inversion materially differ from a suitable American model.

## 5. Financial formulas and output contract

[`valuation.ts`](scripts/phase-2/valuation.ts) uses `calculateStrategy` for contract identity, quantities, fees, debit, break-even and risk bounds, and the existing payoff evaluation at degenerate and discrete break-even cases. For terminal price `s`, long call and put intrinsic values per share are `max(s−K, 0)` and `max(K−s, 0)`. Subtract the short leg for a vertical, with the resulting intrinsic bounded between zero and the strike width. Multiply by contracts × 100, then subtract `contracts × 100 × (long ask − short bid)` and the total position fees. Optional explicit execution costs add to those fees once. No extra bid/ask deduction is applied. Expected return on risk is net EV divided by the fee-inclusive maximum loss. Required break-even movement is `breakEven / spot − 1`, with sign. Null represents an unavailable break-even or unbounded maximum profit, as appropriate.

For lognormal intervals `(a,b)` in standard-normal coordinates the probability is `Φ(b)−Φ(a)` and the truncated first moment is `S₀ exp(μT) [Φ(b−σ√T)−Φ(a−σ√T)]`. The implementation integrates the linear intrinsic segment and any capped mass directly. The result is equivalent to a difference of the corresponding expected single-leg payoffs, with improved stability on narrow spreads. Put and call probabilities are calculated in their respective tails, using direct small-tail evaluation where feasible. Every modeled probability is in `[0,1]`. Positive net P&L excludes the break-even atom, maximum loss occurs at zero gross intrinsic, and finite spread maximum profit occurs in the terminal region capped at the short strike. A positive-price model assigns zero mass to the zero-underlying maximum of a long put. The maximum profit probability for a long call is unavailable.

Quantiles use the inverse CDF of net P&L. The lower expected shortfall is the integral of that quantile from 0 to 0.05, divided by 0.05. A discrete quantile atom contributes only the probability needed to complete the lower 5%. For a call payoff the worst terminal outcomes use the lower price tail, and for a put payoff they use the upper price tail. In the discrete probability test with 25 observations, one full USD −100 outcome plus a quarter of a USD −50 outcome gives ES of **−$90**. Probability values are conditional on the distribution and inputs.

### Settlement and operational limitations

All positions are modeled as intact and held to expiration with theoretical intrinsic-value settlement. Equity and ETF options can exercise into shares. An American short leg can be assigned before expiry, leaving stock exposure, dividend obligations, financing or margin requirements, or execution costs to unwind the remaining leg. Pin risk, contrary exercise instructions, after-hours price moves, exercise processing, stock borrow, taxes, and extra broker costs are outside these results. Explicit extra costs affect modeled P&L and entry risk, with no substitute for exercise/assignment state. No historical or forward study in this phase measured the size of these effects. [OCC disclosure document](https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document) · [OCC expiration pricing considerations](https://www.theocc.com/market-data/market-data-reports/series-and-trading-data/expiration-pricing-considerations)

## 6. Analytical and numerical validation

[`phase_2_validation.json`](phase_2_validation.json) contains synthetic cases only. The independent reference integrated direct leg-by-leg intrinsic against the standard normal density from −12 to +12, splitting at each strike and zero. The cases cover all four strategies, quantities 1–3, deep ITM and OTM, and two verticals with $0.001 strike width. The largest absolute error in expected gross payoff was about **$2.024 × 10⁻¹¹**, well within the smallest frozen dollar tolerance of $0.00001. At zero time or volatility the values and tail statistics matched the existing deterministic payoff. Checks covered exact break-even, both vertical caps, the long call's unbounded theoretical profit, 100-share contracts, input rejection and a separate option repricing benchmark for IV.

| Synthetic analytical case | Expected gross payoff | Independent quadrature | Absolute difference |
|---|---:|---:|---:|
| ATM long call | $345.386213 | $345.386213 | $2.84 × 10⁻¹³ |
| ATM long put | $345.386213 | $345.386213 | $1.69 × 10⁻¹¹ |
| Wide call spread, two contracts | $1,141.467823 | $1,141.467823 | $9.09 × 10⁻¹³ |
| Wide put spread | $658.690458 | $658.690458 | $2.02 × 10⁻¹¹ |
| Narrow call spread, three contracts | $0.144812 | $0.144812 | $1.57 × 10⁻¹¹ |
| Narrow put spread, three contracts | $0.155174 | $0.155174 | $1.76 × 10⁻¹¹ |

The Monte Carlo reference generated nested, seeded Box–Muller samples and calculated payoff directly by leg. Entries below give signed error and one estimated standard error of the estimate, both in USD. Errors can move away from zero between checkpoints. Standard errors fell with the larger samples. The maximum absolute standardized error was 2.41 SE.

| Case | 10,000 error ± SE | 100,000 error ± SE | 1,000,000 error ± SE |
|---|---:|---:|---:|
| ATM long call | −0.847 ± 5.270 | −3.907 ± 1.670 | +0.723 ± 0.532 |
| ATM long put | +0.657 ± 4.813 | +2.950 ± 1.526 | +0.093 ± 0.481 |
| Wide call spread | +0.338 ± 12.857 | −9.748 ± 4.048 | +1.783 ± 1.287 |
| Wide put spread | +0.439 ± 6.410 | +4.036 ± 2.028 | −0.283 ± 0.641 |

These checks address numerical correctness. They do not estimate errors in the forecast assumptions or the sampling error of historical performance.

## 7. Fixed robustness results

Model A uses `σ′=mσ` and `μ′=μ+δ`. For Model B let `rᵢ` be the horizon log price ratios and `aᵢ=mean(r)+m(rᵢ−mean(r))`. The transformed log ratio is `aᵢ + log(mean exp(r) / mean exp(a)) + δT`. The common shift preserves the expected price ratio for volatility shocks alone, and the drift factor changes it by `exp(δT)`. At `(m=1, δ=0)` the original price sample is retained. Numerical tests verified mean preservation and the expected scaling of log price spread. These are transformations of a fixed sample, rather than separate observations.

The controlled example uses spot $100, 12 remaining sessions, 20.2138% annualized historical volatility and 241 overlapping empirical windows. The empirical `h`-session mean return is +0.6073%, its sample volatility is 1.1933%, and its modeled terminal prices range from $98.9289 to $102.3023. The terminal mean is $100 in A and $100.6073 in B. The table uses fee-inclusive net dollars. Probability is shown as a percentage for the selected model. Full per-scenario values are in the synthetic JSON artifact.

| Strategy | Model | Baseline EV | EV min…max | Baseline P(profit) | P(profit) min…max | Positive scenarios |
|---|---|---:|---:|---:|---:|---:|
| Long call | A | −35.34 | −82.27…+12.23 | 30.99% | 24.90…35.33% | 1/9 |
| Long call | B | −123.96 | −148.59…−98.96 | 14.52% | 0.00…28.22% | 0/9 |
| Long put | A | −35.34 | −81.96…+11.70 | 32.20% | 25.62…36.99% | 1/9 |
| Long put | B | −184.69 | −202.02…−164.61 | 0.00% | 0.00…0.00% | 0/9 |
| Bull call spread | A | +79.47 | +57.27…+96.29 | 55.34% | 52.34…59.68% | 9/9 |
| Bull call spread | B | +129.43 | +105.51…+153.41 | 77.59% | 67.63…100.00% | 9/9 |
| Bear put spread | A | +88.76 | +62.83…+109.40 | 57.04% | 54.41…60.99% | 9/9 |
| Bear put spread | B | +7.97 | −16.01…+31.89 | 51.87% | 46.06…57.68% | 6/9 |

The bear spread passes standard mode in both models and fails conservative mode in B. The standalone call's and put's favorable individual scenarios cannot override their negative baselines. An empirical 0% or 100% here indicates an event outside or inside every transformed support point. The finite support does not establish impossibility or certainty in future markets.

## 8. NO TRADE and candidate ordering

[`decision.ts`](scripts/phase-2/decision.ts) keeps risk, data validation, and model-specific economics explicit. `evaluateResearchCandidate` rejects missing closes or quotes, invalid observation timing or basis, unsupported contracts, failed existing eligibility limits, and unevaluable model inputs. Standard mode requires positive baseline expected net P&L, and conservative mode requires it at all nine points. Both reject a zero expected net payoff. `rankResearchChain` reuses the uncapped Phase 1 enumerator with score weights disabled, retains all admissible strategy types, and rechecks the limits with the explicit additional execution costs applied. The candidate universe is the supplied, eligible, nonambiguous quotes. Provider completeness remains an upstream requirement.

Each eligible model/mode list sorts by baseline expected net USD, lower fee-inclusive maximum loss, and canonical strategy identifier. Expected return on risk is output separately. Tests evaluated more than 60 uncapped candidates, kept every eligible long call in the evaluation, reproduced both rankings on reversed input, and verified the two tie-breaks. The API indicates disagreement on eligibility or on the leading selection. The values and selections are research outputs.

## 9. Historical availability and authorized acquisition estimate

**Available locally in Phase 2.** The private Phase 1 archive contains 251 AAPL closes from 2025-11-24 to 2026-11-23, 26 signal packs, and targeted plus supplemental entry packs. No matching preceding-price panel or independent multi-symbol options panel was available. Even the last underlying date is short of 253 closes. No Phase 2 EV was calculated on historical options. Phase 1 replay was run only to verify compatibility. Historical IV and Greeks in those packs are null, consistent with Market Data's current documentation. [Market Data historical option chain](https://www.marketdata.app/docs/api/options/chain/)

**Required input.** A one-year options evaluation period with about 252 sessions generally needs about **504 underlying closes** including the 252 sessions preceding the first forecast. Add settlement-tail closes if the last signal can lead to a position beyond the evaluation cutoff. Use as-traded daily closes, a point-in-time split/action ledger, regular dividend ex-dates and terms, and contemporaneous option eligibility fields. Capture signal and next-session quotes with exact OCC identity, deliverable, bid, ask, timestamps and availability. For forward comparisons buy at the next verified ask and sell at the next verified bid, skipping and recording incomplete entries. For expiry settlement retain the product-specific settlement reference and every expiration date. For cutoff marking, predeclare whether to use a separate executable-side cutoff quote or follow every open position to its final settlement. A closing stock candle alone cannot mark an unexpired option.

| Need | Source to confirm before acquisition |
|---|---|
| Daily underlying prices | Market Data historical daily candles, requesting as-traded prices and explicit adjustment flags. Reconcile with the exchange or a licensed consolidated data vendor. |
| Closing chains and next-session bid/ask | Market Data historical `date` chains using explicit expiry/strike range and original contract IDs. Cboe DataShop Option EOD Summary/Quote Intervals is an alternative OPRA source. |
| Settlement and contract terms | Underlying exchange official close and documented product rules for the theoretical model. OCC special settlement and expiration notices for exceptions. |
| Corporate actions | As-announced issuer notices for date/factor/distribution and OCC information memos for changes to deliverable, option symbol or financial terms. |
| Historical IV and Greeks | Optional Cboe DataShop licensed calculations with documented timestamp and method. Phase 2 inputs omit these fields. |

[Historical candles and adjustment controls](https://www.marketdata.app/docs/api/stocks/candles/) · [Option EOD Summary](https://datashop.cboe.com/option-eod-summary) · [Quote Intervals and optional calculations](https://datashop.cboe.com/option-quote-intervals) · [OCC information memos](https://infomemo.theocc.com/infomemo/search) · [OCC special settlements](https://www.theocc.com/market-data/market-data-reports/series-and-trading-data/equity-special-settlements)

**Planning estimate only.** Take 26 biweekly signal dates, up to 26 next-session entry chains, one cutoff-marks request and one daily candles request per symbol. No holdout period or data was selected or viewed in Phase 2. The low/high figures assume one or two billing blocks per option response, with one for the candles, budgeted conservatively by request. Larger chains (especially SPY or QQQ), retrying missing rows, pagination, additional timestamps or vendor extras can increase the estimate. No row counts were inferred from unseen data. Published historical pricing is one credit per 1,000 option symbols returned or per 1,000 underlying candles. [Option chain pricing](https://www.marketdata.app/docs/api/options/chain/#pricing) · [Candle pricing](https://www.marketdata.app/docs/api/stocks/candles/#pricing)

| Symbol | Option snapshots | Candle requests | Approx. minimum closes | Planning credits |
|---|---:|---:|---:|---:|
| SPY | 53 | 1 | 504 + tail if needed | 54–107 |
| QQQ | 53 | 1 | 504 + tail if needed | 54–107 |
| MSFT | 53 | 1 | 504 + tail if needed | 54–107 |
| NVDA | 53 | 1 | 504 + tail if needed | 54–107 |
| AMD | 53 | 1 | 504 + tail if needed | 54–107 |
| SOFI | 53 | 1 | 504 + tail if needed | 54–107 |
| Total | 318 | 6 | — | **324–642** |

The historical AAPL demo is tokenless. Live `cached` entitlement differs from historical `date` queries. Other symbols need authenticated access. The listed free and trial tiers cover one rolling year of history, which falls short of the combined warm-up and study panel in this estimate if acquired together from Market Data. The published Starter tier provides five years and 10,000 daily credits at $30 monthly or $144 annually. That implies **one $30 monthly subscription before taxes** as the incremental provider cost if Starter is newly required and covers the approved range and internal use, or **$0 incremental** if an existing approved tier fits the historical dates, credits and licensing. The study's actual cost depends on entitlements, returned chain sizes and any alternate feed. Cboe and additional rights need a quote. Complete bid/ask matches and settlement coverage remain preflight requirements, and Phase 2 did not verify these for the six proposed symbols. [Authentication and AAPL demo](https://www.marketdata.app/docs/api/authentication/) · [Trial](https://www.marketdata.app/docs/account/plans/trader-trial/) · [Starter](https://www.marketdata.app/docs/account/plans/starter/) · [Historical freshness policy](https://www.marketdata.app/docs/account/data-freshness/)

Store licensed quotes privately under the subscriber's terms, track collection time, raw/normalized checksums and the retention/deletion obligation, and keep raw quotes and reconstructible exports out of GitHub. Public redistribution and wider commercial use require separately verified rights. [Market Data terms](https://www.marketdata.app/terms/) · [Public-use conditions](https://www.marketdata.app/terms/public-use/)

## 10. Costs, tests, and reproduction

Actual market-data API and OpenAI API use for Phase 2 was **0 requests and $0**. Only public vendor documentation was consulted and private archives were read locally. No subscription, live user data, or deployment was changed. The prospective independent options dataset stayed unopened.

| Command | Result |
|---|---|
| `npm test` | 197 passed across 15 files, including 17 new Phase 2 tests. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with zero warnings. |
| `npm run build` | Production Next.js 16.4.6 build passed. |
| `OPTIONS_TEST_PORT=3164 OPTIONS_TEST_PRODUCTION=true OPTIONS_TEST_CHROMIUM=/usr/bin/chromium npm run test:e2e -- --workers=1` | 24 passed on Chromium, including the Phase 1 portfolio regression. |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-2-validate.mjs > phase_2_validation.json` | Reproduced the synthetic artifact with all 10 quadrature and 12 Monte Carlo comparisons within tolerance. |

Commands used Node 24.22.3. The replay compatibility check was:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-1-replay.mjs \
  --cache work/phase-1-inputs/original \
  --candles work/phase-1-inputs/aapl-closes.json \
  --entry-dir work/phase-1-inputs/entry \
  --out work/phase-2-phase1-check
cmp phase_1_comparison.csv work/phase-2-phase1-check/phase_1_comparison.csv
```

## 11. Readiness and independent next-phase protocol

The engine is **technically ready to evaluate a controlled historical panel** once an authorized, point-in-time adapter supplies the required inputs. Predictive calibration, practical fill quality, robustness across underlyings and regimes, the effects of American early exercise and assignment, and expected versus realized performance are unvalidated. Lognormal tails and overlapping empirical windows have different structural limitations. Validation on synthetic math cases and the Phase 1 AAPL reproducibility check cannot establish an edge.

Before acquiring or viewing the holdout, approve and commit the symbol list, independently selected date ranges, exact signal schedule and timestamp policy, chain filters and out-of-range rules, cost model, entry/settlement policy, cash and frozen baselines, complete-coverage gates, and primary metrics. Include calibration and proper probability scoring, performance after costs, comparison sample counts, and uncertainty clustered across dates and overlapping positions. A separate exercise/assignment study can quantify the limitations before any deployment decision. Keep the fixed 252-session training history at each forecast, isolate the final holdout, and run it only after the input and leakage checks pass.

## 12. Git identifiers

| Item | Git identifier |
|---|---|
| Branch | `phase-2-expected-value-engine` |
| Phase 1 base | `954cbd1954c197218e02d99e67ac2bd1d723bfbb` |
| Frozen Phase 2 protocol | `4cec1d6addda59e0dec56c271cb162fe09044cce` |
| Models, decision layer, tests and synthetic artifact | `83f05f3ab8ea011c6b70831ed3aa5dda838de646` |

`git log -1 --format='%H' -- PHASE_2_REPORT.md` identifies this report commit on the dedicated branch. There was no merge into `main`.
