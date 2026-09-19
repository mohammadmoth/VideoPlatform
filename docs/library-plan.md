# Media library plan

## Status

Approved implementation baseline. Current operation and limitations are documented in the repository root [`README.md`](../README.md).

## Requirements and authoritative choices

### Catalog model

- The configured media root is scanned recursively.
- Its direct child folders are **collections**. Any deeper folders are recursive **sections** of the nearest collection.
- Supported videos directly in the media root belong to the synthetic **Other** collection.
- Supported extensions are `.mp4`, `.webm`, `.mkv`, and `.mov`, matched case-insensitively.
- Nested season folders are recommended (for example, `Show/Season 1/episode.mkv`). Sibling season folders remain supported as independent collections.
- Names never imply relationships: do not merge, group, or infer collections from naming patterns.

### Ordering and identity

- Persistent first-discovered ordering is required because **Added: old to new** and **Added: new to old** are explicit owner-facing sorts.
- Persist a `firstSeen` value per media path. A removed and later restored identical path retains its original `firstSeen`; a rename or move creates a new item.
- On first boot, when multiple files are discovered together, break discovery ties by natural path sorting so the initial order is deterministic.
- A stable media ID is carried in authoritative synchronized room state. Selection and playback must refer to that ID rather than independently chosen client paths.

### Discovery

- `fs.watch` is a change hint, never the catalog authority.
- Hints trigger coalesced, serialized reconciliation against bounded filesystem scans. Only one reconciliation mutates catalog state at a time.
- Run an adaptive safety scan even without watcher events, with more frequent checks after activity/errors and a bounded backoff while quiet.
- A candidate file remains pending until size and modification metadata settle across observations. Settling must not block reconciliation of other files.
- Watcher failure or unreliable delivery falls back to bounded polling.
- The master library exposes **Refresh**, which requests reconciliation and works regardless of watcher health.

### User experience and synchronization

- The master has a separate library view. Player presentation otherwise remains unchanged except for a **Back** action.
- Selecting an item synchronizes its authoritative media ID, resets position to `0`, and pauses. Playback begins only through the existing **Play** action.
- There is no autoplay-next.
- **Back** uses application history; if there is no applicable prior entry, it returns to the library start.

## Scope boundaries

### In scope

- Recursive discovery and catalog reconciliation.
- Persistent ordering metadata and retained records for removed paths.
- Master-only browsing, sorting by added time in both directions, selection, Refresh, and Back behavior.
- Synchronizing media identity with the existing room playback state.
- Recovery from missed watcher events, transient files, and watcher failure.

### Out of scope

- Name-based show/season inference or merging.
- Transcoding, metadata scraping, thumbnails, accounts, multiple rooms, or remote media stores.
- Autoplay-next or changes to existing play/pause/seek/readiness semantics.
- A redesigned display/player experience beyond Back where applicable.

## Implementation acceptance criteria

1. Fixtures prove direct folders become collections, arbitrary-depth descendants become sections, and root files appear in **Other**.
2. Extension filtering accepts the four approved formats in mixed case and rejects other files.
3. Tests prove sibling season folders stay independent, nested seasons stay within their parent collection, and similarly named folders are never merged.
4. Reconciliation is serialized and converges to a fresh bounded scan after event bursts, missing/absent filenames, watcher errors, and changes made while watching is unavailable.
5. Safety scans adapt within documented minimum/maximum intervals; polling and manual Refresh both restore an accurate catalog when watch delivery is absent.
6. Growing files remain pending until stable across observations; one pending large file does not delay unrelated catalog updates.
7. `firstSeen` survives restart and removal/restoration of the same path. Rename/move receives a new value. First-boot ties produce deterministic natural-path order.
8. Both Added sort directions use persisted `firstSeen`, with a deterministic secondary key.
9. Selection atomically publishes the selected media ID with position `0` and paused state to every joined screen. No client derives a different media locally.
10. Selection never autoplays; the existing Play workflow starts it, and reaching the end does not select another item.
11. The library is master-only; existing display/player presentation and synchronization behavior remain unchanged except for Back.
12. Back follows application history and falls back to the library start when history has no valid prior destination.
13. Automated tests cover catalog rules, persistence, reconciliation recovery, synchronized selection, and navigation; manual WSL validation covers `/mnt/d` create, copy, grow, rename, move, delete, restore, watcher failure, and Refresh.
