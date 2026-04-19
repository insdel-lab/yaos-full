# Durable Object Hardening RFC

This RFC defines the next server hardening pass for YAOS.

It is intentionally narrow:

- fix the production `SQLITE_TOOBIG` failure mode first
- remove avoidable cold-start and admission-path waste
- keep the monolithic CRDT and checkpoint+journal engine intact
- avoid speculative redesigns that are not justified by real logs

## Status

Approved for implementation.

## Why this RFC exists

Recent production logs from a real YAOS deployment showed a concrete failure mode:

- `SQLITE_TOOBIG`
- across websocket traffic
- across `/__yaos/trace`
- across `/__yaos/document`

The initial theory was "the room document is too large". After auditing the code and architecture docs, that explanation no longer fits the implementation.

The chunked checkpoint+journal engine in [`server/src/chunkedDocStore.ts`](../server/src/chunkedDocStore.ts) already exists specifically to prevent oversized single-value persistence writes for room state. The remaining unchunked write in the server hot path is the debug trace ring in [`server/src/server.ts`](../server/src/server.ts).

Current trace storage behavior:

1. Read the full trace array from storage.
2. Push a new trace entry into the array.
3. Write the full array back as one value.

That means observability can exceed SQLite single-value limits and take the room down. This is the primary production issue to solve first.

## Goals

- Stop observability storage from crashing rooms.
- Make trace/debug behavior fail-open.
- Remove unnecessary full-document work from websocket schema admission.
- Prevent duplicate room-load work on cold starts.
- Serialize daily snapshot creation so "maybe" is actually idempotent.
- Add regression coverage for the above.

## Non-goals

- Do not replace the monolithic vault-level `Y.Doc`.
- Do not change the checkpoint+journal storage engine architecture.
- Do not move config/auth state from the config DO into KV.
- Do not change debounced `onSave()` cadence based on number of clients.
- Do not redesign websocket auth in this pass.
- Do not add speculative crash-hardening unrelated to observed failures.

## Explicit product positions

The following are accepted architectural choices and are not being reopened in this RFC:

### Debounced `onSave()` is intentional

YAOS uses coalesced persistence at `onSave()` cadence by design. This preserves low IOPS and avoids turning active editing or collaboration into disk-thrash.

Collaboration latency is governed by in-memory Yjs state and websocket fanout, not by SQLite flush timing.

Important distinction:

- sync latency: how fast another connected client sees an edit
- durability latency: how fast that in-memory state is flushed to SQLite

In YAOS, active collaboration already happens through the in-memory room state inside the Durable Object. Lowering the save debounce when multiple clients are connected would not make collaboration faster. It would only shrink the crash-loss window while materially increasing:

- SQLite write frequency
- journal churn
- compaction pressure
- free-tier and cost pressure

For this reason, "more active clients" is not a signal to speed up persistence.

### The config DO is acceptable in BYOC

Each YAOS deployment is single-user BYOC. The config DO is not a multi-tenant global control plane. It remains the authoritative store for claim/auth/update metadata.

A tiny Worker RAM cache may still be added later as a micro-optimization, but it is not a required part of this implementation.

This matters for prioritization:

- the config DO is not a scale bottleneck in the SaaS sense
- it is not a reason to introduce Workers KV
- it is not a reason to add more Cloudflare products or deployment complexity

The only legitimate optimization case here is bursty handshake latency, especially if a user is temporarily far from the DO's creation region. That upside is real but limited, and therefore deferred.

### The monolith stays

The current vault-wide `Y.Doc` preserves strong cross-file semantics. This RFC optimizes around that design instead of replacing it.

### Query-token websocket auth is acknowledged debt, not forgotten debt

Websocket query-token auth remains an explicit v1 compromise for compatibility across constrained browser and WebView socket APIs.

This RFC does not replace it, but it does assume the following hygiene:

- traces and diagnostics must not persist raw auth-bearing URLs
- traces and diagnostics must not echo secrets back to clients
- future auth hardening remains on the roadmap

The long-term target is still:

- explicit post-connect auth handshake, or
- short-lived session credentials derived from the long-lived setup token

That work is intentionally separate from this server hardening pass.

## Scope

## P0: Observability stabilization

### 1. Replace the single-value trace ring

Current state:

- all traces are stored in one array value under `DEBUG_TRACE_RING_KEY`
- every append rewrites the entire array
- the value can grow until SQLite rejects it

Approved change:

- store each trace entry as its own key
- use lexicographically sortable keys
- do not persist the full ring as one value

Proposed key shape:

- `trace:<timestamp_ms>:<random>`

Example:

- `trace:1774832205123:4f7b2c9a`

Each value stores one `ServerTraceEntry`.

### 2. Make trace writes fail-open

Trace storage must never be allowed to take the room down.

Approved change:

- wrap trace persistence in `try/catch`
- log failures to `console.error`
- continue serving the request or room load path

This applies to:

- explicit `/__yaos/trace` writes
- `checkpoint-load` tracing during room load
- compaction tracing during checkpoint fallback

### 3. Decouple trace/debug routing from room hydration

Current state:

- `VaultSyncServer.fetch()` calls `ensureDocumentLoaded()` before handling `/__yaos/trace` and `/__yaos/debug`

Approved change:

- route `/__yaos/trace` and `/__yaos/debug` before hydration
- debug reads should inspect trace storage only unless explicitly documented otherwise

This keeps observability traffic cheap and prevents invalid requests from waking the full room state unnecessarily.

### 4. Add bounded retention

Per-entry trace keys solve the single-value growth bug, but trace storage still needs bounds.

Approved change:

- retain only a bounded recent window
- exact retention policy can be count-based, age-based, or both

Initial recommendation:

- serve only the newest 50-100 entries in debug
- delete older entries opportunistically during writes or reads

This RFC does not require alarms for retention. Simple opportunistic cleanup is sufficient.

## P1: Admission and cold-start performance

### 5. Add lightweight room metadata

Current state:

- websocket schema admission fetches the full room document
- the Worker reconstructs a full `Y.Doc` just to read `sys.schemaVersion`

Approved change:

- add a tiny room metadata record stored separately from the CRDT payload
- use it for websocket schema admission

Minimum fields:

- `schemaVersion`

Recommended fields:

- `schemaVersion`
- `updatedAt`

Optional future fields:

- `encodedDocBytes`
- `journalEntryCount`
- `journalBytes`

The metadata record must remain authoritative for the admission check.

#### Why this exists

The checkpoint+journal engine solved the write-shape problem for the monolithic room state. It did not solve the fact that websocket admission currently performs a full room-state fetch and Yjs decode merely to read `schemaVersion`.

That means two different statements can both be true:

- the room persistence engine is correct and intentionally chunked
- websocket admission is still doing avoidable O(document-size) work

The room metadata sidecar is specifically a read-path optimization and should not be conflated with the checkpoint/journal engine.

#### What this is not

This is not:

- a second source of truth for the document body
- a replacement for the room checkpoint/journal store
- a stepping stone toward sharding the monolith

It is a tiny sidecar for tiny decisions.

#### Expected upside

Best case:

- reconnect-heavy flows stop fetching and decoding the full room document during schema admission
- cold wakes do less CPU and memory work before allowing a compatible client through
- larger vaults benefit more than smaller vaults

Small vaults may only see a modest latency win. Large vaults and mobile reconnect patterns are where this matters most.

### 6. Replace full-document schema probing with metadata reads

Current state:

- Worker calls room DO
- room DO loads document
- Worker decodes full Yjs update
- Worker reads `schemaVersion`
- Worker calls room DO again for actual websocket handoff

Approved change:

- websocket admission reads room metadata only
- full room hydration remains for real sync handling, not for compatibility gating

This is expected to reduce cold-start CPU and memory pressure significantly for reconnect-heavy flows and larger vaults.

#### Fallback behavior

Older rooms may not have metadata yet.

Approved fallback:

- treat missing metadata as "unknown"
- allow one conservative fallback path that derives metadata from the room state
- write the metadata sidecar as soon as the room is successfully loaded or saved

The fallback path is a migration bridge, not the steady state.

### 7. Add safe one-time room-load gating

Current state:

- multiple concurrent cold-start requests can all enter `ensureDocumentLoaded()`

Approved change:

- memoize room load with a `loadPromise`
- all concurrent request paths await the same in-flight initialization
- failed initialization clears the memoized promise so later requests can retry

This RFC intentionally chooses the lower-risk `loadPromise` pattern rather than constructor-level integration changes with `y-partyserver`.

#### Why `loadPromise` first

Cloudflare's generic Durable Object guidance often points toward constructor-time initialization with `blockConcurrencyWhile()`.

That is directionally correct for plain Durable Objects, but YAOS is not operating a bare constructor-shaped DO. It is layered on `y-partyserver`, which already owns meaningful parts of the room lifecycle.

So the choice here is pragmatic:

- `loadPromise` directly solves the duplicate-load problem we observed in the current code shape
- it is local to YAOS logic
- it is less invasive than reworking the room constructor/lifecycle contract with the transport library

If later testing shows that constructor-level gating integrates cleanly with `y-partyserver`, that can still be revisited. It is not the first move in this RFC.

#### Expected upside

Best case:

- one logical room load per cold start
- fewer duplicate storage reads
- cleaner and more predictable startup semantics under reconnect bursts

This is mostly a cold-start efficiency and correctness-boundary improvement, not a steady-state throughput optimization.

## P1: Snapshot coordination

### 8. Serialize `/snapshots/maybe`

Current state:

- the Worker performs a check-then-create flow against R2
- two concurrent callers can both create the same daily snapshot

Approved change:

- route daily snapshot coordination through a per-vault serialized path
- preserve the existing snapshot format and recovery model

Goal:

- one logical daily snapshot create decision per vault per day

#### Why this is included but not front-loaded

The snapshot race is real, but its blast radius is limited:

- duplicate daily snapshots
- unnecessary R2 writes
- noisier history

It does not threaten core text sync correctness the way the observability bug does. So it is included in this RFC, but after the room-availability and admission-path fixes.

## P2: Tests and verification

### 9. Add regression coverage

Required tests:

- trace writes do not crash the room if trace persistence fails
- trace storage no longer uses one growing single value
- `/__yaos/trace` and `/__yaos/debug` do not require document hydration
- websocket schema admission no longer fetches or decodes the full room document
- concurrent cold-start requests share one room load
- `/snapshots/maybe` is idempotent under concurrency

Existing chunked storage tests remain the proof that the room-state persistence engine is still correct. This RFC does not replace them.

### 10. Preserve and validate the accepted tradeoffs

Regression coverage should also protect the choices we are intentionally keeping:

- debounced `onSave()` persistence should remain unchanged by this work
- the config DO should remain the authoritative config store
- websocket query-token auth behavior should remain compatible until a separate hardening RFC replaces it

These tests do not need to be extensive, but they should ensure this hardening pass does not accidentally reopen settled architecture.

## Deferred items

The following items remain valid future work, but are intentionally not included in this batch:

- Worker RAM auth-state cache with very short TTL
- RPC cleanup for config DO control-plane calls
- post-connect websocket auth handshake or short-lived session credentials
- more advanced trace retention using alarms

### Why the Worker RAM auth cache is deferred

This optimization was discussed in detail and remains intentionally optional.

It has some real value:

- a warm Worker isolate can avoid repeated config-DO reads during short bursts
- a temporarily far-from-origin user may shave one extra round trip on follow-up requests

But its upside is bounded:

- the first request still misses
- another isolate may still miss
- it does not change the authoritative config model

So the cache is treated as a zero-ops micro-optimization, not a core hardening requirement.

If implemented later, it should cache the resolved auth/config state, not "token validity" as an independent security boundary.

### Why Workers KV is excluded

Workers KV is intentionally excluded from this RFC for auth/config reads.

Reasons:

- YAOS is BYOC, not a multi-tenant control plane
- the config DO is already low-QPS
- KV would add deployment complexity and eventual-consistency semantics
- this hardening pass is focused on correctness and availability wins justified by real production evidence

## Design constraints

### The chunked room-state engine remains the source of truth

No change in this RFC may weaken the following guarantees:

- fail closed on corrupted checkpoint or journal data
- ordered journal persistence
- state-vector-anchored checkpoint recovery
- bounded get/put/delete batching

### Observability is not a correctness boundary

Tracing and diagnostics are optional operational tooling.

They must not:

- block room startup
- require room hydration by default
- crash websocket or HTTP flows

They also must not:

- silently reintroduce unbounded single-value writes
- persist secrets or auth-bearing URLs unnecessarily

### Metadata sidecars must stay cheap

Room metadata exists to avoid loading the monolith for tiny decisions.

That means:

- small payload
- small write surface
- explicit ownership
- no dependence on decoding the full document during reads

Sidecars are allowed because they reduce monolith-adjacent costs without weakening the monolith itself.

## Detailed implementation notes

### Trace storage model

Approved model:

- one key per trace entry
- lexicographically sortable timestamp-prefixed keys
- bounded debug reads via key listing

Properties:

- avoids single-value growth
- preserves recent history without array rewrites
- allows simple retention cleanup

### Room metadata ownership

The room DO owns room metadata.

That means:

- metadata is written by the room DO
- metadata is read for admission before expensive room-state work
- metadata must not depend on Worker-side derivation for normal operation

### Trace migration behavior

Legacy trace-ring reads must not be required for room availability.

If an older oversized trace ring exists:

- ignore it
- optionally delete it later
- do not touch it on critical paths

### Snapshot serialization shape

This RFC does not require a specific implementation shape, only the serialization guarantee.

Acceptable approaches:

- route daily snapshot create/noop decisions through the room DO
- route them through a per-vault coordination helper

Unacceptable approach:

- leaving the current R2 check-then-create race unchanged

## Migration notes

### Trace storage migration

No formal data migration is required.

Approved handling:

- stop reading the old single-value trace ring
- start writing new per-entry trace keys
- optionally ignore or delete the legacy key when convenient

If the legacy trace ring already exceeds limits, the fail-open path must allow the room to survive without touching that value.

### Room metadata backfill

Room metadata may not exist for older rooms initially.

Approved handling:

- treat missing metadata as "unknown"
- on first successful room load/save, populate the metadata record
- until then, use a conservative fallback path

The fallback path should be rare and should not become the normal path once rooms have been touched by the new code.

## Risk assessment

### Low-risk changes

- trace fail-open behavior
- routing `/__yaos/trace` and `/__yaos/debug` before room hydration
- `loadPromise` room-load gating
- snapshot `/maybe` serialization

### Medium-risk changes

- introducing room metadata and keeping it authoritative
- legacy-to-new trace storage migration details

### Explicitly high-risk changes not included

- changing persistence cadence based on collaboration state
- replacing the monolithic room model
- moving auth/config to KV
- redesigning websocket auth during this implementation pass

## Rollout order

1. Trace storage redesign.
2. Trace fail-open behavior.
3. Trace/debug routing above hydration.
4. Room metadata write path.
5. Metadata-based websocket schema admission.
6. `loadPromise` cold-start gating.
7. Snapshot `maybe` serialization.
8. Regression tests and cleanup.

## Success criteria

This RFC is successful when:

- the observed `SQLITE_TOOBIG` production issue no longer occurs from trace storage
- trace failures no longer take rooms down
- websocket schema admission no longer requires full document fetch/decode in the common case
- concurrent room cold starts perform one logical load
- daily snapshots are idempotent under concurrent requests

## What we are explicitly not saying

This RFC does not claim:

- Durable Objects are unreliable
- the current chunked persistence engine is wrong
- collaboration requires faster disk flushes
- the config DO is a true scale bottleneck in YAOS's BYOC model

The actual production incident here is narrower and more actionable:

- an unbounded observability write path is capable of crashing the room
- a few admission and initialization paths are still more expensive than they need to be
