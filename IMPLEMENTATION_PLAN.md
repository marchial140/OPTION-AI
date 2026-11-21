# OPTIONS AI PRO implementation plan

| Order | Area | Verification |
| --- | --- | --- |
| 1 | Create the Next.js scaffold, shared contracts, database migrations, and a French design system | Install dependencies and establish repeatable checks |
| 2 | Build the workspace navigation and all ten application sections | Walk through desktop and narrow layouts and check keyboard navigation |
| 3 | Implement the four supported options strategies and portfolio risk restrictions | Match both debit-spread examples and the capital-risk rejection in the specification |
| 4 | Connect the Responses API with web search, validated citations, and usage accounting | Exercise successful, malformed, unsupported, delayed, and failed response paths with mocks |
| 5 | Persist scan progress, results, rejections, and source snapshots | Run a demo scan and recover saved history after a reload |
| 6 | Build watchlist, paper position, partial close, journal, and realized analytics workflows | Record hypothetical fills and reconcile remaining quantity, fees, and realized P&L |
| 7 | Ground research assistant responses in saved records | Ask about a worked opportunity and check that its values come from recorded inputs |
| 8 | Wire protected scheduling, idempotency, and limits | Exercise repeated triggers, holidays, and budget rejection |
| 9 | Run the project gates | Type check, lint, unit and mocked integration tests, Playwright flows, and production build |
| 10 | Review accessibility, terminology, errors, and empty states | Verify the no-opportunity result and visible source and demo labeling |

The [test guide](TESTING.md) describes executable checks. See [Known limitations](KNOWN_LIMITATIONS.md) for features that depend on credentials, data coverage, or deployment configuration.
