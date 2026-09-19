# VideoPlatform documentation

This directory records the approved design baseline used to implement the media library. The current user-facing behavior is documented in the repository root [`README.md`](../README.md).

## Architecture overview

The application is a Node.js/Express server with one WebSocket synchronization room, a controller library, and a browser player:

1. The server discovers supported files below the media root and reconciles them into an authoritative catalog.
2. Direct child folders become collections; deeper folders become sections within their nearest collection. Supported files at the media root appear in **Other**.
3. Only the controller (master) receives the separate library experience. Displays remain on the existing player.
4. Selecting media updates the authoritative synchronized media ID, resets the room to position zero and paused, and then relies on the existing **Play** action.

## Decision index

- [Library plan](library-plan.md) — approved requirements, boundaries, authoritative choices, and acceptance criteria.
- [Research index](resarcher/README.md) — supporting studies (the folder spelling is intentional).
  - [Filesystem discovery](resarcher/filesystem-discovery.md) — `fs.watch`, WSL/`/mnt/d`, reconciliation, settling, and recovery.
  - [Collection structure](resarcher/collection-structure.md) — nested seasons versus sibling collections.

## Design versus current operation

These documents preserve the approved requirements and supporting research. Current installation, operation, limits, and troubleshooting guidance is authoritative in the repository root [`README.md`](../README.md).
