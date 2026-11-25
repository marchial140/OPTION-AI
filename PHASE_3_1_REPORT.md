# OPTIONS AI PRO — Phase 3.1 D+2 amendment and data readiness

November 25, 2026 · New York and Toronto time conventions · Provider prices in USD

## Decision and status

The D+2 implementation is complete for preflight and research preparation. Its tested decision inputs stop at D+1; the later D+2 quote tests an already locked order. No look-ahead was identified in these paths. Actual provider coverage, dissemination timestamps and rights remain unverified. **Phase 4 is blocked until the provider and license checks pass and the separately authorized data produce a `ready` certificate.** During this task, market-data API requests and charges were **zero**. The evaluation dataset remained unopened and the profitability study did not run.

| Item | Identifier |
|---|---|
| Branch | `phase-3-1-d-plus-2` |
| Completed Phase 3 base | `bb309c4124d1c1ce8421d03ce00eac0586ab3c4d` |
| Original frozen D+1 protocol | `2ff3fa43d72bbeb96bf7e60753ec9dcc3ce6c789` |
| Frozen D+2 amendment | **`1d946b027b97b325cf636eac7e446e6d52c5c294`** |
| D+2 acquisition, validation, ledger and tests | `26979404f15fb12bcb404b1a650e010a5912e67f` |
| Study request manifest logical SHA-256 | `5893b41da525eb17962ecfed4ecfb338bc92aa9848de9b1bb90f1e753b9a0cbd` |
| Separate technical scope manifest logical SHA-256 | `ec2c6d5111e46fe5b7465b7c9fcb9cf260ebd7ab5676f492368e8db13466ed87` |

The manifests are hashed from compact JSON by `fingerprints`. Their logical hashes differ from the byte hashes of formatted files. The candle request fingerprints and derived option request hash are separate approval keys. [Amended protocol](PHASE_3_PROTOCOL.md) · [Study request manifest](phase_3_data_manifest.json) · [Cost estimate](phase_3_cost_estimate.json)

## Frozen chronology and what changed

| Research event | Allowed observations and decision |
|---|---|
| D regular close | Observe the underlying close and dated option chain. Preserve archive receipt separately from market observation and modeled availability. |
| D+1 09:45 ET | Select a maximum of one strategy across the six titles with observations through D. The reconstructed historical chain availability is 09:31 on the next valid session. |
| D+2 09:45 ET | Revalidate the exact selected OCC legs using D+1 closing quotes and underlying close. The trailing history ends on D+1. C–F repeat their frozen economic checks using their own rules. Risk, executable displayed size, expiry and the cash checks apply. Lock the D+1 ask ceiling for the long leg and bid floor for the short leg. |
| D+2 regular close | Use the later observed option bid, ask and size only to test conditional execution at those preset limits. No re-ranking, change of contracts or economic revalidation uses D+2 closing values. Failures are rejections without replacements. |
| Expiration | Keep entered positions intact and settle against the official underlying expiry close under the original theoretical intrinsic model. Credit cash only when settlement is available. |

D+1 and D+2 are successive valid trading sessions. NYSE regular hours, holidays and DST are used. The stale Dec 31, 2024 closing snapshot is 41 h 45 min old at the Jan 2, 2025 order lock. The original 36-hour guard rejects that selection in every active rule and seed. The anchor and its six panels stay in the study. Noncash configurations take the same timing and cost assumptions. H has no orders. The added session can also take a previously admissible short-dated contract below the existing risk engine's calendar-DTE window before entry; it is rejected without replacement.

The original six symbols, the 26 scheduled signals, the 252-completed-return models, both distributions and nine stresses, the eight rules A–H, primary configuration D, 20 random seeds, $10,000 reference and initial capital, $500 per trade, $2,000 aggregate risk, eight positions, one selection per date, $1.30 fees and statistical procedure are preserved. The first signal/revalidation/fill sessions are Oct 21/22/23, 2024, and the last are Oct 6/7/8, 2025. Each title requires **526 closing observations** from Oct 19, 2023 through Nov 21, 2025. The 156 symbol-date panels all leave legal expiry dates before the common cutoff; Nov 5, 2025 is the latest potentially eligible expiry. Complete actual settlement still requires verified official closes and any applicable corporate-action evidence.

Displayed historical quotes and sizes do not guarantee fills or simultaneous leg execution. The data gate treats independently certified no-book or halt evidence as a known rejection and flags genuinely missing, contradicted or unavailable input as incomplete. Exact 16:00 equity-close snapshots are required on regular days; a 16:15 ETF observation does not substitute. Unscheduled corrections and false provider availability claims cannot be resolved from code alone. [Market Data freshness](https://www.marketdata.app/docs/account/data-freshness/) · [Cboe options hours](https://www.cboe.com/about/hours/us-options/) · [OCC ETF terms](https://www.theocc.com/clearance-and-settlement/clearing/etf-options)

## Acquisition size and price

| Scope | Candle requests | D / D+1 / D+2 chains | Total base requests | Estimated credits | Reserved ceiling |
|---|---:|---:|---:|---:|---:|
| Study | 6 | 156 / 156 / 156 | **474** | **474–1,566** | **2,346** |
| Optional outside-holdout coverage check | 6 | 6 / 6 / 6 | **24** | 24–66 | **96** |

Each study symbol has 26 chain requests per stage and one candles request. Estimate 79–313 credits per ETF and 79–235 per equity, reserving 391 per symbol at the 4,001-row sentinel. These reservations are budget bounds before approved repairs or subdivisions. Historical option endpoints bill by blocks of 1,000 returned symbols, as do historical candles for returned bars. Sample size, actual credit receipts, splits/listings evidence costs, tax, and optional licensing charges remain to be verified. The study plus the separate coverage check would reserve up to 2,442 credits under these plans. [Historical chain pricing](https://www.marketdata.app/docs/api/options/chain/#pricing) · [Candle pricing](https://www.marketdata.app/docs/api/stocks/candles/#pricing) · [Rate limits and reset](https://www.marketdata.app/docs/api/rate-limiting/)

**One month of Starter may be sufficient for the Market Data requests only.** Public documentation lists **$30/month before taxes**, five years of history and **10,000 daily credits**. Both the study depth and the reserved credit counts fit the published limits. The account's actual entitlement was not checked here. One month cannot yet be treated as the all-in acquisition or licensing budget. Additional terms, dated OCC series or action evidence, or a different authorized quote source could be needed. [Starter](https://www.marketdata.app/docs/account/plans/starter/) · [Historical entitlement errors](https://www.marketdata.app/docs/api/troubleshooting/payment-required/)

## What the provider still needs to confirm

| Verified in published docs | Still requires written confirmation or authorized evidence |
|---|---|
| Historical `date` chain endpoint, regular-market snapshot semantics, `bid`, `ask`, `bidSize`, `askSize`, `updated`, and `nonstandard=false`. | Dated coverage for all six named symbols, non-null and correctly defined size at the matching snapshot, exact SPY/QQQ 16:00 and early-equity-close timestamp coverage. The schema alone does not establish these for the requested period. |
| Five-year Starter lookback and raw candle query with **both** `adjustsplits=false` and `adjustdividends=false`. | Complete consecutive coverage, values on the as-traded basis, dated split/dividend announcements and effective times, and the correct official expiry close. |
| Dated option expiration metadata plus OCC symbols and downloadable standard chains. | Independent complete listed-series inventory, no-book/halting evidence where rows are missing, and adjusted deliverable terms. Expiration dates alone do not prove contract-level coverage. |
| Private retention restrictions in personal terms and deletion obligations for paid/trial raw values after paid status ends, including copies and backups. The normal backup rotation exception does not permit restoring or using expired licensed data. | Whether this single-developer study for a product under development qualifies for the desired private plan, the allowed hardware/hosting, and which exchange agreements govern keeping or sharing the exact non-reconstructible aggregates after deletion of raw data. |

[Chain schema and point-in-time semantics](https://www.marketdata.app/docs/api/options/chain/#point-in-time-semantics) · [Candle adjustments](https://www.marketdata.app/docs/api/stocks/candles/#split-and-dividend-adjustments) · [Expiration metadata](https://www.marketdata.app/docs/api/options/expirations/) · [OCC action evidence](https://infomemo.theocc.com/infomemo/search) · [Provider terms](https://www.marketdata.app/terms/) · [Professional classification](https://www.marketdata.app/docs/account/data-policies/professional-status/)

For future BYOK, Market Data's guide describes local experimentation with the developer's own key and an architecture where each user has their own account and the credential, data retrieval, calculation and storage stay on that user's device. Confirm the guide's application to OPTIONS AI PRO and the account classification with the provider. Centralized proxy, central credential custody, shared caches and serving users' quote results would require a separate rights assessment. BYOK does not activate this study's license. No BYOK feature was implemented. [BYOK guide](https://www.marketdata.app/education/licensing/bring-your-own-key/) · [Public-use conditions](https://www.marketdata.app/terms/public-use/)

### Draft for Market Data support (unsent)

> Hello, could you confirm whether one month of Starter covers a private, single-developer historical study for OPTIONS AI PRO, a product under development? We need SPY, QQQ, MSFT, NVDA, AMD and SOFI historical option chains for October 21, 2024 through October 8, 2025, and as-traded daily closes from October 19, 2023 through November 21, 2025. Do dated SPY/QQQ chains provide the 16:00 ET equity-close observation, including on early closes, with bid, ask and both displayed sizes from the same timestamp? Is there a source for full dated OCC listings, absent books and corporate actions/deliverables? Please confirm the account classification, permitted private development and storage, deletion duties after cancellation, and whether non-reconstructible aggregate results may be retained or published under the applicable exchange agreements. Please also indicate any fees or licenses beyond the advertised $30 monthly plan.

## Exact steps before Phase 4

1. **Verify account status in the Market Data Dashboard and get written scope confirmation.** Check **Membership/Billing** for tier, billing cycle, credit balance and reset, and **Profile/Entitlements** for classification and feeds. Verify the five-year, 16:00 ETF, size, coverage and rights questions above. The authenticated `/user/` endpoint documented by Market Data can show certain entitlements and quota headers; this phase uses no account API because its charge and exact study coverage were not verified. Approve the subscription budget, if any, and the designated tests in writing. [User endpoint](https://www.marketdata.app/docs/sdk/go/utilities/user/) · [Freshness](https://www.marketdata.app/docs/account/data-freshness/)
2. **Create a single private local store per scope.** Use Node 24.22.3. From the repository root, generate the offline fingerprints. The default directories are `work/phase-3-1-coverage` and `work/phase-3-1-study`. They require mode `0700`, inputs `0600`. Store the local API key in the ignored `.env.local` as `MARKETDATA_API_TOKEN`. No credentials or observations belong in a Git file.

   ```sh
   umask 077
   mkdir -p work/phase-3-1-coverage work/phase-3-1-study
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs fingerprints --scope coverage
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs fingerprints --scope study
   ```

   In each approved directory, create `approval.json` with `authorization`, `acquisitionAndCostsApproved: true`, `budget` (`maxRequests`, `maxCredits`, `maxUsd`), `candles` (`planSha256`, `maxRequests`, `maxCredits`) and `evidenceFiles` pointing to the actual private written approval/licensing documents. The inner authorization binds protocol and request-manifest hashes, the timeline `two-session-eod-locked-limit`, private use, date range, roles, grant retention times and the SHA-256 of the authorization and each provider evidence file. Use the `verify-entitlements` command below to check that documentary proof. It cannot establish a signed-in account or interpret the license for you. Study roles include `candles`, `signal`, `revalidation`, `fill`, `series`, and `corporate-actions`. A plan for the technical scope can never authorize the study scope. [Approval schemas](scripts/phase-3/command.ts) · [Readiness gates](scripts/phase-3/gates.ts)
3. **Run only the approved scope.** For `coverage`, use the fixed outside-holdout dates **October 5, 6 and 7, 2026** on all six titles. Its separate cap is 24 requests and 96 reserved credits. Check clocks, observed sizes, exact OCC matches, errors and receipts only. There is no selection, economic check, P&L, or study-ready certificate. On each scope, authorize candles first, derive an exact private `options-request-plan.json`, then record the printed option digest and caps in `approval.json` under `chains` before acquiring options. The unchanged study request plan requires its own approval after the technical check and license confirmation. Replace `coverage` with `study` only for this separately authorized stage.

   ```sh
   scope=coverage
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs verify-entitlements --scope "$scope"
   node --env-file=.env.local --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs acquire-candles --scope "$scope"
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs prepare-chains --scope "$scope"
   # Verify the exact digest and obtain that acquisition approval before continuing.
   node --env-file=.env.local --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs acquire-chains --scope "$scope"
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs validate --scope "$scope"
   ```

4. **Validate the whole study.** In its private directory add `licensed-index.json` with `corporateActions` and `inventories` pointing to the approved source evidence and actual receipts. The Phase 3.1 study path loads pre-order observations from the D+1 Market Data chain and underlying candle. It uses no licensed intraday packet. Proof must justify exact market observation times. Follow the normalization and inventory schemas. Save the offline certificate and stop on any nonzero exit or a blocked outcome.

   ```sh
   umask 077
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs validate --scope study > work/phase-3-1-study/readiness.json
   ```

5. **Authorize Phase 4 separately** with the certificate's exact protocol commit, request manifest hash, option plan hash and dataset digest. That task will implement and run the comparative simulation over the eight frozen configurations, verify every actual expiration settlement, and report only the permitted outputs. The current branch provides acquisition, validation and the ledger. It has no command that runs the profitability study.

## Verification

Node and project regressions were run locally. Final test counts and commands are recorded below. All new observation and portfolio tests used synthetic fixtures only. Public documentation was read without authenticating to a provider, buying a subscription, contacting support, or retrieving market evaluation data.

| Command | Result |
|---|---|
| `npm test` | 263 passed in 20 files. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with zero warnings. |
| `npm run build` | Next.js 16.4.6 production build passed. |
| `OPTIONS_TEST_PORT=3168 OPTIONS_TEST_PRODUCTION=true OPTIONS_TEST_CHROMIUM=/usr/bin/chromium npm run test:e2e -- --workers=1` | All 24 regressions passed on Chromium 156. |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-3-data.mjs manifest` and `... cost` | Checked-in JSON reproduced byte-for-byte. |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-2-validate.mjs` | Checked-in numerical artifact reproduced byte-for-byte. |

The Phase 1 AAPL comparison was checked offline against the preexisting authorized archive using the exact command below. It is a regression and remains outside the independent sample.

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/phase-1-replay.mjs \
  --cache work/phase-1-inputs/original \
  --candles work/phase-1-inputs/aapl-closes.json \
  --entry-dir work/phase-1-inputs/entry \
  --out work/phase-3-1-phase1-check
cmp phase_1_comparison.csv work/phase-3-1-phase1-check/phase_1_comparison.csv
```

Tests cover missing and delayed quotes, wrong session/availability, forecast leakage, expired contracts, stale holiday data, lock/fill size, locked price floors and ceilings, valid independently evidenced no-book, risk caps, settlement, budget and manifest separation. The full synthetic data test validated the 156 panel structures and 3,156 closing rows, counted six holiday stale panels, and withheld readiness because the inputs were synthetic. The offline `verify-entitlements` study smoke and `acquire-candles` coverage smoke intentionally exited with missing-approval errors, before any request. No production app paths were changed. `git log -1 --format='%H' -- PHASE_3_1_REPORT.md` identifies the consolidated report commit. No deployment or merge into `main`.
