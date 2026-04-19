# YAOS 1.4.0: Update Pipeline Implementation

This note captures what actually shipped in YAOS `1.4.0`.

The existing RFC, [`engineering/zero-ops-update-pipeline.md`](./zero-ops-update-pipeline.md),
explains the architectural problem and the desired model. This document is the
implementation-side companion: what changed in code, what safety properties were
added, and how the release should be understood in hindsight.

## Release identity

`1.4.0` was primarily the **zero-ops update pipeline** release.

It was not a CRDT storage-engine release, a protocol migration release, or a
new sync semantics release. The center of gravity was operational:

- how detached Deploy-to-Cloudflare repos get an update path
- how the plugin learns safe update metadata from the server
- how the updater avoids clobbering existing config
- how compatibility is surfaced clearly to the user

## What landed

## 1. Reusable ops workflows

Reusable GitHub Actions workflows were added so generated YAOS server repos can
run update/revert operations without every detached fork having to carry all of
the update logic locally.

Shipped pieces:

- reusable upstream workflow
- small bootstrap workflow for generated server repos
- plugin-side flow that can point users at the correct bootstrap path

This made the update path operationally real instead of remaining "documented in
principle."

## 2. Patch-safe server update metadata

`ServerConfig` and the capabilities wiring were extended so the server can own
update metadata authoritatively:

- update provider
- update repo URL
- update repo branch

The important implementation detail is that update metadata writes use **patch
semantics** rather than destructive replacement semantics.

That prevents a fresh device, partial payload, or legacy client path from
accidentally wiping existing updater configuration.

## 3. Plugin-side metadata hydration and provider inference

The plugin was hardened to:

- hydrate update-related metadata from server capabilities
- infer provider information conservatively
- behave safely when older or partial metadata is encountered

This mattered because the updater is inherently multi-device:

- a server may already be configured by one device
- another device may connect later with incomplete local state
- the plugin must preserve existing updater truth rather than overwrite it with
  empties or guesses

## 4. Clearer compatibility and updater errors

The release also tightened the update path around compatibility:

- explicit compatibility floor in release/update metadata
- clearer failure surfaces in updater flows
- less ambiguous behavior when the server/plugin combination is not eligible for
  automatic update

This did not introduce a new migration gate model. It made the existing model
much easier to reason about and much safer to operate.

## 5. Canonical user-facing documentation

`1.4.0` also shipped the practical docs that made the feature usable:

- canonical deploy/update flow in the README
- server-side update flow notes
- the engineering RFC for the zero-ops pipeline itself

That documentation was part of the release, not an afterthought.

## Safety properties established by 1.4.0

After `1.4.0`, YAOS had these important properties:

- detached Deploy-to-Cloudflare installs had a real update path
- updater configuration lived on the server and could hydrate onto new devices
- empty or legacy metadata would not silently wipe updater settings
- compatibility rules were explicit enough for the plugin to block only when
  necessary

## What 1.4.0 did not change

To avoid future misreading, `1.4.0` did **not**:

- redesign websocket auth
- change the CRDT document model
- alter checkpoint/journal persistence architecture
- change schema negotiation itself

Those concerns belong to other releases.

## Why this note exists

Without this companion note, `1.4.0` can look like "a docs and workflow
release." That undersells the actual result.

The durable contribution of `1.4.0` was this:

- YAOS stopped being "easy to deploy on Day 1, awkward to maintain on Day 2"
- and became a system with an explicit server update lifecycle
