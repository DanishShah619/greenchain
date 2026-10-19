# F2 Land plots rights and crop cycles

Owner: `land`; E4, S2.4. Demo: synthetic boundaries and institution attestations. Inherits [common contracts](common-contracts.md).

## Domain and ownership

`RegisterPlot`, `ReviseDraftBoundary`, `RecordRights`, `VerifyRights`, `NominatePayee`, `OpenCropCycle`, `WithdrawPlot`. Land owns geometry, area, short plot code, crop cycles and rights history. Registry owns credits; market owns allocation groups/aggregates. Payee rekey is a composition-root workflow calling their ports under sorted type locks, not land importing writable market tables.

Owner or consented cultivator must have documented authority. Joint holdings have one nominated payee. Record who attested each right and its effective interval. Existing sold-credit payee snapshots never change when the plot payee changes. Boundary changes after verification require an explicit new claim/version; they do not rewrite historical calculations.

## Commands and validation

`POST /plots` receives client reference, GeoJSON polygon, state and rights evidence refs. Require ring closure, valid coordinates, bounded vertices/area, no self-intersection and known CRS. Compute area server-side with suitable geodesic/projected units; do not trust a client area. Store canonical keyed geometry fingerprint and original geometry version.

`PATCH /plots/:id/draft` requires expected version; stale edits return CONFLICT. `POST /plots/:id/rights/verify` checks mandate/evidence. `POST /plots/:id/payee` requires authorised nomination, current verified account and expected version. `POST /plots/:id/cycles` validates dates/crop/season and applicable overlapping-cycle policy; unsupported overlap is explicit, not silently accepted.

Exact duplicates are enforced by uniqueness. Spatial overlap checks use an indexed candidate query followed by precise intersection; threshold remains a configured assumption. Concurrent near-overlapping registrations require a land-owned spatial-area lock strategy or serializable transaction with bounded retry; a pre-insert SELECT alone cannot guarantee exclusion. Lock candidate spatial cells in stable order, then rerun the check. Boundary/cell size choice needs a spike before claiming overlap invariance.

## Security scalability and recovery

Institution-scoped evidence access; buyers see generalised provenance, not exact private polygons or land references. Cap polygon complexity to limit costly spatial operations. GiST geometry index plus state/status filters bound candidate sets; benchmark dense adjacent plots, not random points. Cursor lists avoid loading every plot into a map.

Record draft vs verified/withdrawn/frozen conditions explicitly. GPS uncertainty is shown to reviewers. Land API outages use manual attestation in demo. Contested rights block new issuance/reservation through owner ports; an existing sale uses its historical snapshots and dispute policy.

## Acceptance

Two identical requests create one plot; concurrent shifted overlaps are detected under the chosen locking policy; forbidden draft edits cannot alter a verified history; payee rekey updates aggregates atomically and leaves sold snapshots intact; foreign institution IDs and uploaded evidence refs are rejected. Area calculations have independent geographic examples and explicit tolerances.
