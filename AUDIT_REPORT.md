# OPTIONS AI PRO production-readiness audit

November 21, 2026 · Toronto

## Release assessment

The audit exercised the existing application, reproduced defects, and added regression coverage. Demo research, payoff calculations, user-attested broker quotes, and paper portfolio accounting are suitable for continued testing. A live launch still requires a credentialed OpenAI web-search smoke test and verification against the target Supabase project. Live options-chain verification and point-in-time backtesting require a market-data provider.

## Findings and fixes

| Area | Reproduced behavior | Correction and regression coverage |
| --- | --- | --- |
| Quote eligibility | A vertical could combine option legs hours apart. Equivalent ISO timestamps with different offsets could evade duplicate detection. Expiration checks used a calendar day instead of the New York session close. | Require compatible provenance and a maximum five-minute observation gap. Detect conflicts by instant. Validate OCC identity, standard multiplier, permitted dates, and modeled regular or early close. Unit cases cover mixed sources, conflicting timestamps, holidays, and DST. |
| Quote provenance | A broker attestation was displayed as a verified delayed quote. Older quotes could replace newer ones. Withdrawing an attestation could leave a strategy in the current view. | Classify attested observations as `MANUAL_ATTESTED`. Reject older or contradictory replacements. Check the active quote registry and current risk before publishing and presenting opportunities. Retain archived snapshots with their recorded provenance. Tests cover replacements, withdrawals, and demo isolation. |
| Payoff and paper risk | Extreme spread inputs could lose the bounded payoff through decimal cancellation. Invalid closures could reach accounting, and negative net credits were rejected even for a debit-to-close spread. | Calculate bounded vertical payoff directly. Enforce loss limits and fees, exit chronology, and whole quantities. Support signed spread exits in the application and the database, while long-only exits require nonnegative credits. Reconcile partial exits to the cent and test large spot-price inputs. |
| Retry safety | Reusing a request key with changed inputs could silently return a previous transaction. Retrying after a lost response could generate a different timestamp. | Compare the original transaction on replay and return HTTP 409 on conflicting reuse. Preserve the originally submitted payload on an unchanged paper retry. Add service and browser regressions. |
| Realized analytics | Browser time-zone offsets could misorder exits or shift them to the wrong daily or monthly bucket. | Sort by chronological instant and group realized P&L by UTC day and month. Preserve partial exits in the ledger. Clarify the sample origin and scope of displayed measures. |
| OpenAI output and citations | Intermediate text could be parsed as a final response. Model-supplied metadata and free-form answers could give unsupported claims the appearance of sourced results. | Parse completed final structured messages. Restrict web searches and require recognized, traceable citations. Withhold unsupported numeric quotes and publication timestamps. For live chat, select from authorized stored evidence and render the selected passages server-side. Archived research is explicit. Wire tests exercise the official SDK with a stubbed HTTPS transport. |
| Research spending | Expired or released reservations could free capacity even when provider billing was unknown. Changed scan caps and expired leases could leave obsolete spending authorization in effect. | Keep potentially billable reservations in the workspace budget until reconciled. Track observed usage separately. Reconcile late responses once, check active leases and current caps, and fail closed on malformed deployment limits. Tests cover concurrent reservations, expired leases, and late accounting. |
| Scan execution | A browser disconnect could turn an unfinished ticker into a permanent failure. The schedule could change between its initial read and queue creation. | Release the interrupted lease for resumption and check the schedule again inside the atomic update. Recheck affordability and quote availability when publishing. |
| Authorization and storage | Normal live reads used the service role. A refresh-only logout could leave a session valid. A corrupt local workspace could stop other scheduled demo jobs. | Use the signed-in access token for reads so database row-level security applies. Harden secure cookies and revoke refresh-only sessions. Recover abandoned local locks and isolate corrupt workspaces. Verify changes against local PostgreSQL, GoTrue, and PostgREST. Validate browser origins against the request or configured application origin and require the exact JSON media type for JSON mutations. |
| Visible controls | Whole-list writes could drop independent watchlist changes. Stale comparison selections could consume slots. Menu and dialog focus could be lost. Calendar-day defaults could select an unlisted date. | Use atomic list and symbol mutations, validate comparisons, restore keyboard focus, and choose valid default paper expirations. Improve loading, archived result, source, and budget status feedback. Browser regressions exercise these behaviors. |

## Verification

- Baseline before fixes: 56 Vitest tests and 13 production Chromium tests passed.
- Local database: all four migrations passed on PostgreSQL 17. Checks included revision conflicts, per-owner access, denied unauthenticated writes, persisted projections, and signed paper exits.
- Local auth and storage: GoTrue v2.198 and PostgREST v16.5 passed account creation, password login, access-token identity, durable reads and writes, scheduler lookup, cross-user row isolation, and refresh-only logout. Local fixtures used automatic email confirmation.
- The production build, strict TypeScript, ESLint, and all 89 Vitest cases passed on Node.js 24.22.3.
- All 23 Playwright Chromium cases passed against the final production build. The suite exercised all ten routes, scan cancellation and history, source diagnostics, desktop and mobile navigation, keyboard focus, comparisons, watchlists across tabs, paper retries and exits, analytics, and demo/live labels. The live-mode display fixture supplied controlled data.
- The npm advisory scan found zero known vulnerabilities in the installed dependency graph.

## Remaining limitations

- This workspace had no configured OpenAI credentials. SDK request shape, parsing, source handling, usage accounting, and errors were exercised with controlled responses. Run a small billable scan in the intended OpenAI project to confirm model access, web-search availability, model pricing, quota, and real response shape.
- The local database and authentication checks used disposable services. Hosted sign-in, email delivery, the deployed scheduler, production traffic behavior, and secret configuration need verification in the target environment. Existing hosted browser sessions may need a fresh sign-in after the HTTPS cookie names change.
- Market context from web research cannot independently validate live options prices or a complete option chain. Broker-attested figures are indicative. The session model uses standard New York hours and modeled holidays and early closes. Exchange-specific extended hours, unscheduled closures, and nonstandard contracts need an authoritative feed.
- Realized P&L comes from recorded paper executions and fees. The application has no broker order routing or historical options backtest. The demo's seeded observations and fills are synthetic.
- Spend estimates apply per workspace. Exact provider billing and a shared project's aggregate limit depend on provider controls. Long-term multi-tenant load and large history retention were outside this run.
- Browser automation covers critical journeys and regression cases. Chromium was exercised at desktop and mobile widths, with separate layout probes at 320 px and 1024 px. WebKit installation completed, but its executable could not launch because the host lacks required system libraries. Native Safari remains unverified.

## Run the audited application

Use Node.js 22 or later. Run these commands from the directory containing this report.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000/` in a browser on the same machine. With an unconfigured checkout the default is the credential-free demo. Launch a scan from **Scanner de marché**, open a result in **Laboratoire**, and record and close a paper position in **Portefeuille papier**.

To run the production build and repeat the checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
OPTIONS_TEST_PRODUCTION=true npm run test:e2e -- --workers=1
npm run start
```

On Linux, use `OPTIONS_TEST_CHROMIUM=/usr/bin/chromium` to select an installed system Chromium. The test runner starts and stops its own isolated demo server.

For live service setup, copy `.env.example` to `.env.local`. Set the Supabase URL, publishable or anon key, and server-only service-role key. Set `OPENAI_API_KEY`, `OPENAI_MODEL`, and the listed token and web search rates. Use `DEMO_MODE=false` to require authenticated live sessions and set `APP_BASE_URL` to your public HTTPS origin for deployment. Apply all migrations with the Supabase CLI.

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
npm run build
npm run start
```

Check `/api/health`, sign in with a test account, run a one-ticker scan, and examine the citations, data status, and usage ledger. Configure `CRON_SECRET` and the authenticated scheduler when testing automatic work. See `DEPLOYMENT.md`, `API_INTEGRATION.md`, and `DATA_PROVENANCE.md`.

## Scanner ranking and request-size check, November 24, 2026

Two public AAPL option snapshots were replayed through the current market-data validation and strategy engine at their original US market close. The replay used a neutral direction assumption and the default USD 500 per-trade risk cap on USD 10,000 capital. The resulting order and calculations matched when rows were reversed and when calls and puts were reordered. Every retained result stayed within the configured loss limit.

| Session | Valid contracts | Expirations | Retained | Calls / puts / call spreads / put spreads |
| --- | ---: | ---: | ---: | --- |
| 2020-01-06 | 158 | 1 | 60 | 1 / 10 / 11 / 38 |
| 2026-11-20 | 144 | 6 | 60 | 6 / 8 / 17 / 29 |

The old 48-row API query returned 48 calls and no puts in a single-expiration AAPL sample. The new near-the-money filter and 256-row limit returned 72 calls and 72 puts in the 7–30 DTE sample. Market data came from the [2020 historical chain](https://api.marketdata.app/v1/options/chain/AAPL/?date=2020-01-06) and [2026 historical chain](https://api.marketdata.app/v1/options/chain/AAPL/?date=2026-11-20&dte=7-30&nonstandard=false&dateformat=unix&strikeLimit=12&limit=256). This checked deterministic ranking and risk calculations. It did not measure fills, investment outcomes, or predictive performance.

With the SDK transport intercepted locally, the serialized quick screening request shrank from 6,098 to 3,202 bytes. Deep screening went from 6,103 to 3,207 bytes and contract discovery from 3,528 to 2,414 bytes. These are HTTP payload measurements. Live provider token usage and billing require an authorized live scan.
