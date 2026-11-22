# Data provenance

The workspace distinguishes an underlying research candidate from an option strategy constructed from identified contracts. A prospective thesis can be useful even if a price, earnings date, multiplier, or option quote is unavailable.

## Evidence classes

| Class | What it supports |
| --- | --- |
| Web research | Attributed news, directional evidence, event context, and explicitly sourced observations where supported |
| Attested broker quote | User-submitted contract observation with an explicit broker source, quote timestamp, and attestation |
| Manual simulator input | User-entered premiums for calculation and paper tracking |
| Demo | Synthetic observations, contracts, and paper fills for exploring workflows |

Quote time describes the observation. Retrieval time records when research obtained it. A recent retrieval can contain an older observation. A supported quote requires the observed fields, timestamps, and a traceable source.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `VERIFIED_FRESH` | Supported quote time lies within the configured freshness window |
| `VERIFIED_DELAYED` | Supported quote has an explicit delay or exceeds the fresh window |
| `MANUAL_ATTESTED` | User-attested broker observation that passed structural validation |
| `VERIFIED_HISTORICAL` | Traceable past observation associated with historical research |
| `STALE` | Quote is too old for the requested use |
| `UNVERIFIED` | Supplied data still requires independent evidence |
| `INSUFFICIENT` | A required field or supporting source is unavailable |
| `CONTRADICTORY` | Supplied fields or sources disagree |
| `DEMO` | Synthetic data confined to demo |

Contract validation checks the standard OCC identity, USD denomination, verified multiplier of 100, expiry, bid/ask ordering, and consistent observation and retrieval times. It treats observations older than 15 minutes as delayed and those older than 36 hours as stale. Conflicting bid and ask records for the same contract and observation time are rejected. Multi-leg opportunities require observations within five minutes of one another and compatible provenance. See [Risk engine](RISK_ENGINE.md).

Attested broker observations must refer to the regular session or its closing time. Their source method is `manual-broker` and confidence is `user-attested`. These observations remain indicative and enter the strategy pipeline under `MANUAL_ATTESTED` after structural checks. Older records tagged as delayed but identified as `manual-broker` are displayed as manual attestations. The current view excludes withdrawn, superseded, expired, and stale observations. Historical scans retain their recorded source and quote time.

A validation status describes support and timing for a specific research use. For web and historical observations, the ability to transact at a reported price remains unknown. The equity options session indicator follows regular hours. Individual products and venues can use different hours.

For OpenAI research, a reference must match an HTTPS address returned by the search tool or a citation annotation, and the address must belong to a recognized publisher. This verifies the origin of the reference. Readers can follow the link to assess how well the publisher supports the synthesized claim.

## Auditability

Review the source link, quote timestamp, and scan timestamp where available. Saved scans retain their original observations and rejections. Repeating the same scan can produce new information and a new snapshot. When a required observation is missing, the interface leaves the field unavailable or reports why the strategy was rejected.

Synthetic values are identified in the interface. A live provider failure returns a live error or an incomplete live scan. User-entered prices remain labeled assumptions in calculations.
