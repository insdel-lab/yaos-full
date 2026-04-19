# YAOS QA History and Coverage

This document records what we tested, what broke, what we changed, and final
QA outcomes.

## Startup/load regression follow-up (March 24, 2026)

Post-release validation for the "plugin taking too long to load" and early
attachment startup race is documented in:

- [`engineering/startup-load-and-blob-gate.md`](./startup-load-and-blob-gate.md)

Summary:

- startup capabilities are non-blocking in `onload()`
- blob downloads are gated until both layout-ready and startup-ready
- sampled garden logs show `startup-onload-complete` in ~`9-15ms`

## Durable Object hardening pass (March 30-31, 2026)

Post-`1.4.0` server hardening was driven by real production errors from a live
deployment.

Observed production issue:

- `SQLITE_TOOBIG` on websocket, `/__yaos/trace`, and `/__yaos/document` paths

Root cause:

- observability trace ring stored as one growing SQLite value inside the room DO

What changed:

- trace storage redesigned to bounded per-entry records
- trace persistence made fail-open
- `/__yaos/trace`, `/__yaos/debug`, and `/__yaos/meta` moved above hydration
- schema admission moved to metadata-first probing via `roomMeta`
- cold-start room loading gated behind single-flight logic
- snapshot `maybe` serialized inside the room DO
- regressions added for trace sizing and concurrency helper behavior

Validation:

- `cd server && npm run typecheck`
- `npm run test:regressions`
- `node tests/worker-integration.mjs`

Outcome:

- original `SQLITE_TOOBIG` failure mode is eliminated
- oversized trace payloads are truncated safely
- no other production error class was observed in the supplied live logs

## Marketplace compliance follow-up (v1.2.1 cycle)

Updates were merged to `main` and released in `v1.2.1`.

What we fixed:

- command IDs were normalized for marketplace compliance (13 IDs; removed
  `yaos-` prefix)
- non-core deletion paths (migration/debug surfaces) were moved to
  `fileManager.trashFile()`

What we intentionally skipped (and why):

- 3 remaining `Vault.delete()` call sites in `src/sync/blobSync.ts` and
  `src/sync/diskMirror.ts` stay as hard deletes by design
- these paths are core network-mediated sync state-machine operations
  (tombstones/rename conflict handling), not user-facing delete actions
- switching to trash semantics changes event topology (delete -> rename into
  trash), which can be misread by sync as new state and cause resurrection
  loops across devices

## Final QA status (March 10, 2026)

Release gate status: PASS for current v1.0.0 scope.

Final validated outcomes:

- Migration drill (Run A) passed:
  - room upgraded to schema v2
  - mixed-version kill switch rejects incompatible clients with
    `update_required`
  - reconnect thrash is stopped on fatal auth mismatch
- Holy QA run (Run B) passed for core user workflows:
  - pairing and hydration
  - fast reconnect + authoritative re-reconcile on reconnect
  - attachment sync under stress (including retries and queue durability)
  - rapid file switching/editor binding self-heal behavior
  - checkpoint/journal truncation fallback convergence
  - snapshot creation, markdown restore, and anti-resurrection defenses
- Focused follow-up pass passed:
  - rapid-fire filesystem append burst now coalesces to a single ingest/apply
    event in the measured run
  - out-of-band (OOB) edit behavior remains stable with no tug-of-war or
    integrity drift
  - snapshot attachment restore now passes empirically across two desktop vaults
    with post-restore convergence and pre-restore backups

Final diagnostics in latest runs show:

- `missingOnDisk=[]`
- `missingInCrdt=[]`
- `hashMismatches=[]`

## Scope

The QA work covered:

- desktop + Android multi-device sync behavior
- startup and reconnect behavior under network churn
- empty-vault hydration
- offline rename conflict behavior
- attachment upload/download under stress
- editor binding lifecycle under rapid file switching

## Major issues found and fixed

## 1) Empty vault hydration blocked by safety brake

Symptom:

- new device with empty vault did not hydrate from remote room

Root cause:

- reconcile safety brake treated large create batches as destructive risk

Fix:

- safety brake now evaluates destructive operations (update/delete) rather than
  pure creates for first hydration behavior
- reconcile telemetry now distinguishes planned vs flushed writes

Validation:

- true empty-vault hydration now succeeds
- diagnostics show create batches flushing instead of being silently blocked

## 2) Vault pairing split-brain risk

Symptom:

- user-entered vault IDs diverged across devices, producing silent room split

Fix:

- device pairing flow now carries host + token + vaultId
- pairing/recovery UX added so users do not manually type vault identity in
  normal flow

Validation:

- desktop and mobile reached same room and converged in QA runs

## 3) Attachment queue stalls and 0/N stuck progress

Symptom:

- attachment sync appeared stuck (for example 0/3)
- queue could stall behind slow/hung transfers

Root causes:

- fixed timeout previously too short for large files on constrained networks
- no explicit timeout around HTTP operations in earlier path
- queue scheduling and retry behavior could produce prolonged no-progress UX

Fixes:

- explicit timeout wrapper for blob HTTP operations
- dynamic transfer timeout by payload size with min/max bounds
- rolling concurrency window for upload/download drains
- durable queue state (pending/processing metadata) persisted and restored
- in-flight diagnostics surfaced
- default attachment concurrency changed to 1 for reliability in mobile/slow
  networks where request abort is not available

Validation:

- transient DNS/network failure observed and auto-recovered via retry
- final diagnostics show connected/synced and blob counts converged
- queues drained on both devices

## 4) Reconnect latency after network return

Symptom:

- reconnect sometimes appeared delayed until app restart/foreground

Fix:

- explicit fast reconnect triggers on foreground and network online signals
- guarded reconnect behavior to avoid reconnect thrash on fatal auth states

Validation:

- reconnect generations and re-reconcile traces observed in later QA runs

## 5) Editor binding lifecycle flaps (missing sync facet)

Symptom:

- frequent `binding-health-failed` with `missing-sync-facet` during rapid mobile
  file switching
- immediate self-heal afterwards

Root cause:

- health checks racing UI/editor lifecycle while CodeMirror view/facet was still
  settling

Fixes:

- deferred health checks outside active update cycles
- retry-based CM resolution and healing path
- rapid-switch aware settle window in `editorBinding.ts`:
  - base settle window for normal binds
  - longer settle window for quick same-leaf path switches
  - post-bind health check delay derived from binding settle window

Validation:

- no permanent binding failures in latest pass
- failures seen in logs are followed by `binding-health-restored`
- regression suite remains green after settle-window patch

## 6) Offline rename collision model

Status:

- architectural direction validated (id-first metadata model)
- dedicated regression tests for v2 rename convergence already present
- runtime cutover and migration safeguards are in progress (see remaining work)

## QA findings from latest pass

- Attachments converged successfully across both devices in final state.
- `bay.jpg` missing on mobile is expected under current config:
  - logged as skipped due to size limit:
    `upload: "bay.jpg" too large (11118966 bytes), skipping`
  - default max attachment size is 10 MB (10240 KB), and `bay.jpg` exceeds it.

## Snapshot and recovery follow-up pass (March 10, 2026)

Two-vault desktop pass using `attachment-test` and `attachment-test copy`
validated the remaining snapshot/recovery surface:

- R2 capability auto-enable passed in both lifecycle cases:
  - primary vault was already open when the worker gained `YAOS_BUCKET`
  - secondary vault was opened only after redeploy
- attachment engine auto-started without manual refresh or manual toggle
- initial attachment upload/download converged to `blobPathCount=4` on both
  devices with empty queues
- daily snapshot path fired automatically once R2 became available
- manual snapshot creation succeeded
- snapshot restore succeeded on the secondary vault with pre-restore backups
- attachment restore from snapshot was manually verified and final vault trees
  converged byte-for-byte across both desktops

Evidence from exported diagnostics/traces:

- primary vault:
  - `/home/kavin/attachment-test/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-10T14-23-06-853Z-device-mmkp74h1.json`
  - `/home/kavin/attachment-test/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-10T14-29-38-322Z-device-mmkp74h1.json`
  - `/home/kavin/attachment-test/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-10T14-32-32-221Z-device-mmkp74h1.json`
- secondary vault:
  - `/home/kavin/attachment-test copy/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-10T14-30-29-710Z-device-second.json`
  - `/home/kavin/attachment-test copy/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-10T14-32-38-698Z-device-second.json`
  - `/home/kavin/attachment-test copy/.obsidian/plugins/yaos/logs/current-state.json`
  - `/home/kavin/attachment-test copy/.obsidian/plugins/yaos/restore-backups/2026-03-10T14-32-33-577Z/Welcome.md`
  - `/home/kavin/attachment-test copy/.obsidian/plugins/yaos/restore-backups/2026-03-10T14-32-33-577Z/wallpapers/quota.md`

Observed residual noise:

- one transient `missing-sync-facet` editor health flap appears in historical
  trace on the secondary vault and self-heals immediately via repair; it did
  not cause data drift, queue stalls, or restore failure.

## Run A completion (March 8, 2026)

- Migration/divergence mini-run is completed and passes.
- New room bootstrapped on `https://yaos.ripplor.workers.dev` with
  `vaultId=FMW0Anw7NTF3Kev9gsnW8g`.
- First run exposed server regression (`1101`, durable object `.name` access
  before set-name). Fixed in `server/src/server.ts` and redeployed.
- Room reached v2 on primary client:
  - `storedInDoc: 2`
  - `supportedByClient: 2`
  - authoritative reconcile succeeded.
- Mixed-version kill switch validated:
  - intentionally old client (`schemaVersion=1`) is rejected with
    `update_required`.
  - plugin now marks `fatalAuthError=true` with `fatalAuthCode=update_required`
    and details (`clientSchemaVersion=1`, `roomSchemaVersion=2`).
  - reconnect thrash is stopped by fatal-auth handling.

## Reviewer synthesis (current)

Validated against current code/docs:

- Snapshot pathing is no longer a v1-only blocker:
  - `snapshotClient.ts` resolves markdown paths through
    `collectActiveMarkdownPaths()`.
  - v2 path authority is `meta.path` (`idToMeta` model), with legacy fallback
    only for v1 compatibility.
  - Result: snapshot restore is still a mandatory QA gate, but not an
    automatic architectural blocker.
- Pairing UX and live-collab UX were underrepresented in the checklist.
- Filesystem bridge stress tests were missing explicit runbooks.
- Mobile IndexedDB quota behavior remains under-tested empirically.

## Current known limits (explicit)

- Attachments above configured size cap are intentionally skipped.
- Under poor mobile networks, transient DNS/transport failures are expected and
  handled by retry/backoff.
- WebView/Obsidian mobile editor lifecycle can still produce temporary facet
  availability gaps; current logic heals and now waits longer on rapid switches.

## Remaining empirical QA (optional post-v1 follow-ups)

The blocking items for v1.0.0 were exercised and passed. Remaining follow-ups
are optional hardening/soak tests:

1. Extended long-duration mobile churn soak (30-60+ minutes)
2. Additional low-storage device matrix coverage beyond simulated quota
3. Additional UI polish checks for oversize-attachment messaging copy
4. Optional cold recovery-kit proof on a brand-new third vault

## Operational QA guidance (development mode)

- During active development, deploy plugin artifacts only:
  - `main.js`
  - `manifest.json`
  - `styles.css`
- Keep `data.json` per device (except intentional config edits).
- Avoid copying whole vault zips between devices for iterative QA; it obscures
  true hydration/reconcile behavior.
