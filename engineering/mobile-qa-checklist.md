# YAOS QA Runbook (Split Execution)

This runbook is split into two runs:

- `Run A (completed on 2026-03-08)`: migration drill + schema divergence loud-failure check
- `Run B (later)`: full "holy QA" crucible

## Current status

- Run A is complete and passes:
  - room reached v2 (`storedInDoc=2`)
  - mixed-version client rejection confirmed (`update_required`)
  - plugin now surfaces fatal auth (`fatalAuthError=true`) and stops reconnect
    loop for incompatible clients
- Run B is complete and passes for release scope.
- Focused post-Run-B validation is complete:
  - rapid-fire markdown append burst coalesced to a single ingest/apply event
    in measured trace
  - OOB edit path remained stable (no tug-of-war, clean integrity diffs)
  - snapshot attachment restore passed across two desktop vaults after R2
    auto-enable

## Final holy QA completion (March 10, 2026)

Completed and validated:

1. Pairing + hydration flow
2. Real-time editing and editor lifecycle stability
3. Attachment stress path and queue durability
4. Reconnect behavior under network churn
5. Filesystem bridge controls
6. Checkpoint/journal truncation fallback
7. Migration drill + mixed-version kill switch
8. Snapshot creation, markdown restore, and attachment restore after R2
   capability activation

Final diagnostics outcome for latest desktop run:

- `missingOnDisk=[]`
- `missingInCrdt=[]`
- `hashMismatches=[]`

Evidence artifacts (latest focused pass):

- diagnostics:
  - `/home/kavin/holyqa-pc/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-09T19-01-40-455Z-device-holyqa-pc.json`
- boot trace:
  - `/home/kavin/holyqa-pc/.obsidian/plugins/yaos/logs/2026-03-09/boot-48yzzkohuuZXRA.ndjson`

## Holy pass vault setup (Run B preflight)

Recommended setup for cleanest signal:

1. Use a fresh test room (new `vaultId`) on the same deployed worker host.
2. Keep the current deploy if code did not change since last validation.
3. Desktop:
   - start in a fresh vault folder for this run
   - install latest plugin artifacts
   - configure host/token/new vaultId
4. Mobile:
   - use a separate fresh vault folder
   - install same latest plugin artifacts
   - pair from desktop QR/deep-link (do not manually type vaultId)
5. Keep old test vaults untouched for fallback regression rechecks.

When to redeploy:

- `No` redeploy required if you did not change server or plugin code since the
  last verified deploy.
- `Yes` redeploy only after code changes.

## Deployment guidance (before running anything)

1. Plugin build:
- Always install the latest local plugin build on the desktop test vault.
- For divergence test in Run A, keep mobile on older build intentionally.

2. Worker deploy:
- If server code changed since last deploy, redeploy Worker before Run B.
- For Run A migration-only drill, redeploy is optional unless you specifically
  want latest server trace markers in `/debug/recent`.

3. Diagnostics command usage:
- Use `YAOS: Export sync diagnostics` at each marked checkpoint.
- Name or note each export by phase in your test notes.

## Run A (completed): Migration drill + divergence guard

## Phase 0: Preflight and instrumentation

1. Install the same plugin build on both devices.
   - Exception for divergence test: mobile may remain on older plugin.
2. Enable YAOS debug mode on both devices.
3. Confirm both devices point to the same `host` and intended `vaultId`.
4. Confirm current schema before migration:
   - Export diagnostics and verify:
    - `state.schema.supportedByClient` is `2` on desktop plugin
    - Branch:
      - If `state.schema.storedInDoc` is `1`: run full Run A migration drill.
      - If `state.schema.storedInDoc` is `2`: migration already happened; run
        divergence guard only (Phase 3) using an intentionally old client.
5. Clear old mental context by exporting a baseline diagnostics file on both:
   - `YAOS: Export sync diagnostics`
6. Start a test notes log with timestamps for each phase transition.

Pass criteria:
- both devices start from known-good config and baseline diagnostics exist.

---

## Phase 2: migration crucible (explicit v1 -> v2 cutover)

### 8. Seed conflict before migration (legacy pressure)

1. Put both devices offline.
2. On Device A, rename folder/file path variant A.
3. On Device B, rename/edit same logical file to variant B.
4. Bring both online and allow convergence.
5. Export diagnostics on both devices immediately after convergence.

Goal:
- create a realistic legacy rename-conflict footprint before cutover.

### 9. Run migration command

1. On primary device run: `YAOS: Migrate schema to v2`.
2. Wait for sync stabilization.
3. Restart both clients once.
4. Export diagnostics on both devices.

Pass criteria:
- room schema reports v2.
- no fatal auth errors on upgraded clients.

### 10. Verify ghost-path physical cleanup

1. Inspect filesystem on both devices for loser/legacy conflict paths.
2. Confirm losing path file is physically absent (not only absent in CRDT).
3. Export diagnostics on both devices.

Pass criteria:
- no ghost file remains on disk.
- no immediate re-ingestion loop from stale disk path.

### Phase 2 checkpoint

Export diagnostics on both devices now.

---

## Phase 3: post-migration compatibility and recovery

### 11. Mixed-version guard (kill switch)

1. Attempt connection from an older/pre-guard client to upgraded room.
2. Observe server/client behavior.
3. Export diagnostics from upgraded desktop client.
4. Capture older-client log/notice screenshot showing rejection.

Pass criteria:
- client is rejected with `update_required`.
- no partial writes accepted from incompatible client.

### Phase 3 checkpoint

Migration drill complete. Archive all diagnostics + screenshots.

Run A completion references:

- Primary pass diagnostic:
  - `/home/kavin/test2/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-08T14-51-53-386Z-device-mmhns1xg.json`
- Old-client rejection diagnostic:
  - `/home/kavin/test2-oldclient-v1sim/.obsidian/plugins/yaos/diagnostics/sync-diagnostics-2026-03-08T14-51-57-973Z-device-oldclient-v1sim.json`

---

## Run B (completed): Full holy QA crucible

Run B was executed after Run A and passed for v1.0.0 release scope.

## Phase 1: baseline UX + durability (before migration)

### 1. Pairing and setup flow (two-device UX)

1. Bootstrap Device A from claim/setup link.
2. In Device A settings, use **Pair new device**.
3. Pair Device B using in-plugin QR/deep-link (no manual `vaultId` typing).
4. Validate claim button + camera QR + Lens + copy/paste fallback.
5. Run `YAOS: Export sync diagnostics` on both devices.

Pass criteria:
- Device B receives host/token/vaultId correctly.
- no split-brain room assignment.

### 2. Empty vault hydration

1. Create a brand-new empty vault on mobile.
2. Connect with same host/token/vaultId.
3. Restart Obsidian once.
4. Export diagnostics on both devices.

Pass criteria:
- desktop notes hydrate automatically.
- no unexpected deletions.

### 3. Real-time same-note collaboration

1. Open same note on desktop + mobile.
2. Type concurrently for 30-60s; switch notes rapidly.
3. Export diagnostics on both devices.

Pass criteria:
- converged final content, no persistent degraded/binding failure.

### 4. Fast edit lifecycle + swipe kill

1. Create + rapid type + immediate rename + background + force-close + reopen.
2. Export diagnostics on both devices.

Pass criteria:
- last typed line survives; no persistent degraded state.

### 5. Filesystem bridge controls

1. Rapid-fire ingest:
   - `for i in {1..50}; do echo "line $i" >> test.md; sleep 0.01; done`
2. Self-echo suppression test.
3. Out-of-band edit test.
4. Export diagnostics on both devices.

Pass criteria:
- coalesced ingest, echo suppression works, out-of-band edit ingests.

### 6. Attachment stress + oversize behavior

1. Add 3 files near limit (8-10 MB) + 1 file >10 MB.
2. Export diagnostics on both devices after queue drain.

Pass criteria:
- queue drains, files open on both, oversize skip is user-visible + logged.

### 7. Checkpoint truncation boundary

1. Keep Device B offline.
2. On Device A perform >50 edits.
3. Bring Device B online.
4. Export diagnostics on both devices.

Pass criteria:
- convergence via checkpoint/journal reset; no corruption/dupes.

### Phase 1 checkpoint

1. Export diagnostics on both devices.
2. Save server debug trace snapshot for this phase.

## Phase 2: post-migration data integrity

### 8. Offline rename collision (v2 semantics)

1. Desktop offline: rename folder `A` -> `B`.
2. Mobile offline: edit note under old path `A/...`.
3. Bring desktop online, then mobile.
4. Export diagnostics on both devices.

Pass criteria:
- edit survives.
- final state has one winning path.
- no duplicate resurrection.

### 9. Snapshot restore on v2

1. Take snapshot.
2. Mutate markdown + at least one attachment reference.
3. Restore selected files from snapshot UI.
4. Export diagnostics on both devices.

Pass criteria:
- selected markdown restores correctly.
- selected attachment refs restore and download.
- no legacy path corruption after restore.

Completion note:

- validated on March 10, 2026 in two-desktop pass:
  - primary vault auto-detected R2 after redeploy while already open
  - secondary vault auto-detected R2 on startup after redeploy
  - manual snapshot created successfully
  - restore executed on secondary vault with pre-restore backups
  - final desktop vault trees matched after restore

### 10. Long-offline anti-resurrection

1. Keep Device A offline.
2. On Device B create file, sync, then delete/rename activity.
3. Bring Device A back online.
4. Export diagnostics on both devices.

Pass criteria:
- deleted file does not resurrect.
- tombstone/index invariants hold.

### Phase 2 checkpoint

1. Export diagnostics on both devices.
2. Save server debug trace snapshot for this phase.

## Phase 3: destruction / storage pressure

### 11. Storage pressure / IndexedDB resilience

1. Fill storage low (or emulator throttle) until persistence pressure appears.
2. Continue edits/sync during pressure window.
3. Export diagnostics on both devices.

Pass criteria:
- plugin surfaces clear degraded/error state.
- diagnostics classify IDB failure reason (for example `quota_exceeded`).
- no silent false-safe behavior.

### Phase 3 checkpoint

Final diagnostics export on both devices.

---

## Required artifacts for final analysis (both runs)

1. Diagnostics JSON from each phase checkpoint (both devices).
2. Mobile screen recording for pairing + first sync + one failure/recovery moment.
3. Server debug trace dump near each checkpoint.

---

## Release gate (hard block conditions)

- Fail if empty-vault hydration fails once.
- Fail if force-close loses recent edits.
- Fail if rename conflict drops edits or duplicates files.
- Fail if pairing causes room split.
- Fail if post-v2 snapshot restore fails.
- Fail if mixed-version guard accepts incompatible client.
- Fail if storage-pressure failure is silent or unclassified.

## Remaining optional proof after release gate

- cold recovery-kit validation on a brand-new third vault remains optional
  rather than blocking, because hydration + restore convergence already passed
  across paired vaults
