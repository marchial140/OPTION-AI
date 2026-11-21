# OPTIONS AI PRO

A French-first options research workspace for US-listed equities and ETFs. It connects market research, quote provenance, deterministic strategy analysis, and a paper portfolio. It supports long calls, long puts, bull call debit spreads, and bear put debit spreads.

## Run the demo

Use Node.js 22 or later and npm. Install dependencies and start the development server from the project directory.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. Without Supabase configuration, the app starts in demo mode and displays **DEMO — DONNÉES FICTIVES**. The demo uses persistent local data and needs no API key. The first universe is NVDA, AMD, SOFI, TSLA, SPY, and QQQ.

Try a scan in **Scanner de marché**, open an opportunity to inspect the source and payoff, and compare the result in **Laboratoire de stratégies**. The paper portfolio records hypothetical fills and calculates realized P&L when you record full or partial exits.

## Configure live research

1. Copy `.env.example` to `.env.local`.
2. Create a Supabase project, enable email/password authentication, and apply the SQL migrations through the Supabase CLI or SQL Editor.
3. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
4. Supply `OPENAI_API_KEY` and set `OPENAI_MODEL` to a model that supports Responses API structured output and web search for your project.
5. Configure model and web search prices for budget estimates. Configure `APP_BASE_URL` for your site address and `CRON_SECRET` if you use automatic scans.
6. Set `DEMO_MODE=false` to require an authenticated live session. Restart the development server and create or sign in to an account.

Follow [Deployment](DEPLOYMENT.md) for the migration, email confirmation, scheduler, and hosting setup. [API integration](API_INTEGRATION.md) describes the research provider and endpoint conventions.

| Environment variable or group | Use |
| --- | --- |
| `APP_BASE_URL` | The origin used for auth redirects and same-origin validation |
| `DEMO_MODE` | Set `true` to default unauthenticated visitors to demo or `false` to require live authentication |
| `OPTIONS_DATA_DIR` | Optional directory for local demo state |
| `DEMO_STORAGE`, `DEMO_SESSION_SECRET` | Hosted demo persistence and signed session identity |
| `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase connection, user authentication, and privileged server writes |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_DEEP_MODEL` | Server Responses API access and model selection |
| `AI_*_USD_*` and `AI_*_BUDGET_USD` | Usage rate estimates and budget ceilings |
| `MAX_AI_REQUESTS_PER_SCAN`, `AI_MAX_CALLS_PER_TICKER`, `AI_MAX_RETRIES`, `AI_RESEARCH_TIMEOUT_MS` | Research request bounds |
| `CRON_SECRET` | Bearer authorization for the protected scheduler |

## Project commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run typecheck` | Check strict TypeScript types |
| `npm run lint` | Run ESLint |
| `npm test` | Run unit and mocked integration tests |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run build` | Build the production app |
| `npm run start` | Serve the production build |

## Financial assumptions

Paper accounting uses USD. Verified inputs must include a traceable origin and relevant timestamps. Web research can identify underlying setups even when a complete options chain or reliable bid and ask are unavailable. The scanner can therefore finish successfully with zero qualifying opportunities.

Quote-based debit calculations use the ask for the purchased leg and the bid for the sold leg. The strategy lab can use explicitly entered assumptions. A payoff describes a hypothetical expiry outcome. Paper P&L uses recorded fills. A research score is an eligibility and ranking metric. See [Risk engine](RISK_ENGINE.md), [Data provenance](DATA_PROVENANCE.md), and [Known limitations](KNOWN_LIMITATIONS.md).

## Privacy

Use **Paramètres → Données et confidentialité** to export or reset saved workspace data. A reset clears the workspace's research, quote, watchlist, paper, and preference records. Usage records for the current UTC calendar month are retained to maintain the configured API budget. Manage the live authentication account in Supabase.

## Project structure

```text
src/app/           Pages, layout, and server routes
src/components/    Research workspace and browser interactions
src/lib/           Data contracts, demo fixtures, and financial calculations
src/lib/server/    Auth, state, research, and market calendar
supabase/          PostgreSQL migrations and row ownership policies
tests/             Financial, service, and browser checks
```

Additional documentation covers [architecture](ARCHITECTURE.md), [implementation phases](IMPLEMENTATION_PLAN.md), and [testing](TESTING.md).
