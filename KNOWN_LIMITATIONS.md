# Known limitations

## Market data and execution

- Web research provides evidence about underlyings and catalysts with variable coverage. Numeric option assertions from the model require separate evidence before strategy construction.
- The optional Market Data feed supplies cached options chains for supported US equity and ETF contracts to the configured private owner. It requests snapshots during the regular US session and for 30 minutes after the close. Coverage depends on cache availability, quote age, and plan entitlements. See [Market Data options coverage](https://www.marketdata.app/data/options/).
- Subscriber-grade underlying prices and corporate-event dates need independent, authorized data sources. The web provider leaves unsupported numeric fields empty. Earnings exclusion uses a verified event date when available.
- A scan can find interesting underlyings while reporting zero eligible option opportunities. Missing, stale, delayed, and contradictory observations limit what the scanner can show.
- User-entered option premiums are assumptions for simulation and paper tracking. Bid and ask availability and fills depend on the broker, venue, quote age, and order conditions.
- Paper accounting uses USD. Reliable currency conversion would need a separate verified FX source.
- Paper positions use hypothetical fills. Realized P&L depends on what the user records. Historical option-chain backtesting, exchange-quality streaming prices, and live orders require capabilities outside this implementation.
- Payoff graphs model expiration settlement. Assignment, exercise, and leg-risk scenarios depend on broker and exchange rules. Research scores measure the configured ranking criteria.

## Live services and hosting

- Live workspace verification requires Supabase credentials. Web research requires a configured OpenAI project. Automatic cached chains require owner access and a Market Data account with the applicable entitlement. Local demo and mocked checks cover application behavior with controlled inputs.
- API cost figures are estimates from recorded usage and your configured rates. Use your OpenAI billing data for charged amounts.
- Market Data credits and subscription billing are separate from OpenAI estimates. Personal entitlements are limited to private use by the subscriber. Shared deployments and redistribution require applicable permissions. See [Market Data terms](https://www.marketdata.app/terms/).
- Market Data self-service plans assume one active device or persistent server and one IP at a time. Ordinary serverless instances can rotate outbound addresses and are unsupported for this plan. See [market data hosting guidance](https://www.marketdata.app/docs/api/troubleshooting/multiple-ip-addresses/).
- Background work depends on an available scheduler or an active scanner advancing the job. Choose a scheduling frequency supported by the hosting plan.
- Hosted operation requires a durable database. The filesystem-backed demo is intended for a local Node.js process. Hosted demo persistence needs separate Supabase configuration.
