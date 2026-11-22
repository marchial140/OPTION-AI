# Testing OPTIONS AI PRO

Run each check from the project directory.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run build
OPTIONS_TEST_PRODUCTION=true npm run test:e2e
```

Playwright may need system browser dependencies on a fresh Linux machine. Use `npx playwright install --with-deps chromium` on a development or CI machine where you can install packages.

Set `OPTIONS_TEST_CHROMIUM` to an installed Chromium executable if you need to use a system browser. Playwright starts a dedicated demo server on port 3142 and writes isolated state under `work/e2e-state-3142`. Set `OPTIONS_TEST_PORT` to use another port. By default the suite uses the development server. Set `OPTIONS_TEST_PRODUCTION=true` after building to exercise the production server.

## Coverage targets

| Area | Coverage |
| --- | --- |
| Calculation engine | Long call, long put, both debit spreads, fees, quantity, compatibility, and loss limits |
| Research service | Structured output, supported citations, unavailable evidence, mocked service failure, and bounded usage |
| Workspace | Scan launch and completion, saved settings, opportunity inspection, paper fills and exits, and realized performance |
| API regressions | Isolated demo sessions, concurrent idempotent scan creation, scan ownership, cross-origin write rejection, protected scheduler access, the $450 account risk example, and cent-level reconciliation across partial exits |
| Production build | Type-safe App Router compilation and local startup |

## Recorded local checks

- `npm test` passed 89 tests. The production Next.js build, TypeScript, and ESLint passed.
- Chromium Playwright passed 23 tests against the final production build.
- The npm dependency audit found zero known vulnerabilities.
- All four migrations passed on local PostgreSQL 17. Local GoTrue and PostgREST checks exercised authentication, application storage, owner isolation, and revocation.
- See [Production-readiness audit](AUDIT_REPORT.md) for the fixes and verification boundaries.

The retained database regression is `supabase/tests/workspace_rls.sql`. With the Supabase CLI and Docker, start a local Supabase stack with `supabase start`, then run `supabase test db`. That CLI path requires the local service stack and remains to be exercised here.

## Local walkthrough

1. Start the app with `npm run dev` and open `http://localhost:3000`.
2. Confirm the demo label and open the scanner. Run a demo scan and wait for its recorded ticker progress and result.
3. Inspect an opportunity and check each leg, source, timestamp, hypothetical payoff, and score explanation.
4. In the strategy lab, change the hypothetical underlying price and verify the scenario against the worked examples in [Risk engine](RISK_ENGINE.md).
5. Record an opening paper fill, close part of the quantity, and check the realized P&L and remaining exposure. Complete the exit and inspect performance analytics.
6. Reload and check that saved state persists. Repeat navigation at a narrow viewport and use the keyboard to open controls.

## Live verification

Use a separate test Supabase project and an OpenAI key with a controlled budget. Apply the migrations, sign in as two distinct users, create a scan for one user, and verify that access by the second user is rejected. Run one low-volume live scan and inspect the reported sources, empty-quote behavior, and usage. Test scheduling with a known due schedule and repeat its invocation to check deduplication. See [Deployment](DEPLOYMENT.md).

Local demo and mocked integration tests verify application behavior under controlled inputs. Successful live integration requires service credentials and upstream availability.
