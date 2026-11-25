# OPTIONS AI PRO — Phase 3 data feasibility and independent protocol

November 25, 2026 · Eastern time · USD for provider prices

## 1. Executive summary

**The protocol and offline infrastructure are complete. Phase 4 is blocked pending provider and timing approval.** The last account evidence in this conversation showed Market Data Trader Trial, whose published one-year history excludes every frozen options signal date as of November 25, 2026. A free or hybrid route for the full panel could not be verified. Starter is documented to cover the requested dates, but its historical EOD archive cannot supply the contemporaneous pre-order observation required for an entry on the next session.

The frozen primary design retains a next-session entry with a licensed pre-close quote and spot snapshot, a locked order, and a later closing quote used only to test a conditional simulated fill. **For lowest cost, seek approval for the proposed EOD-only D+2 amendment and verify ETF close coverage and licensing first.** Market Data Starter is the lowest documented monthly subscription for that path at $30 before taxes. If the next-session design takes priority, obtain a dated scope and private research-use confirmation for a licensed intraday feed before spending. Pricing and all cost alternatives are estimates. [Market Data Starter](https://www.marketdata.app/docs/account/plans/starter/) · [Market Data historical availability](https://www.marketdata.app/docs/account/data-freshness/) · [ThetaData pricing](https://www.thetadata.net/pricing) · [Cboe Option Quote Intervals](https://datashop.cboe.com/option-quote-intervals)

Phase 1's baseline reproduced −$544.90 across 23 AAPL positions, with the historical long-call scoring asymmetry. The Phase 2 payoff, probability, stress and NO TRADE outputs remain unchanged. Phase 3 used no evaluation options observations, incurred $0, and did not execute the comparative backtest.

## 2. Frozen design and calendar

The complete [study protocol](PHASE_3_PROTOCOL.md) and [executable configuration](scripts/phase-3/protocol.ts) were committed before any evaluation data access. The exact freeze is **`2ff3fa43d72bbeb96bf7e60753ec9dcc3ce6c789`**. The base is the completed Phase 2 report commit `c7bda67c1b694a33f2fded16bf7451512206985e`, with unchanged model parameters from `4cec1d6addda59e0dec56c271cb162fe09044cce`. The previous AAPL sample is excluded. The 156 ticker-date pairs remain dependent within dates and across overlapping positions.

| Calendar item | Verified schedule |
|---|---|
| Universe | SPY, QQQ, MSFT, NVDA, AMD, SOFI |
| First underlying date | **2023-10-19** |
| First signal and entry sessions | 2024-10-21 and 2024-10-22 |
| Cadence | Every 14 calendar days, with a holiday roll rule. All 26 actual anchors are regular trading sessions. |
| Last permitted signal | 2025-10-17 |
| Last scheduled signal and entry sessions | **2025-10-06** and 2025-10-07 |
| Latest eligible expiry from the last scheduled signal | **2025-11-05** |
| Latest eligible expiry even from the permitted limit | 2025-11-14, because calendar day 30 falls on a Sunday |
| Last settlement cutoff | **2025-11-21 21:00 New York time** |
| Required closes | **526 per symbol**, including 252 prior to the first signal and the signal close as observation 253. **3,156** closes across the six. |

Calendar checks use New York daylight saving, holidays and early closes. The January 9, 2025 national day of mourning is excluded. Each exact observation and clock is in the [request manifest](phase_3_data_manifest.json). [NYSE historical holiday calendar](https://s2.q4cdn.com/154085107/files/doc_news/NYSE-Group-Announces-2023-2024-and-2025-Holiday-and-Early-Closings-Calendar-2022.pdf) · [NYSE January 9 closure](https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx)

The capital rules are $10,000 actual initial cash, $10,000 fixed risk-sizing reference, $500 max single-position loss, $2,000 aggregate open risk, eight positions maximum, and one new selection across the full universe at each scheduled date. The eight configurations are A original and capped, B Phase 1 without payoff, C/D lognormal standard/conservative, E/F empirical standard/conservative, G random eligible with all 20 fixed seeds, and H cash. D is the sole primary experimental configuration. The primary P&L and paired date-block uncertainty method, secondary calibration and economics metrics, and missing-data policy are frozen in the protocol. Underlying close coverage for every legal expiry is checked before final evaluation.

## 3. Timing and Phase 2 integration

| Event | Approved research-clock convention in the frozen design |
|---|---|
| Underlying and signal books observed | Regular U.S. equity close on D, normally 16:00 ET, at the approved product-compatible timestamp. |
| Historical inputs available | Underlying close plus 16 minutes. D option chain at 09:31 on the next regular session. These are conservative explicit reconstructions from published provider timing, subject to evidence. Actual archive receipt is a separate immutable value. |
| Forecast and one selection | D+1 at 09:45 ET, using the D spot, D signal bid/ask and the 253 completed closes available then. |
| Pre-order evidence and decision | On D+1, observed 45 minutes before the regular close and demonstrably available by the lock 20 minutes before close. On ordinary days this means 15:15 observed and available by 15:40. Require contemporaneous options and spot. C–F revalidate the same selection's economics with the frozen engine. |
| Conditional execution | D+1 at the later regular close against the fixed buy/sell limits and executable size. The observed outcome is recorded after the decision and supplies no ranking or EV input. |
| Expiration | Intrinsic using the matched regular underlying expiry close. Settle only when evidence becomes available. Same-time orders cannot use unsettled proceeds. |

The 7–30 calendar DTE signal filter refers to D. Its risk projection at 09:45 D+1 offsets that date difference while leaving the Phase 2 forecast clock and trading-session annualization intact. At the later order check the ordinary 7–30 day restriction applies to its own date. In the research adapter only, `ContractQuote.retrievedAt` represents documented historical availability as required by Phase 2's existing interface. Actual retrieval is retained separately, original observations are preserved, and live Market Data freshness rules are untouched. EOD volume is eligible only when available by the decision. [Phase 2 input clock](scripts/phase-2/history.ts) · [Historical observations](scripts/phase-3/observations.ts) · [Signal eligibility projection](scripts/phase-3/eligibility.ts)

This sequence prevents use of the same D+1 closing quote to make and fill an order. The published history rule for options, next session after 09:30 ET, cannot prove delivery of a particular archived print. Require licensed pre-order timestamp evidence, validated later closing observations, and sufficient displayed size. A fill conditional on displayed prices and sizes remains a simulation of execution feasibility. ETF options can have trading up to 16:15, so an archive stamped 16:15 must not be substituted for the 16:00 common-clock observation. Confirm SPY and QQQ coverage before any full acquisition. [Timing and settlement semantics](https://www.marketdata.app/docs/api/options/chain/#point-in-time-semantics) · [Cboe U.S. hours](https://www.cboe.com/about/hours/us-options/) · [OCC ETF specifications](https://www.theocc.com/clearance-and-settlement/clearing/etf-options)

The dormant **D+2** proposal uses D+1 EOD at D+2 09:45, locks the order then, and uses D+2 EOD solely as later execution evidence. It needs explicit approval and a separate pre-evaluation commit. The 2024-12-31 snapshot is more than 36 hours old on January 2 at 09:45 due to New Year's Day. Under unchanged freshness the affected anchor would have a common rejection, and the scheduled date would remain in the comparison. This alternative was not activated or simulated.

## 4. Access and provider choices

| Route | Status from available evidence |
|---|---|
| Existing Market Data account | The previous screenshot showed Trader Trial, 100,000 daily credits, and 0 then used. The account could not be authenticated or rechecked here. Published Trial reset is 09:30 ET and historical depth is one year for these non-demo symbols. Prior HTTP 402 involved live cache access. It does not determine historical date-based rights. |
| Free or hybrid | Public AAPL history without a token does not cover the six symbols. Free Market Data is one year and 100 daily credits. A free stock source could replace the candle subset only if licensing, as-traded prices, actions and availability are verified. No screened source established all of those for the six titles, and free stock data would still leave the older options history unaccounted for. |
| Market Data Starter | Documented $30/month or $144/year, 10,000 credits/day and five years. Historical `date` chains include bid/ask, timestamps, size and liquidity fields when supplied. Real coverage, usable timestamp and private commercial-research rights require confirmation. Fits the date-range requirement for D+2 only, subject to that coverage check. |
| Licensed intraday alternatives | ThetaData Value advertises $40/month and one-minute historical options quotes, with coverage listed from 2020. Cboe DataShop offers historical OPRA NBBO quote intervals with sizes and optional Greeks, with configured pricing on request. Confirm exact synchronized option and spot timestamps, complete dated-series coverage, archive delivery/availability evidence and research/retention rights. These claims are documentation, not account or data validation. |

[Trader Trial](https://www.marketdata.app/docs/account/plans/trader-trial/) · [Free Forever](https://www.marketdata.app/docs/account/plans/free-forever/) · [Starter](https://www.marketdata.app/docs/account/plans/starter/) · [Credits and reset](https://www.marketdata.app/docs/api/rate-limiting/) · [AAPL demo and authentication](https://www.marketdata.app/docs/api/authentication/) · [ThetaData historical quote](https://thetadata.net/docs/operations/option_history_quote.html) · [Cboe EOD Summary](https://datashop.cboe.com/option-eod-summary) · [Alpha Vantage documented daily-series limits](https://www.alphavantage.co/documentation/)

For the primary design, Market Data Starter plus ThetaData Value would be **indicatively $70/month before taxes** if both subscriptions are necessary and their contemplated uses and exact deliveries are permitted. Cboe or rights for product/commercial research could change the price. A personal archive requires private, approved storage and retention. Market Data documentation prohibits raw redistribution under personal plans and includes deletion requirements on expiry/lapse for paid or trial data. Verify lawful internal use for OPTIONS AI PRO, permitted copies, and retention period in writing before acquiring data. [Market Data terms](https://www.marketdata.app/terms/) · [Public use policy](https://www.marketdata.app/terms/public-use/) · [ThetaData terms](https://www.thetadata.net/terms-and-conditions)

**Availability-based alternate period only.** If the date range is changed to fit the advertised one-year options window as of November 25, 2026, December 1, 2025 through October 19, 2026 gives 24 biweekly anchors and latest possible expiry November 18, with a possible Nov 24 cutoff. The first 252 preceding closes would still start November 26, 2024, requiring an authorized external warm-up archive. This would be a smaller study and still need the approved timeline and licensing. It has not replaced the frozen dates.

## 5. Exact acquisition design and planning cost

All symbols require 526 underlying closes through the cutoff, point-in-time splits and ordinary dividend records, correct OCC deliverable/settlement terms, both sides of each covered standard listed book, original signals, exact-leg next-session books, an independent pre-close spot and option snapshot, and a verified official expiry close. A single daily candles request spans each symbol's full planned window. The request manifest fixes dates, expiry band, query parameters, and stages. Strike bounds are a deterministic outward-cent rounding of the observed signal close's ±20% band. The derived private URL plan is hashed again before any request is sent. The same strike/expiry band is used for the later chain. A partial chain or a row count at the 4,001 sentinel blocks eligibility until a separately authorized coverage-preserving transport amendment. Volume and OI are archived without vendor spread filtering. Historical trading quotes and contractual settlement terms are distinct. [Market Data candles](https://www.marketdata.app/docs/api/stocks/candles/) · [Option chains](https://www.marketdata.app/docs/api/options/chain/) · [OCC information memos](https://infomemo.theocc.com/infomemo/search)

| Symbol | Daily requests | Signal chains | Later fill chains | Licensed pre-close observations | Market Data credits, planning range / reserved ceiling |
|---|---:|---:|---:|---:|---:|
| SPY | 1 | 26 | 26 | 26 | 53–209 / 261 |
| QQQ | 1 | 26 | 26 | 26 | 53–209 / 261 |
| MSFT | 1 | 26 | 26 | 26 | 53–157 / 261 |
| NVDA | 1 | 26 | 26 | 26 | 53–157 / 261 |
| AMD | 1 | 26 | 26 | 26 | 53–157 / 261 |
| SOFI | 1 | 26 | 26 | 26 | 53–157 / 261 |
| Total | **6** | **156** | **156** | **156** | **318–1,046 / 1,566** |

The **318** base Market Data requests are derived from the frozen calendar. The 156 licensed snapshots are panel obligations, not a claim about vendor HTTP call counts. The credit intervals assume 1–4 one-thousand-row blocks per SPY/QQQ chain and 1–3 for the other symbols, with a one-credit candle reservation per symbol. The upper reserves allow five blocks per chain at the sentinel. Response sizes, compression, retries and billable rows are unverified. Actual counts are determined by provider receipts. The proposed D+2 route adds a second later chain per panel, yielding **474** Market Data requests, planning range **474–1,566** credits and a **2,346** reserve. The estimate excludes independent inventory/action evidence, alternative timestamp sources, provider extras and pagination. Reserve approximately **4 GiB** of private disk for raw, normalized and temporary inputs of the primary plan as a planning allowance. Verify storage and memory use with an approved, small sample before a full batch. [Machine-readable estimate](phase_3_cost_estimate.json) · [Historical chain pricing](https://www.marketdata.app/docs/api/options/chain/#pricing) · [Candle pricing](https://www.marketdata.app/docs/api/stocks/candles/#pricing)

No local independent six-symbol evaluation panel was available. The Phase 1 authorized AAPL sample remains exploratory. Documented five-year candles cover the planned warm-up dates on paper, conditional on date entitlement, all 526 consecutive as-traded closes, and complete split/action evidence. NVIDIA's announced 10-for-1 split, effective for split-adjusted trading June 10, 2024, is inside the warm-up. The adapter applies dated, known splits to the price history available at each forecast and preserves actual settlement prices. Exact licensed expiry and quote timing remain validation gates. [NVIDIA 2024 announcement](https://investor.nvidia.com/news/press-release-details/2024/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2025/) · [OCC adjustment memo](https://infomemo.theocc.com/infomemos?number=54623)

## 6. Private pipeline and readiness gate

- [`acquisition.ts`](scripts/phase-3/acquisition.ts) limits requests to bounded historical HTTPS queries, deduplicates by URL, validates raw response shape and limits, and journals attempts, credits, retrieval time and raw SHA-256. A confirmed provider quota response carries the resumable reset time. Entitlement errors, uncertain credits, overrun, corrupt cache, and approval changes fail closed. The quota counts attempts across invocations in the same approved private journal. Tokens are read from the process environment without logging and never enter the manifest. The USD authorization remains a recorded human approval. Code enforces request/credit limits and cannot purchase or verify a provider invoice.
- [`observations.ts`](scripts/phase-3/observations.ts) normalizes historical candles/chains and independently licensed quote/spot and action packets. It keeps provenance, quote timing, display size and liquidity availability, validates OCC and crossed books, quarantines conflicts and bounds, and separates raw data, reconstructions, and assumptions. The licensed provider packet is an import interface. Phase 3 did not purchase or convert a vendor download into those packets.
- [`gates.ts`](scripts/phase-3/gates.ts) verifies exact protocol and plan binding, private data approvals and licenses, raw receipts, close continuity, price basis, certified listed series, pre-order/fill coverage and settlement dates. A dated independently confirmed halt/no-book may resolve coverage and reject execution where needed. A missing or contradictory observation blocks a definitive comparison. The certificate identifies the raw input and normalized panel digests, and a synthetic data class always fails the readiness test. Evidence content and legal grant scope require human review even when their stored hashes match.
- [`ledger.ts`](scripts/phase-3/ledger.ts) provides standalone in-memory portfolio accounting with fixed risk reference and actual cash, exact legs, no replacement, staged order/quote review, display size, EV lock, fees, settlement availability and incomplete-run suppression. Later pre-order and fill evidence can only validate the already selected contract. A full Phase 4 comparator and analysis runner is outside this branch.

All instruments in the frozen calendar can reach their regular expiration before the common cutoff. This proves schedule feasibility. Actual complete settlement across all eight rules and all random seeds requires the validated close, corporate-action and contract evidence. A post-entry unforeseen adjustment or missing expiry close must block complete terminal return unless an authorized treatment and evidence are available.

## 7. Validation and actual costs

Phase 3 consulted public documentation, calculated calendars, exercised controlled mocks and rechecked the authorized Phase 1 archive. It made **0 Market Data, other quote-provider or OpenAI API requests**, incurred **$0**, and did not open or acquire the independent evaluation dataset. `validate` and `acquire-candles` both stopped on missing approval before an external call. No subscription, production app or live account data changed.

| Command | Result |
|---|---|
| `npm test` | 247 passed in 20 files, including 50 new Phase 3 tests. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with zero warnings. |
| `npm run build` | Next.js 16.4.6 production build passed. |
| `OPTIONS_TEST_PORT=3166 OPTIONS_TEST_PRODUCTION=true OPTIONS_TEST_CHROMIUM=/usr/bin/chromium npm run test:e2e -- --workers=1` | All 24 Chromium regressions passed. |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs manifest` and `... cost` | Both reproduced checked-in JSON bytes. |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-2-validate.mjs` | Reproduced the checked-in synthetic numerical artifact byte-for-byte. |

The first offline CLI smoke test found a TypeScript parameter property unsupported by Node's strip-only runner. The implementation now uses explicit class fields and both generated artifacts reproduce. The complete mock gate checked 3,156 of 3,156 closes and 156 of 156 panels, then returned `blocked` with `mock_data` as the sole issue. Final automated suites had no failures or skips. Authenticated providers and actual evaluation observations were outside the authorized tests. Phase 1 was reproduced offline and its comparison CSV matched byte-for-byte using Node 24.22.3.

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-1-replay.mjs \
  --cache work/phase-1-inputs/original \
  --candles work/phase-1-inputs/aapl-closes.json \
  --entry-dir work/phase-1-inputs/entry \
  --out work/phase-3-phase1-check
cmp phase_1_comparison.csv work/phase-3-phase1-check/phase_1_comparison.csv
```

## 8. What is required before Phase 4

1. Choose and approve **J+1 with a licensed intraday source** or **the proposed EOD J+2 amendment**. Confirm the approved provider, project-use rights, retention and exact dated cadence, and the maximum spend/credits. For J+2, commit the amended protocol, timing/adapter and costs before any holdout access. No approved alternative design is active in this branch.
2. Confirm Starter or an equivalent entitlement for the frozen dates. For J+1, obtain proof of the independently delivered pre-close and later close snapshots, including spot, exact timestamp and quote sizes, and check SPY/QQQ 16:00 handling. Obtain dated listed-series inventory and point-in-time corporate-action/settlement evidence. Set and approve the maximum credit and request bounds before testing provider access.
3. For the primary design, use Node 24.22.3 and the following offline planning commands from the repository root. Use the manifest hash reported by `fingerprints`, distinct from the byte hash of formatted JSON. The protocol and canonical request manifest hashes are included below.

   ```sh
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs fingerprints
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs manifest
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs cost
   ```

4. Only after approval, create a private `work/phase-3` directory with mode 0700 and files with mode 0600. The `approval.json` must satisfy [`command.ts`](scripts/phase-3/command.ts) and [`phase3ApprovalSchema`](scripts/phase-3/gates.ts). It binds `authorization` and the documented approval and provider licenses through SHA-256 evidence files, exact protocol/manifest hashes, roles, covered dates and retention. Add `acquisitionAndCostsApproved`, total `budget` (`maxRequests`, `maxCredits`, `maxUsd`), and the exact `candles` plan digest and stage caps. Keep the existing locally authorized `MARKETDATA_API_TOKEN` server-side in an ignored environment file. No raw evidence or credentials belong in Git. With approved and externally verified scope, run the first command, review its receipts, derive the chain digest offline, and record separate approval of that exact digest and caps under `chains` before running the third command.

   ```sh
   node --env-file=.env.local --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs acquire-candles
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs prepare-chains
   node --env-file=.env.local --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs acquire-chains
   ```

5. Add the documented licensed pre-close evidence, normalized action review and certified series inventory inputs to the private directory. Point `licensed-index.json` to files for `preClose`, `corporateActions`, and `inventories` with the provider, actual receipt times, evidence source URLs and symbol/date where applicable. Keep source documentation for every availability and outcome claim. Schemas and controlled input examples are in [`observations.ts`](scripts/phase-3/observations.ts), [`gates.ts`](scripts/phase-3/gates.ts) and the associated tests. Run the offline gate below. Stop on any block. Retain the `ready` certificate tied to the exact plan and dataset digest before authorizing the separate Phase 4 execution.

   ```sh
   umask 077
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs validate > work/phase-3/readiness.json
   ```

## 9. Version identifiers

| Item | Identifier |
|---|---|
| Dedicated branch | `phase-3-data-and-research-protocol` |
| Phase 2 base | `c7bda67c1b694a33f2fded16bf7451512206985e` |
| Frozen Phase 3 protocol | `2ff3fa43d72bbeb96bf7e60753ec9dcc3ce6c789` |
| Infrastructure, tests and planning artifacts | `363f13644c3ac36fc93e026e45a7d8fd293b7a20` |
| Canonical request manifest SHA-256 | `131ca4e9a6051e3736a2f624311d0f56752551d6a7e63de5b9b64ca2db4132de` |

`git log -1 --format='%H' -- PHASE_3_REPORT.md` identifies the final report commit. The branch remains separate from `main`.
