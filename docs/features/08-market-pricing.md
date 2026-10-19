# F8 Marketplace inventory pricing and tax snapshots

Owners: `market` inventory projection and `pricing` price/tax rules. Core demo uses explicit demo-only tax settings. Existing detailed money rules: [doc 09](../09-pricing-invoicing-design.md). Inherits [common contracts](common-contracts.md).

## Queries and pure resolution

`BrowseInventory`, `QuoteOrder`, `CreatePriceDraft`, `PublishPriceList`, `ResolveOrderPrices`. Market queries available aggregate through registry-owned eligibility contracts. Pricing resolves type/vintage/state at a single `asOf`, receiving allocation by value; pricing never queries market to orchestrate allocation. Only priced/covered keys can enter allocation.

`GET /market/credits?type&vintage&state&cursor` returns aggregates, price summary and read freshness. `POST /quotes {quantity,filters}` is informational with price-list/version and expiry; it is not a reservation or guaranteed fill. `POST /price-lists`, entry edit, submit and publish are privileged owner commands. Publication validates completeness and both principal/commission tax coverage with an explicit effective time/commit margin. Missing configuration is not a zero tax assumption.

Final order pricing snapshots list ID, per-item amounts, principal tax, tier/commission rate and commission tax. Encode paise as strings. Publication after an order cannot change its price. A quote mismatch requires accepting the final snapshot before creating payment intent. Published entries cannot be edited; changes create a successor. Emergency withdrawal follows doc 09's authorised predecessor rule.

## Security and scale

Buyers browse approved inventory without private coordinates, phone/bank identifiers or institution evidence. Admin price/rule publisher is distinct from reviewer. Reject role/methodology/currency fields not supported by the command. Market listing can use a lagging read replica with timestamp; checkout rechecks primary. Cache quotes by version/filter if justified; never cache reservation availability as authoritative.

Use indexes for type/state/vintage, effective lists and exact coverage keys. Pagination limits public scraping/query cost; rate-limit by role/IP. Queue alerts for newly issued unpriced keys and never allow a missing rule to fail an already-paid fulfilment. Monitor read freshness, missing keys, quote changes and pricing latency.

## Acceptance

Price change during checkout yields one immutable price book; unpriced stock is excluded; principal and commission missing-rule cases fail before payment; another buyer cannot inspect order snapshots; publisher cannot approve their own list; tax/money rounding golden cases reconcile. Demo tax rules are prominently simulated and cannot publish into production scope. Price bands and GST/TDS values remain open business/legal inputs.
