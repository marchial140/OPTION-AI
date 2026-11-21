# Known limitations

## Market data and execution

- Web research provides evidence about underlyings and catalysts with variable coverage. A dependable US options chain requires a dedicated quote provider. Numeric option assertions from the model require separate evidence before strategy construction.
- Subscriber-grade underlying prices, corporate-event dates, and option-chain quotes need independent, authorized data sources. The web-only provider leaves unsupported numeric fields empty. The earnings exclusion uses a verified event date when available.
- A scan can find interesting underlyings while reporting zero eligible option opportunities. Missing, stale, delayed, and contradictory observations limit what the scanner can show.
- User-entered option premiums are assumptions for simulation and paper tracking. Bid and ask availability and fills depend on the broker, venue, quote age, and order conditions.
- Paper accounting uses USD. Reliable currency conversion would need a separate verified FX source.
- Paper positions use hypothetical fills. Realized P&L depends on what the user records. Historical option-chain backtesting, exchange-quality streaming prices, and live orders require capabilities outside this implementation.
- Payoff graphs model expiration settlement. Assignment, exercise, and leg-risk scenarios depend on broker and exchange rules. Research scores measure the configured ranking criteria.

## Live services and hosting

- Live verification requires a configured OpenAI project and Supabase environment. Local demo and mocked checks cover application behavior with controlled inputs.
- API cost figures are estimates from recorded usage and your configured rates. Use your OpenAI billing data for charged amounts.
- Background work depends on an available scheduler or an active scanner advancing the job. Choose a scheduling frequency supported by the hosting plan.
- Hosted operation requires a durable database. The filesystem-backed demo is intended for a local Node.js process. Hosted demo persistence needs separate Supabase configuration.
