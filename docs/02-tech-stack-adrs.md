# 02 · Tech Stack & Architecture Decision Records

Status: Draft v1. Each ADR: context → options → decision → trade-offs → revisit trigger. Items marked **CONFIRM** deviate from the original deck/PDF and need your sign-off.

## Stack at a glance

| Layer | Choice | Change vs deck |
|---|---|---|
| Agent/farmer/buyer/verifier UI | Next.js 14 + TypeScript + Tailwind **built as a static PWA** (no SSR, no API routes), IndexedDB outbox (Dexie), i18n (en/hi/bn), a11y-first components | Firestore removed |
| Backend | **One** Node + TypeScript modular monolith (Fastify or NestJS) as a long-running service, plus a worker process from the same codebase | Next.js API routes no longer host business logic **CONFIRM** |
| Database | PostgreSQL 16 (+ PostGIS), managed in an Indian region, HA standby, read replica later | TimescaleDB deferred |
| Jobs/outbox | Postgres-backed queue (e.g. pg-boss) giving transactional enqueue | BullMQ/Redis queues replaced **CONFIRM** |
| Cache/rate limit | **None in the MVP**: OTP/rate limits live in Postgres; add Redis only against a measured bottleneck | Redis removed from MVP |
| Object storage | S3-compatible in an Indian region; pre-signed URLs ≤ 1 h | Same |
| Auth | Phone OTP via SMS provider + **server-side sessions** (opaque token, device-bound); JWT only for short-lived signed links; Firebase Auth acceptable for prototype only | **CONFIRM** |
| MRV | Versioned methodology module; Sentinel-2 NDVI from cached GEE exports; IPCC-based factors | Live GEE deferred |
| Payments in | Razorpay (sandbox → live) | Same |
| Payouts out | Port/adapter; sandbox adapter in MVP | Real rail later |
| Chain | Solidity + Hardhat, ethers.js, Polygon Amoy, KMS minter | No farmer wallets |
| Notifications | SMS (DLT-registered templates); IVR provider is a stretch item (S13.2) | New |
| Maps | Leaflet + OSM (offline tile cache for working areas) | Offline tiles added |
| Observability | OpenTelemetry, Prometheus/Grafana or managed equivalent, Sentry | New |
| CI/CD | GitHub Actions, containers, IaC (Terraform), environments dev/staging/prod | New |

---

## ADR-001 · Modular monolith, single Indian region
- **Context:** team size is small; CP guarantees on money/credits; hosting data in India is a design choice (the DPDP Act has no blanket localisation rule; sectoral rules such as payment data may, to be confirmed under Q-OQ-9); target ~500K farmers.
- **Options:** (a) microservices multi-region, (b) modular monolith single region + HA standby, (c) serverless functions.
- **Decision:** (b). Strict module boundaries, schema ownership per module, in-process interfaces, domain events via outbox.
- **Trade-offs:** one deployable can fail as a unit; region outage = downtime (RTO target 15 min within region/AZ; cross-region DR is restore-based). Simpler consistency, cheaper, faster to build.
- **Revisit when:** sustained write CPU > 60% on primary after tuning, or a module needs independent scaling/team ownership, or an availability SLO above 99.9% is contractually required.

## ADR-002 · PostgreSQL is the single source of truth
- **Decision:** all credit, order, ledger and audit state lives in Postgres under ACID transactions; Polygon is derived/optional, and Redis is not used in the MVP.
- **Trade-offs:** primary is a write bottleneck; mitigated by short transactions, partitioning, per-market allocation locks.
- **Revisit when:** allocation p95 > 500 ms at target load or lock contention dominates.

## ADR-003 · Drop Firestore; offline via IndexedDB outbox + sync API (decision D13)
- **Context:** two stores (Firestore + Postgres) create two write paths and reconciliation risk; data may sit outside India.
- **Decision:** one sync API, idempotency keys, append-only captures, server-authoritative transactional state.
- **Trade-offs:** we build sync ourselves (storage quotas, eviction handling, retry logic); mitigated by a narrow event model and tests.
- **Revisit when:** PWA storage limits or iOS eviction prove unworkable ⇒ native Android wrapper (Capacitor) with SQLite.

## ADR-004 · Postgres-backed jobs/outbox instead of Redis queues  **CONFIRM**
- **Context:** the deck uses BullMQ/Redis; enqueue after COMMIT can lose jobs, and Redis adds a second consistency domain.
- **Decision:** transactional outbox using a Postgres job queue (`SKIP LOCKED`); no Redis in the MVP (rate limits and OTP counters live in Postgres).
- **Trade-offs:** lower queue throughput than Redis; MVP volumes are expected to be far below Postgres queue limits (to be measured in S15.2 rather than assumed). The job table *is* the outbox: there is no separate relay.
- **Revisit when:** job throughput or latency requirements exceed Postgres queue capacity ⇒ move consumers to SQS (or Redis) fed from the same outbox table by a small forwarder.

## ADR-005 · No TimescaleDB in MVP
- **Decision:** NDVI observations in a partitioned plain table; continuous aggregates replaced by scheduled summaries.
- **Revisit when:** NDVI rows > ~500M or query latency on time windows degrades.

## ADR-006 · Auth: own OTP service, server-side sessions  **CONFIRM**
- **Context:** farmers are assisted; agents authenticate (phone OTP + device registration); keeping identity data India-resident is preferred (design choice, see ADR-001).
- **Decision:** SMS OTP provider + **server-side sessions** (opaque random token, stored hashed; bound to `device_id`; idle and absolute lifetimes); RBAC evaluated server-side on every request, so role changes apply immediately; device key registration for agents. Revoking a device or user is "delete the session rows". JWT is used only for short-lived single-purpose signed links (certificate downloads, resumable-upload URLs).
- **Offline note:** agents capture and sign events with the device key while offline; the session is needed only at sync time. An expired session forces re-login before sync, and queued events remain valid.
- **Trade-off:** more code than Firebase Auth. Firebase is acceptable only for a synthetic-data prototype.

## ADR-007 · Payout port with sandbox adapter (D8)
- **Decision:** `PayoutPort.send(payee, amount, idempotency_key)`; MVP adapter simulates bank behaviour (delay, failure injection); ledger and state machine are real.
- **Revisit when:** legal entity, nodal/escrow arrangement and a payouts product (e.g. RazorpayX or bank API) are available.

## ADR-008 · Blockchain: single KMS minter, pseudonymous IDs, audit anchoring (D14)
- **Decision:** mint `{credit_id, co2e, vintage, farmer_pseudo_id}` to Polygon **Amoy**; anchor audit head hashes periodically.
- **Trade-offs:** on-chain data cannot be deleted ⇒ nothing personal is placed on-chain; pseudonymous ID is a salted HMAC rotated per policy.
- **Revisit when:** mainnet or per-farmer self-custody becomes a requirement.

## ADR-009 · MRV as versioned, pluggable methodology (D15)
- **Decision:** `MethodologyV{n}` classes behind one interface; formula and coefficient sources documented in the technical design; GEE exports cached as GeoTIFF/CSV per demo plot with provenance.
- **Revisit when:** a registry methodology (CCTS/Verra VM0042) mandates specific parameters.

## ADR-010 · Accessibility is a release gate (D9)
- **Decision:** WCAG 2.2 AA, 48 px touch targets, icon+text+audio prompts, high contrast for sunlight, font scaling, screen-reader labels, tested on a 2 GB RAM Android reference device and throttled 2G/3G profiles; performance budget: shell ≤ 200 KB gz **[A]**, interactive < 5 s on slow 3G.
- **Revisit when:** user testing with agents/farmers shows task failure rates above target.
