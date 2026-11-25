# OPTIONS AI PRO — Phase 1 quantitative audit

November 24, 2026 · Eastern time · USD throughout

## 1. Executive summary

The original AAPL baseline was reproduced **trade by trade at −$544.90 net (−5.449%)**. The reconstruction matched all 26 winning signal selections against the original requested option legs, the three next-session rejections, and all 23 executions' reported scores, maximum losses and expiration P&Ls. The baseline ran offline from archived market data.

The payoff score creates a measurable asymmetry. Of 576 eligible long calls, **zero scored**. All 595 eligible long puts scored and received **100/100 on the payoff component**. Removing the component changed the executed long-call/long-put mix from 0/13 to 8/2 and the net result to −$470.50. Applying a fixed, symmetric ±10% spot scenario for singles changed the mix to 12/4 and the net result to −$896.30. All three ranked runs lost money. The one-name sample was previously examined and remains exploratory.

The four modeled expiration payoffs and tested risk limits passed independent checks. A separate paper-portfolio defect allowed a quote observed before entry to affect unrealized P&L. The dedicated branch corrects it and includes a Chromium regression.

## 2. Repository and architecture

Remote `main` was verified at `a68c574bebfc2f3ccf8f2d670bb41112b090fd49`. The relevant documents are [RISK_ENGINE.md](RISK_ENGINE.md), [AUDIT_REPORT.md](AUDIT_REPORT.md), and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). The current app uses deterministic TypeScript calculations and ranking. The earlier annual replay was temporary and had not been packaged with the app. This branch adds a standalone offline tool for the audit and keeps the app's scoring behavior.

| Area | File and functions | Audit finding |
|---|---|---|
| Contract and provenance | [`src/lib/quant.ts`](src/lib/quant.ts), `makeOccSymbol`, `validateQuote`, `quotesAreSynchronized` | Checks OCC identity, 100-share multiplier, USD, quotes, timestamps, modeled US options sessions, freshness and synchronized spread legs. The normal scanner selects one chain from the provider or the attested registry. |
| Financial calculations | [`src/lib/quant.ts`](src/lib/quant.ts), `strategyTerms`, `calculateStrategy`, `payoffAt`, `createPayoffSeries` | Uses decimal arithmetic, buy ask and sell bid, applies total position fees once, and models bounded vertical settlement. |
| Eligibility | [`src/lib/quant.ts`](src/lib/quant.ts), `assessRisk`; [`src/lib/server/jobs.ts`](src/lib/server/jobs.ts), `riskPreferences`, `advanceScan` | Checks trade, portfolio, capital, quantity and liquidity limits and the expiry window. Earnings exclusion requires an independently supplied event date. The replay had no point-in-time event calendar. |
| Construction and ranking | [`src/lib/quant.ts`](src/lib/quant.ts), `constructStrategies`, `scoreOpportunity`, `compareOpportunities`, `limitRankedOpportunities` | Deduplicates by OCC identity and quote instant, evaluates the compatible pairs, ranks each long leg's spreads before applying caps, and preserves strategy/expiry coverage in the final list. |
| Provider queries | [`src/lib/server/marketData.ts`](src/lib/server/marketData.ts), `chainUrl`, `readChain`, `fetchMarketQuotes` | The live adapter is owner-gated and requests cached standard chains. Phase 1 read historical closing snapshots with the original query limits. |
| Historical simulation | [`scripts/phase-1-replay.mjs`](scripts/phase-1-replay.mjs), [`scripts/phase-1/replay.ts`](scripts/phase-1/replay.ts), [`scripts/phase-1/inputs.ts`](scripts/phase-1/inputs.ts), [`scripts/phase-1/candidate-audit.ts`](scripts/phase-1/candidate-audit.ts) | Offline scheduling, input validation, candidate enumeration, next-session risk checks, expiration settlement and CSV export. The app itself remains a scanner and paper journal. |

The documented financial rules and default score match the code. The default quote quality component assigns 65 to delayed or manually attested observations and 100 to fresh observations. In this baseline, delayed historical observations all supplied the same quality value. Market Data's claim about historical entitlement is separate from the live adapter's cached mode. The older audit describes no app-integrated historical backtester, which remains accurate.

## 3. Baseline reproduction

The replay used 251 AAPL sessions from 2025-11-24 through 2026-11-23. The first scan was at the US session close on November 24. Fourteen-calendar-day anchors roll forward to the next trading session. Entries use the next session close and the selected OCC legs' actual archived bid/ask. The final anchor lacks a next session inside the study window. The expiration filter was 7–30 days. The filtered provider archives happened to contain expiries only 7–25 days from the signal. The test used one contract per leg, a 100-share multiplier, $10,000 fixed reference capital, 5% trade risk, 20% portfolio risk, an eight-position cap, a 35% widest leg bid/ask limit and $1.30 total entry fees per position. Direction weight was zero. The filled position was kept until expiration, using the unadjusted underlying close for theoretical cash intrinsic settlement. No rollover or replacement trade was permitted.

| Baseline check | Reproduced |
|---|---:|
| Selected signals | 26 |
| Entries / settled positions | 23 / 23 |
| Entries rejected | 3 |
| Gainers / losers | 7 / 16 |
| Win rate | 30.434783% |
| Maximum-loss trades / frequency | 15 / 65.217391% |
| Gross P&L before fees | −$515.00 |
| Modeled entry fees | $29.90 |
| Net P&L / reference capital return | **−$544.90 / −5.449%** |
| Mean net per execution | −$23.69 |
| Profit factor from net winning and losing trades | 0.811179 |

The three signal dates with rejected next-session entries were June 8, June 22 and September 28, 2026. The newly priced maximum losses were $756.30, $501.30 and $666.30, respectively. Each exceeded the $500 trade limit. Entry checks used the actual quote timestamps and the next session's spreads and expiration window. The fixed biweekly cadence and 30-day horizon hold at most three positions concurrently, so the 20% and eight-position limits could not bind in these runs. Their boundaries were tested independently.

| Executed baseline strategy | Trades | Wins | Losses | Net |
|---|---:|---:|---:|---:|
| Long call | 0 | 0 | 0 | $0.00 |
| Long put | 13 | 3 | 10 | −$822.90 |
| Bull call debit spread | 7 | 2 | 5 | +$56.90 |
| Bear put debit spread | 3 | 2 | 1 | +$221.10 |

## 4. Financial calculation validation

The independent checks use intrinsic value per leg, multiply by `quantity × 100`, subtract the opening debit and total fees, and check expiration points below, at, and above both strikes and the fee-inclusive break-even. For two contracts per leg and $1.30 total position fees, the following analytical examples reconciled with `calculateStrategy` and `payoffAt`.

| Position and premiums per share | Entry debit | Max loss | Max net profit | Break-even |
|---|---:|---:|---:|---:|
| Long call K=100 bought at 3.20 | $640.00 | $641.30 | Unbounded | 103.2065 |
| Long put K=100 bought at 4.00 | $800.00 | $801.30 | $19,198.70 | 95.9935 |
| Call spread K=100/105 bought at 3.20, sold at 1.40 | $360.00 | $361.30 | $638.70 | 101.8065 |
| Put spread K=100/95 bought at 4.00, sold at 2.00 | $400.00 | $401.30 | $598.70 | 97.9935 |

Example formulas use `I = max(S−K,0)` for calls and `I = max(K−S,0)` for puts. Signed long-minus-short intrinsic yields spread settlement, bounded between zero and its strike width. `net = intrinsic × quantity × 100 − entry debit − fees`. Reported break-even includes fees per share. Existing risk plus new trade risk is tested against the portfolio ceiling. On a $450 account at 5%, $22.50 is accepted and $22.51 is rejected. Applying $67.50 of existing risk with a 20% portfolio cap accepts exactly $22.50 more. $67.51 of exposure rejects the same new position. The engine rejects fractional quantities and nonstandard contract multipliers.

An independent integer-money cross-check covered 200 analytical cases, four strategy types, quantities 1–7 and prices around the strikes. All 2,400 assertions passed. Independent intrinsic calculations using archived next-day option quotes and expiration closes also reconciled all 23 original dollar P&Ls. Synthetic analytical tests measure the formulas and boundary behavior. Only archived observations support the performance results.

## 5. Structural scoring and candidate selection

Production scoring weights are 30 liquidity, 25 payoff, 20 directional alignment, 15 execution and 10 quality. With direction disabled for A, the payoff component is **31.25%** of the resulting score. A finite maximum-profit-to-loss ratio of 2.5 saturates the component. Long calls have an unbounded maximum profit and an unavailable ratio. The engine leaves any candidate with an unavailable enabled component unscored. Long puts use the intrinsic ceiling at a zero underlying price. Every eligible standalone put in this sample reached the cap even though the chance of realizing the theoretical ceiling is unmeasured.

| Signal candidate type | Exhaustively eligible | Scored by A | Kept by production caps | First in A before the entry check |
|---|---:|---:|---:|---:|
| Long call | 576 | 0 | 127 | 0 |
| Long put | 595 | 595 | 310 | 16 |
| Bull call debit spread | 2,696 | 2,696 | 649 | 7 |
| Bear put debit spread | 2,874 | 2,874 | 474 | 3 |
| Total | 6,741 | 6,165 | 1,560 | 26 |

**Out-of-the-money selection.** The $500 cap helped shape the standalone candidate set. At signal close, 558 of 576 eligible calls and 578 of 595 eligible puts were strictly OTM. Median maximum loss was $224.80 for OTM calls versus $461.30 for other calls, and $251.30 for OTM puts versus $476.30 for other puts. OTM puts averaged a 71.35 total score compared with 70.06 for the 17 non-OTM puts. The payoff component saturated for both put groups, so it did not distinguish how far OTM a put was within this sample. A large theoretical payoff can earn full credit even when a trade requires a substantial move over a short period. Payoff, liquidity, spreads and quote quality describe the contract. No component estimates a realized-outcome probability.

**Validation and coverage.** The 26 filtered chains contained 3,216 raw rows. Four crossed bid/ask records were excluded. The 3,212 usable observations contained 1,605 calls and 1,607 puts, spread over 3–6 expirations per signal date. The post-filter exhaustive enumerator tested each eligible long and every compatible ordered vertical pair without the display caps. Tests cover duplicate/conflicting books, expiry, timestamps, identity and wrong multipliers. Normal live scans source their quotes from one automatic or attested chain at a time.

**Truncation.** The five-spreads-per-long cap removed 69 candidate instances. The final 60-per-symbol cap removed another 5,112. Its strategy/expiry coverage pass, together with the first cap, left out 253 members of the exhaustive top-60 lists. Across all 26 dates the best candidate survived, production kept no candidate outside the exhaustive eligible set, and the complete visible list stayed identical when reversing rows or grouping calls first. The caps materially change the secondary shortlist. They explained none of the first picks in this replay. The upstream strike and expiry filters define the sampled universe.

**Tie-breaks and direction.** Fifteen scans had tied rounded top scores. Resolving ties by lower max loss before OCC identifier changed seven winners within those ties relative to sorting only by identifier and reduced the sum of signal-side maximum loss by $717.00. In a ranking-only diagnostic, putting the default 20 weight on the same assumed neutral direction for every candidate changed seven top choices and increased long-put selections from 16 to 18. A constant neutral component compresses score differences and changes rounding ties. This diagnostic used no directional forecasts or comparative P&L.

## 6. Frozen experiment and comparisons

The pre-result protocol is in [`scripts/phase-1/config.ts`](scripts/phase-1/config.ts) and commit `5ae93e7`. All runs used the original observed signal universe, cadence, risk limits, fees, same-contract next-session entry and hold-to-expiration rules. Zero direction weight applies to all scored runs because no historical theses were archived.

- **A** uses the original score. **B** sets payoff to zero and renormalizes liquidity, execution and quality proportionally.
- **C** uses the original structure and replaces the standalone option payoff component with the ratio of scenario expiry P&L to max loss. The scenario uses signal spot +10% for calls and −10% for puts. The ratio is floored at zero and capped at 2.5. Spreads keep the original component. The two moves are conventions of equal percentage magnitude, with no volatility or time scaling and no claim about their probability.
- **D** draws uniformly among the exhaustive eligible candidates, including unscored long calls. It uses the 20 fixed seeds and a stable identifier order. The seed/date hash and rejection sampling make each uniform draw reproducible. **E** holds non-interest-bearing cash.

| Config | Signals | Entries | Rejected | Call / Put / Call spread / Put spread filled | W / L | Win rate | Max loss count | Gross | Fees | Net | Return | Mean net | Profit factor |
|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 26 | 23 | 3 | 0 / 13 / 7 / 3 | 7 / 16 | 30.43% | 15 | −515.00 | 29.90 | **−544.90** | −5.449% | −23.69 | 0.8112 |
| B | 26 | 25 | 1 | 8 / 2 / 13 / 2 | 11 / 14 | 44.00% | 13 | −438.00 | 32.50 | **−470.50** | −4.705% | −18.82 | 0.8001 |
| C | 26 | 21 | 5 | 12 / 4 / 2 / 3 | 6 / 15 | 28.57% | 14 | −869.00 | 27.30 | **−896.30** | −8.963% | −42.68 | 0.6283 |
| E | 0 | 0 | 0 | 0 / 0 / 0 / 0 | 0 / 0 | — | 0 | 0.00 | 0.00 | **0.00** | 0% | — | — |

All selected legs in A–D had valid entry quotes. In D, seven of twenty seeds each had one entered position expiring after the cutoff. No post-period settlement or assumed liquidation was used. The all-seed distribution below measures realized P&L through November 23 using settled positions. It omits the open positions from the numerator. It cannot provide a full-horizon return for every seed. No seed was dropped or selected for performance.

| D distribution over all 20 seeds | Minimum | Median | Mean | Maximum |
|---|---:|---:|---:|---:|
| Signals | 26 | 26 | 26 | 26 |
| Entries | 17 | 20.5 | 20.55 | 23 |
| Entry risk rejections | 3 | 5.5 | 5.45 | 9 |
| Long calls filled | 0 | 1 | 1.25 | 3 |
| Long puts filled | 0 | 1 | 1.45 | 3 |
| Bull call spreads filled | 3 | 8 | 8.50 | 15 |
| Bear put spreads filled | 3 | 10 | 9.35 | 14 |
| Fees for all fills | $22.10 | $26.65 | $26.715 | $29.90 |
| Positions settled by cutoff | 17 | 20 | 20.20 | 22 |
| Winning settled positions | 4 | 7 | 7.45 | 13 |
| Losing settled positions | 6 | 13.5 | 12.75 | 16 |
| Win rate among settled | 20.00% | 31.82% | 37.07% | 66.67% |
| Maximum-loss settled positions | 6 | 12 | 11.70 | 15 |
| Gross P&L on settled positions | −$1,949.00 | −$1,075.50 | −$610.75 | +$1,950.00 |
| Realized subtotal | −$1,976.30 | −$1,102.15 | −$637.01 | +$1,926.60 |
| Net average per settled position | −$94.11 | −$56.045 | −$31.0565 | +$107.03 |
| Profit factor on settled positions | 0.3780 | 0.6484 | 0.8755 | 2.5769 |

B lost $74.40 less than A with two more executions and a slightly lower profit factor. C lost $351.40 more than A. Cash outperformed all three ranked configurations on this sample. D's wide dispersion and unsettled positions prevent a strong comparison with cash or the ranked portfolios. Adequate daily marked portfolio equity would require authorized ongoing option marks. Maximum drawdown is blank for A–D. The idle cash curve has zero drawdown.

## 7. Individual trades and break-even

The private `phase_1_trades.csv` contains all 23 original executions, with signal, entry, expiry, strategy, option identity and strikes, entry and expiry underlying closes, bid/ask inputs used for entry, contract quantity and multiplier, debit, DTE, moneyness, maximum loss and profit, break-even, required and actual percentage changes relative to entry, gross intrinsic payout, fees, P&L, and flags for favorable movement and maximum loss. Positive moneyness denotes ITM on the leg's option side. Required and actual price changes are signed, so a put can require a negative move. Net P&L includes the total entry fees once.

Thirteen positions had a favorable underlying move measured from entry to expiry. **Six still lost.** Five expired with zero intrinsic payout because the move never crossed the long strike at expiration. The other, a bull call spread from the September 14 signal, paid $107.00 at expiration against $118.30 of entry debit plus fees, for a net loss of $11.30. All six favorable moves were smaller than their fee-inclusive break-even moves. The median absolute move required to break even across all trades was **3.7361%**, versus a median absolute move observed of **3.3833%** on the same trade intervals. This comparison helps explain the sample and does not infer the expected move or establish a significance test.

The highest score, 96/100, was a bull call spread from the first November 24 signal. The underlying rose in the favorable direction by 0.6535% against a 2.2360% break-even requirement. It lost the full $66.30 maximum risk. This is a concrete example of contract quality and modeled upside producing a high score with an unfavorable economic outcome.

## 8. Historical data and entitlements

| Inputs | Validated availability |
|---|---|
| AAPL daily underlying | 251 unadjusted-labeled consecutive session closes from 2025-11-24 through 2026-11-23. The close matched `underlyingPrice` in every archived options row with that field. The original retrieval headers for the candle file were unavailable. |
| AAPL signal chains | 26 trading dates from 2025-11-24 through 2026-11-09. The exact original query is recoverable from the SHA-256 prefix of each filename. Both sides, historical bid/ask, expiration, strike, snapshot time and volume/open interest when provided. |
| Original targeted entry quotes | 36 quotes across 26 next sessions from 2025-11-25 through 2026-11-10. All 52 original signal and entry request URLs matched their archive filename hashes. The targeted entries alone covered A. |
| Supplemental entry coverage | 26 public AAPL historical snapshots, 4,516 valid rows, covering all 3,212 usable signal contracts on their next session. Zero quote conflicts with overlapping original inputs. The request range was limited to recorded signal expiries and strikes. |
| Other AAPL archives | The January 6, 2020 sample contains 158 call/put rows at one expiry. November 20, 2026 probes demonstrate truncation sensitivity. A naïve 48-row query returned all calls, while the original-style filtered query returned 144 balanced rows over six expirations. |
| Other underlyings | No equivalent local options panel for NVDA, AMD, SOFI, TSLA, SPY or QQQ. The old SPY response requested a token. Its HTTP status was not saved. |
| Volatility and Greeks | The `iv`, `delta`, `gamma`, `theta` and `vega` fields were null in all original and supplemental AAPL responses. No Greek, volatility or directional attribution was inferred. |

The provider documents historical date-based closing snapshots, with broader expiry coverage supported via a range or `expiration=all`. This audit proved coverage of the observed trade universe. Exchange-wide chains, intraday historical options quotes and coverage for other symbols were outside the observed evidence. The provider documents an AAPL historical demo without a token. HTTP 402 is entitlement-specific. Free or trial access can reject `mode=cached` and still allow historical dates within plan and freshness limits. A historical request can also return 402 for an ineligible date or plan. The user's prior 402 involved cached chains. Phase 1 verified the public AAPL path without account credentials. Coverage on the user's subscription and eligibility for the intended wider research remain open. [Request authentication](https://www.marketdata.app/docs/api/authentication/) · [Historical option chains](https://www.marketdata.app/docs/api/options/chain/) · [Data freshness](https://www.marketdata.app/docs/account/data-freshness/) · [HTTP 402](https://www.marketdata.app/docs/api/troubleshooting/payment-required/)

## 9. Bugs and corrections

The paper portfolio previously let a valid, fresh, attested quote from before a position's entry determine the displayed liquidation value and unrealized P&L. For a spread, one stale relative-to-entry leg was enough. The correction measures the earliest observation across all legs and requires it to be at or after entry. The regression reproduced a $29.00 unrealized gain and $190.00 liquidation mark on a pre-entry quote before the fix and now checks both rejection and acceptance exactly at entry. This change is isolated in commit `6dc6b92`. Neither the archived baseline scoring nor the production eligibility rules needed modifications for the confirmed findings. B and C remain research configurations.

## 10. Automated validation

Verification ran on Node 24.22.3 and Next.js 16.4.6. The production browser suite used system Chromium 156.

| Command | Result |
|---|---|
| `npm test` | 180 passed in 14 Vitest files. The 15 added tests cover finance, risk limits, ranking asymmetry, candidate caps, input order and conflicts, replay timing, deterministic random selection and missing quotes or settlement. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with zero warnings. |
| `npm run build` | Optimized production build passed. |
| `OPTIONS_TEST_PORT=3158 OPTIONS_TEST_PRODUCTION=true OPTIONS_TEST_CHROMIUM=/usr/bin/chromium npm run test:e2e -- --workers=1` | 24 passed, including the new regression on the paper portfolio. |

Unit tests use analytical fixtures. The browser tests use a test workspace and controlled data for live rendering. Real-data validation ran the baseline and supplemental replays against the historical archives and verified the matching trade ledger and complete next-session coverage. Native Safari and hosted live services were outside this phase.

## 11. API requests, costs and reproduction

The baseline, experiments, candidate diagnostics, and application tests can be rerun offline. The only new market requests were 26 token-free AAPL historical entry queries. Each returned HTTP 203 with `X-Api-Ratelimit-Consumed: 0`. Reported credits consumed and new paid charges were zero. The optional collector requests only the recorded date/expiry/strike union and stops if zero-credit success is unconfirmed. API use included zero OpenAI calls and zero subscription changes.

Run from the repository root using Node 24.22.3. The private paths below are the Phase 1 workspace copies. Supply equivalent authorized archives when reproducing in a separate environment.

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-1-replay.mjs \
  --cache work/phase-1-inputs/original \
  --candles work/phase-1-inputs/aapl-closes.json \
  --entry-dir work/phase-1-inputs/entry \
  --candidate-audit --out work/phase-1
```

Use `--baseline-only` to run A and the cash control using only the original archives. The source inputs are the 52 original hashed option response files, the original `result.json` and the independent candle file. The `--entry-dir` receipts for B–D contain date-named response files and a `usage.json` manifest with URLs, response hashes, status, row counts and consumption. The candle SHA-256 is `86afc5db40ad2b6f82babf6bcd20f4c63868443bf350aef30e574bcfa811d5db`; the original result SHA-256 is `e2c2e650baf2047e5d0bbe743e79544c017bf159fcbe6003beb58c5a7a890aba`. The implementation validates conflicts, records missing entries and withholds full P&L when coverage is incomplete. The authorized private workspace holds the quote payloads, baseline archive, audit diagnostics and per-trade CSV. The Git branch includes only implementation, tests, scope and aggregate results. [Market Data terms](https://www.marketdata.app/terms/) · [Public-use rules](https://www.marketdata.app/terms/public-use/)

## 12. Limitations

- AAPL and one examined year provide 23 baseline fills and overlapping exposures. The trades are not independent observations. There was no test of statistical significance, continuing edge, model parameter optimization, or historical OpenAI accuracy.
- EOD bid/ask quotes support a conservative pricing convention. Actual fills, size availability, slippage beyond the spread, early assignment, exercise costs, taxes and early exits are outside the modeled execution. The fixed reference capital is used for sizing throughout. The modeled fees cover entry only.
- The quote clock for historical evaluation is New York's session close. Retrieval metadata are missing for the original archive. The adapter uses the recorded observation timestamp for replay time, and indicators or research that may only be available later must be separately timestamped in future studies.
- Variants and the random comparison are conditioned on the prefiltered option chain. Markets, dates, strikes and listings outside the sample may have different structures. The cutoff excludes seven unexpired random positions from realized P&L.

## 13. Recommended next step

**Secure an authorized, point-in-time options dataset and lock an independent multi-symbol holdout protocol.** It should include exact next-session bid/ask and expiration or mark data for every candidate comparison, with stable timestamps, fees and archives of contemporaneous directional evidence if the AI contribution will be measured. Validate rankings against cash and predeclared random draws on that holdout before committing to a forecasting engine or changing the production score.

## 14. Git identifiers

| Item | Identifier |
|---|---|
| Dedicated branch | `phase-1-quantitative-audit` |
| Verified upstream baseline | `a68c574bebfc2f3ccf8f2d670bb41112b090fd49` |
| Pre-result experimental freeze | `5ae93e7` |
| Isolated portfolio correction | `6dc6b92` |

From the dedicated branch, `git log -1 --format='%H' -- PHASE_1_REPORT.md` identifies the consolidated report commit. The phase did not merge into `main`.
