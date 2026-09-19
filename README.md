# VideoPlatform

VideoPlatform is a private, single-room video library and browser player for a trusted local network. One controller chooses a file and controls playback; multiple display browsers follow the same authoritative media selection, position, pause, seek, and scheduled start.

The server streams original files as-is. It does not transcode, infer show metadata, or automatically play the next video.

## Requirements

- Node.js 22 or newer
- A browser on each controller/display device
- Video files stored below `videosSource/`
- Sufficient LAN and disk bandwidth to stream the file independently to every display

## Install and run

```sh
npm ci
npm start
```

The default port is `8080`. Override it with `PORT`, for example `PORT=9000 npm start`.

Use the server computer's LAN address on every device:

- Controller library: `http://192.168.1.10:8080/library.html?master=true`
- Display/player: `http://192.168.1.10:8080/`

Replace the example address with the machine running VideoPlatform. `localhost` works only on that machine. Allow the selected TCP port through the local firewall.

Open the library on one controller. Open the player on each display and click **Join screens**. Select a video in the library; the controller moves to the existing player, where it should also click **Join screens**. Verify the connected count, then use **Play**, **Pause**, and the position slider. Playback starts muted; use **Enable sound** on the device that should produce audio.

## Adding videos

Put supported files anywhere below `videosSource/`. Direct child folders are collections. Descendant folders are sections within their nearest collection.

Recommended nested-season layout:

```text
videosSource/
  Pinky and the Brain/
    Season 1/
      Episode 1.mp4
    Season 2/
      Episode 1.mkv
```

A sibling-season layout is also valid, but each direct folder is a separate collection:

```text
videosSource/
  Pinky and the Brain - Season 1/
    Episode 1.mp4
  Pinky and the Brain - Season 2/
    Episode 1.mp4
```

Files directly in `videosSource/` appear in the synthetic **Other** collection. If a real folder is also named `Other`, the library disambiguates the root-files and folder collections. Hidden entries, symlinks, non-regular files, and unsupported extensions are ignored. Supported filename extensions are `.mp4`, `.webm`, `.mkv`, and `.mov`, case-insensitively.

A supported container does not guarantee browser playback: the audio/video codecs inside it must be supported by every target browser. VideoPlatform performs no transcoding. MP4 with broadly supported H.264/AAC codecs is commonly the most compatible choice.

For large copies, copy to a name ending in `.partial` and rename it to the final supported extension when complete. A new or changed supported file is otherwise held pending until size and high-resolution modification time remain stable for 30 seconds. Old files already present at startup may be admitted immediately.

## Library and discovery

The controller library browses collections and recursive section paths. Sorting supports name A–Z/Z–A and first-discovered oldest/newest. Name ordering is deterministic, case-insensitive natural ordering (`1`, `2`, `10`, `18`). First-discovered metadata is stored in the gitignored `data/media-metadata.json`; removed paths remain recorded, restoring the same path keeps its original order, and a move or rename is a new path.

Discovery uses a bounded recursive scan (four concurrent directory reads, 50,000 directory entries including hidden entries, maximum depth 16). A recursive filesystem watcher is only a prompt to scan, because watcher delivery can be unreliable on WSL-mounted and network filesystems. Event bursts are debounced and scans serialize. Adaptive safety scans continue even without events, at no more than a ten-minute quiet interval. If watching fails, retry and polling continue. The library's **Refresh** button uses that same serialized reconciliation path.

Only complete scans replace the public catalog. A failed or limit-exceeding scan leaves the previous complete snapshot available and reports the error.

## Synchronization behavior

- The server owns the room's selected catalog item, media generation, position, and playback state.
- Only the current controller can select a current catalog item. Selection cancels pending playback work, broadcasts one new media generation, and resets every screen to `0` paused.
- Selection never starts playback. **Play** waits for every joined screen to buffer, then schedules a shared start 800 ms ahead.
- Ready/error messages are tied to both operation and media generation, so delayed events from a previous file cannot affect the selected file.
- A late or reconnected display receives the current media selection and position. Controller disconnection pauses the room.
- Readiness times out after 20 seconds instead of waiting forever. A playback failure pauses all screens.
- Small drift is corrected with playback-rate adjustments; large drift uses a seek. This is browser-level synchronization, not frame-locked hardware synchronization.
- Video completion pauses; there is no autoplay-next.

The player **Back** button returns a controller to its application-owned library history and restores its collection, section, sort, and selected-item anchor where possible. Direct player entry or invalid history falls back to the beginning of the controller library. Display presentation remains the player and does not expose library browsing.

## Tests

Run unit and integration tests:

```sh
npm test
```

Run syntax checks directly when changing server or browser scripts:

```sh
node --check index.js
node --check lib/media-catalog.js
node --check lib/sync-room.js
node --check frontend/library.js
node --check frontend/player.js
```

An optional real-Chrome test uses Chrome DevTools directly and adds no package dependency:

```sh
CHROMIUM_PATH=/path/to/chrome BROWSER_TEST_VIDEO=/path/to/playable-30-second-video.mp4 npm run test:browser
```

Without `CHROMIUM_PATH`, the test is skipped. `BROWSER_TEST_VIDEO` must identify a browser-playable video at least 30 seconds long; when omitted, the test uses `videosSource/PinkyAndBrain/1.mp4` only if that local file exists. The test copies the fixture into an isolated temporary catalog and never writes the source asset. Real-screen testing is still recommended for network jitter, codec support, browser autoplay policy, sleep/throttling, and `/mnt` watcher behavior.

## Troubleshooting

- **Library is empty:** confirm files are under `videosSource/`, have a supported extension, are not hidden/symlinked, and wait for settling or press **Refresh**.
- **A copied file stays pending:** finish the copy and leave size/mtime unchanged for at least 30 seconds. Prefer the `.partial` rename workflow.
- **Watcher warning:** discovery continues by polling. **Refresh** requests an immediate full reconciliation.
- **Video does not load:** confirm the file still exists at the cataloged path. Try the same file directly in the target browser; its container may be recognized while its codecs are unsupported.
- **Controller is read-only:** another connected browser owns the controller role. Close it, then reload the intended controller.
- **Screens do not start:** check the connected count and each screen's loading/error message. Fix or disconnect a screen that cannot become ready, then retry.
- **Remote devices cannot connect:** use the server's LAN IP rather than `localhost` and check the host firewall.

## Security

This application has no accounts, login authentication, or TLS. The current controller receives an ephemeral capability that authorizes catalog browsing and Refresh; denied displays cannot browse the library. Catalog IDs are opaque, and `/media/` opens one validated file handle, verifies current-catalog membership, regular-file status, settled size/mtime, symlink absence, and realpath containment, then streams that same handle. Anyone who can reach the service can still stream a known media ID and attempt to claim a free controller role. Use it only on a trusted private LAN. Do not expose it directly to the public Internet.

## Project structure

```text
index.js                 HTTP, media-range, and WebSocket server
lib/media-catalog.js     bounded discovery, settling, metadata, and safe resolution
lib/sync-room.js         authoritative room and media-generation protocol
frontend/library.html    controller library page
frontend/library.js      browsing, refresh, selection, and return context
frontend/index.html      existing player page
frontend/player.js       player synchronization client
frontend/navigation.js   validated player-to-library return behavior
frontend/sync-core.js    clock/drift helpers shared with tests
test/                    unit, integration, and optional browser tests
videosSource/            owner-provided video files
data/                    generated first-discovered metadata (gitignored)
docs/                    approved design and discovery research
```

## Current limitations

There is one room and at most one controller. There are no accounts, playlists, thumbnails, metadata scraping, transcoding, codec conversion, subtitles management, remote storage, or autoplay-next. Discovery is intentionally bounded at 50,000 directory entries and 16 directory levels. Renames and moves are treated as new media paths. Every browser downloads and decodes its own stream, so synchronization quality depends on the slowest device, storage, LAN, and browser behavior.
