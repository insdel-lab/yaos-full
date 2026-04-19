# Durable Object Hardening Implementation

This note records what actually shipped from the Durable Object hardening pass.

The planning and decision record lives in
[`engineering/do-hardening-rfc.md`](./do-hardening-rfc.md). This document is
the implementation-side summary: what changed, what production issue it fixed,
and what tradeoffs remain intentional.

## Trigger

This work was driven by real production logs from a live YAOS deployment.

Observed error:

- `SQLITE_TOOBIG`

Surfaces involved:

- websocket traffic
- `/__yaos/trace`
- `/__yaos/document`

The important conclusion was that the chunked checkpoint/journal engine was not
the culprit. That storage path was already chunked. The production failure came
from observability storage: a single debug trace ring stored as one growing
SQLite value.

## What shipped

## 1. Trace storage was redesigned

The old design:

- read full trace array
- append one entry
- write full array back as one SQLite value

The new design:

- each trace entry is stored independently
- keys are lexicographically sortable (`trace:<timestamp>:<random>`)
- retention is bounded to a recent window

This removed the single-value growth failure mode that caused
`SQLITE_TOOBIG`.

## 2. Trace persistence is fail-open

Observability now fails open:

- trace persistence errors are logged
- room startup and request handling continue

This is a deliberate inversion of the old failure mode, where a telemetry write
could make the room unavailable.

## 3. Trace payloads are size-bounded

Per-entry storage fixed the original crash class, but one giant trace payload
could still have recreated a smaller version of the same problem.

To close that gap:

- trace fields are normalized
- large strings and nested structures are truncated conservatively
- oversized trace entries are marked as truncated before persistence

## 4. Trace/debug/meta routes no longer hydrate the room unnecessarily

The room DO now handles these paths before the main document hydration path:

- `/__yaos/trace`
- `/__yaos/debug`
- `/__yaos/meta`

This keeps observability and metadata requests cheap and prevents them from
waking the full CRDT state just to answer a small diagnostic query.

## 5. Room metadata sidecar for schema admission

Websocket schema admission no longer relies on fetching and decoding the full
room document in the common case.

Instead, the room maintains a tiny metadata sidecar:

- `schemaVersion`
- `updatedAt`

The Worker first reads this metadata for schema admission. Only if metadata is
missing or invalid does it fall back to the older full-document probe.

This is intentionally a **read-path optimization**, not a second source of
truth for document contents.

## 6. Single-flight room loading

Cold-start room loads are now gated so concurrent requests share one in-flight
load path.

This preserves the current `y-partyserver` integration while preventing
duplicate checkpoint/journal replay work during reconnect bursts.

## 7. Snapshot `maybe` is serialized inside the room

The old snapshot `maybe` path used a Worker-side check-then-act flow.

The new path routes the "maybe create snapshot" decision through the room DO,
where it is serialized. This prevents duplicate daily snapshot creation under
concurrency.

## What intentionally did not change

This hardening pass did **not** reopen the following decisions:

- debounced `onSave()` persistence remains intentional
- the monolithic vault-wide `Y.Doc` remains intentional
- the config DO remains the authoritative BYOC config/auth store
- websocket query-token auth remains tracked debt, not part of this patch

These choices were reviewed again during the hardening pass and were preserved
on purpose.

## Regression coverage added

The implementation added focused coverage for:

- bounded per-entry trace retention
- oversized trace payload truncation
- single-flight concurrency helper behavior
- serialized queue behavior
- end-to-end oversized trace-path safety against a live worker

## Net effect

This release did not change the wire protocol or the CRDT model.

What it changed was the shape of the server hot path:

- observability is no longer able to poison room availability
- schema admission is cheaper
- cold-start work is less wasteful
- daily snapshot creation is deterministic under concurrency

In practical terms, YAOS moved from "architecturally sound but with one real
production poison pill" to "architecturally sound and materially harder to take
down with its own control paths."
