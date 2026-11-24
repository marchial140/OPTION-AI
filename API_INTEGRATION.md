# API integration

The Next.js route handlers consume JSON and resolve identity on the server. For live use, sign in with a Supabase email/password account. The browser receives an HTTP-only session cookie. Mutating calls from the browser use the application origin. Behind a reverse proxy, configure the public origin in `APP_BASE_URL`.

Error responses provide `error.code`, `error.message`, and `error.requestId`. Validation errors can include `error.fields`. The response `X-Request-Id` header supports tracing a failed request.

## Application endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Inspect service configuration and research availability |
| `GET /api/state` | Load the current user's workspace |
| `POST /api/auth` | Authenticate with `action`, `email`, and `password`. `action` accepts `login` or `signup` |
| `POST /api/auth/demo` | Enter a separate demo session when demo access is enabled |
| `POST /api/auth/signout` | Clear the active session |
| `GET /api/scans` | Retrieve saved scan history |
| `POST /api/scans` | Queue a quick, deep, or custom scan |
| `GET /api/scans/:id` | Retrieve the scan record and saved results |
| `GET /api/scans/:id/status` | Retrieve current scan progress |
| `POST /api/scans/:id/advance` | Advance bounded work for a queued or running scan |
| `POST /api/scans/:id/cancel` | Cancel an active scan |
| `GET /api/scans/:id/export` or `DELETE /api/scans/:id` | Export or delete a saved scan |
| `GET /api/opportunities` or `GET /api/opportunities/:id` | Retrieve opportunities or inspect a specific record |
| `GET /api/watchlists` or `PUT /api/watchlists` | Read or replace watchlists |
| `POST /api/watchlists/list` or `DELETE /api/watchlists/:id` | Create or remove one watchlist |
| `POST /api/watchlists/items` or `DELETE /api/watchlists/:id/items/:symbol` | Add or remove one symbol without replacing the collection |
| `POST /api/strategies/calculate` | Calculate a strategy from supplied contracts and assumptions |
| `POST /api/ai/chat` or `POST /api/ai/research` | Ask the research assistant about the current user's saved evidence |
| `GET /api/quotes`, `POST /api/quotes`, or `DELETE /api/quotes/:id` | List, submit, or remove user-attested broker quotes |
| `GET /api/portfolio` or `POST /api/portfolio/trades` | Retrieve paper positions or record an opening fill |
| `PATCH /api/portfolio/trades/:id` | Record a full or partial paper exit |
| `GET /api/analytics` | Retrieve calculations from saved paper exits |
| `GET /api/settings` or `PATCH /api/settings` | Read or update workspace preferences |
| `POST /api/notifications/read` | Mark in-app notifications read |
| `GET /api/data` or `DELETE /api/data` | Export or reset the current workspace |
| `GET /api/cron` or `POST /api/cron` | Check due schedules and advance pending scan work with `Authorization: Bearer <CRON_SECRET>` |

The reset endpoint retains the current UTC calendar month's AI usage records for budget enforcement. It rejects a reset while research is active.

A scan request can supply symbols directly or select a saved watchlist. Supply an `Idempotency-Key` and the same request body when retrying a scan, paper opening, or paper exit. Reusing a key with a different transaction returns HTTP 409. This body creates a targeted scan for two assets.

```json
{
  "type": "quick",
  "tickers": ["NVDA", "QQQ"]
}
```

## Responses API

The server uses the official JavaScript SDK and a configured model. Research requests combine built-in `web_search`, a bounded tool-call budget, and a JSON schema in the instructions. Responses pass strict runtime validation before the application can save them. The evidence parser accepts sources whose HTTPS URLs and source category are corroborated by OpenAI search output or citation annotations. Financial quote assertions require evidence independent of model text.

External pages are research inputs. The request instructions tell the model to ignore commands in those inputs. The tool surface is limited to search during research and the model never receives database or shell access. See [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) and [web search](https://platform.openai.com/docs/guides/tools-web-search).

Scan requests ask OpenAI for the search tool's source list, which can supply evidence even when the message has no citation annotations. When a completed Web response has recognized sources but unreadable JSON, the server can make one structured reformatting request without Web search. It counts against the same request, cost, and timeout limits, and can add model token charges. Evidence is still checked against the original Web response. The scan report indicates whether missing sources, ambiguous JSON, a request limit, or an unsuccessful reformatting step prevented recovery.

The parser removes trailing commas outside JSON strings locally. If reformatting is still required and blocked, the report preserves the recognized sources from the completed search. A rate limit during reformatting does not trigger another reformatting request. When OpenAI supplies a retry delay, the error can show that delay.

Screening discards malformed optional qualitative observations individually. Remaining observations still require attributable sources, and the underlying quote, ticker, and direction are validated separately.

When a Web answer contains multiple JSON objects, the scanner validates complete objects against the requested symbol and schema. Equivalent objects count as one result. An existing result can fill empty fields in other results without changing populated fields. If no result preserves every populated field, the scan report records the conflict and any recognized sources from the original response. This selection does not make an extra API request.

### Configuration and estimated costs

Set `OPENAI_MODEL` to a model with web search and structured output enabled for the project. Configure `AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION`, and `AI_SEARCH_USD_PER_CALL` for the configured model and tool. A separate `OPENAI_DEEP_MODEL` requires `AI_DEEP_INPUT_USD_PER_MILLION` and `AI_DEEP_OUTPUT_USD_PER_MILLION`. Use rates applicable to your account and model. See [OpenAI API pricing](https://openai.com/api/pricing/).

Usage-based estimates use input tokens, output tokens, and search calls observed in responses. They may differ from billed amounts. `AI_RESEARCH_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_MAX_CALLS_PER_TICKER`, and `MAX_AI_REQUESTS_PER_SCAN` configure operational bounds. Daily and monthly budget periods follow UTC and apply to each authenticated workspace. In-flight reservations and potentially billable attempts without reconciliation count against the workspace budget. Reported estimates, pending reservations, and unreconciled estimates are tracked separately. Configure a provider-side project limit for shared-account spending.

### Market session and data coverage

Market status uses `America/New_York` and an exchange holiday table. Research can produce sourced market context without precise option data. Review [Data provenance](DATA_PROVENANCE.md) for the evidence policy and [Known limitations](KNOWN_LIMITATIONS.md) for the implications of web-based coverage.
