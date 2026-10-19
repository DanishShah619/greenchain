# F3 Offline capture sync and media

Owner: `capture`; E3. Core demo feature. Land/identity effects go through their application ports. Inherits [common contracts](common-contracts.md); detailed outcomes remain in doc 06 section 5.

## Client and server protocol

Keep draft records, stable client IDs and upload manifests in IndexedDB. Persist the record before showing local-save success. The server acknowledgement is a distinct state. A proposed start is 50 events/256 KiB metadata per batch, measured on low-end devices; media uses separate capped uploads. Show quota exhaustion and pending count. Never discard an unacknowledged capture on logout or transient failure; clearing a device is an explicit warned action.

`POST /sync/batch {events:[{clientEventId,deviceId,aggregateRef,seq,type,payload,timeTokenId,segment,signature}]}` returns a result per event and permanent-reference mappings. Verify registered device, signature, scope, consent and allowed type; resolve dependencies. Persist event receipt, apply accepted owner-port changes, audit and enqueue in the same transaction per event. A partial batch does not roll back unrelated accepted events. If an event is only stored pending dependencies, return DEFERRED rather than claiming the business entity exists.

Duplicates return stored outcomes; altered payload under the same ID returns KEY_REUSE. Revoked-device events are quarantined for a scoped reviewer; no automatic apply. Missing dependency can be resent as a new linked event according to doc 06's terminal-status rule. User corrections get a new ID; preserve original receipt. Reordering append-only facts is allowed; draft changes use optimistic versions. Do not retry permanent rejection indefinitely.

## Evidence upload

`POST /media/uploads {eventId,slotId,declaredType,size,hash}` allocates a private upload bound to that slot and scope. Chunk manifests support resume. `POST /media/uploads/:id/complete` queues content/hash validation; only validated evidence becomes COMPLETE. Required-slot gating blocks MRV until complete/explicitly waived by verifier before calculation. Cap size, decoded pixel count and per-scenario total bytes; allow only required formats. Re-encode previews and retain needed original metadata privately. Do not treat EXIF/GPS or a device signature as proof of truth.

## Security and scale

Uploads cannot reference another subject/event. Presigned URLs authorise one operation/object for a short period; they cannot choose public keys or arbitrary destinations. Invalid/polyglot files remain quarantined; serve downloads with safe content headers. Scoped dedup indexes retain keys with their events. Metadata throughput and validation workers scale separately; orphan uploads are cleaned after a grace window using manifests, never by guessing which objects are safe to delete.

Clock tokens detect some drift; restart/sleep yields UNVERIFIABLE rather than manufactured certainty. Persistent browser storage requests reduce eviction risk but do not guarantee device durability. Track unacknowledged ages, retries, rejection reasons, quarantine and pending media, without high-cardinality person labels.

## Acceptance

Airplane-mode capture survives reload; interrupted acknowledgements replay once; upload resumes and corrupt chunks cannot complete a slot; one invalid event does not lose its batch neighbours; expired session leaves drafts queued; revoked device cannot apply new events; direct cross-scope upload/download fails; one missing media slot blocks verification.
