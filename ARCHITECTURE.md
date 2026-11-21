# OPTIONS AI PRO architecture

The application uses the Next.js App Router for the French interface and server endpoints. The browser renders research and manages user interactions. Server modules own identity, persisted state, scan orchestration, and access to OpenAI. The calculation engine is a pure TypeScript dependency shared by the strategy workspace and server validation.

## Boundaries

| Layer | Responsibility |
| --- | --- |
| `src/app` | Pages, application layout, and HTTP endpoints |
| `src/components` | Trading workspace, scanner controls, sources, payoff charts, portfolio, and settings |
| `src/lib/quant.ts` | Decimal-safe calculations, compatibility checks, risk rules, and deterministic scoring |
| `src/lib/server` | Authentication, state persistence, OpenAI research, market hours, and scan execution |
| `supabase/migrations` | PostgreSQL schema, ownership policies, and server persistence functions |
| `tests` | Calculation, source validation, persistence, and workflow checks |

## Research flow

1. An authenticated request creates a scan with configuration, ticker priority, and a unique identifier.
2. Bounded per-ticker work gathers supporting evidence and records availability, failure reasons, and usage.
3. Source validation checks timestamps and citation provenance. An asset can remain a research candidate when contract verification yields no usable data.
4. The quantitative engine constructs eligible long options or debit spreads from compatible quotes, applies risk restrictions, and ranks supported metrics.
5. The scan stores its original evidence, results, and rejections. Later scans append separate research records.

## Storage and trust

Demo uses synthetic fixtures and separate persistent state. Live research consumes external evidence and uses authenticated user-owned storage. The two data modes carry explicit provenance across scans, opportunities, and the user interface. Local demo state uses serialized file writes and atomic replacement. Live state uses a per-owner snapshot and revision checks in PostgreSQL to detect concurrent writes.

The canonical workspace revision tracks settings, jobs, and active state. The PostgreSQL write transaction also projects user records into normalized tables for watchlists, scan assets, sources, observations, contracts, quotes, opportunities, paper trades, usage, and notifications. Row policies scope live records to their owners. Browser requests resolve identity before server-side writes use the service role.

External research pages enter the system as untrusted data. The research model has a limited tool surface. Structured output validation governs the application boundary before any records are saved or passed to the numeric engine. The OpenAI key and privileged database credentials belong to the server environment.

## Deployment boundary

The application can run locally with the included demo data. An authenticated deployment connects to Supabase and OpenAI and uses a protected scheduler endpoint when available. Review [Deployment](DEPLOYMENT.md) for installation and configuration.
