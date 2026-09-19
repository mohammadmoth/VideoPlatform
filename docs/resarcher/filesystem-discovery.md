# Filesystem discovery under WSL and `/mnt/d`

## Conclusion

Use `fs.watch` only to reduce discovery latency. Catalog correctness must come from serialized reconciliation against filesystem scans, reinforced by an adaptive safety scan, pending-file settling, fallback polling, and a manual **Refresh** action. This is especially important when the media root is on `/mnt/d`, a Windows drive accessed through WSL rather than the native Linux filesystem.

## Direct evidence

### Node.js watcher guarantees and caveats

Node documents that `fs.watch` is not fully consistent across platforms, depends on the operating system facility, and can be unreliable or impossible on network filesystems and host filesystems used through virtualization. Node also warns that the event `filename` is not always supplied, even on supported platforms. On Linux and macOS, watching follows an inode; deleting and recreating a path can therefore produce events for the old inode without continuing to report the replacement.

Node's documentation also distinguishes `fs.watch` from `fs.watchFile`: the latter uses stat polling and is slower and less reliable, so it should not be the primary fast path.

**Source:** [Node.js File system API — `fs.watch`](https://nodejs.org/api/fs.html#fswatchfilename-options-listener) (official Node.js documentation).

### WSL mounted-drive boundary

Microsoft documents that fixed Windows drives are mounted below `/mnt` by default (for example, `D:` as `/mnt/d`) and recommends keeping files in the filesystem of the operating system whose tools are being used for the best performance. Thus a Node process running inside WSL and scanning `/mnt/d` crosses the Linux/Windows filesystem boundary.

**Sources:**

- [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems) (official Microsoft WSL documentation).
- [Advanced settings configuration in WSL — automount](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#automount-settings) (official Microsoft documentation of Windows-drive mounting under `/mnt`).

Neither Microsoft source promises reliable watch-event delivery for this application. Combined with Node's explicit virtualization/host-filesystem caveat, this means `/mnt/d` watch behavior must not be treated as a correctness guarantee.

## Interpretation for VideoPlatform

The following are design conclusions from the official constraints, not guarantees quoted from Node or Microsoft:

1. A watch event means “reconcile soon,” not “apply this event as catalog truth.” Missing filenames, duplicate/coalesced events, inode replacement, event ordering, and missed events must all be harmless.
2. A fresh scan is the source of truth for whether a path currently exists and what its current file metadata is.
3. A watcher can improve responsiveness, but periodic and user-triggered reconciliation must be able to repair any divergence without restarting the server.

## Reconciliation design

### Serialized scheduling

- Debounce and coalesce bursts into a reconciliation request.
- Allow only one catalog-mutating reconciliation at a time. If another request arrives, record one follow-up run rather than starting concurrent scans.
- Treat a missing event filename as a request to inspect the applicable watched scope, not as an error.
- Replace/re-establish failed or invalidated watchers where possible; correctness continues through safety scans while they recover.

### Bounded scans

A recursive tree can be large, so a reconciliation must not monopolize the event loop or create unbounded I/O:

- Traverse in bounded batches and yield between batches.
- Limit concurrent filesystem operations.
- Keep scan generations separate: publish a coherent diff only from a completed generation, and queue a follow-up if hints arrive during it.
- Scope an event-driven scan when trustworthy path context is available, but periodically perform a full-root safety scan. Any scoped optimization must be repairable by that full scan.
- Record and surface unreadable paths; do not interpret a transient scan error as proof that all affected media was removed.

Exact batch, concurrency, and timing values should be configurable and validated against representative `/mnt/d` libraries rather than embedded here without measurements.

### Adaptive safety scan and polling fallback

- Run safety reconciliation independently of watch events.
- Use a short interval after activity, overflow-like bursts, errors, or watcher recovery; back off within documented bounds during quiet periods.
- Add jitter if multiple processes could scan the same storage simultaneously.
- If watcher setup fails or repeatedly errors, enter polling mode using the same bounded reconciliation path. Periodically retry watch setup without disabling polling prematurely.
- Watch mode and polling mode feed the same reconciler, preventing two competing catalog implementations.

### Settling copied or growing files

A large copy may become visible before it is playable or complete. New or changed candidates enter a pending state:

- Observe at least size and modification time across separated reconciliation observations.
- Admit a candidate only after its metadata is unchanged for the configured settling condition; a metadata change restarts settling.
- Use bounded retry/backoff and expose long-lived pending/error status rather than waiting forever silently.
- Process each candidate independently so one growing file never blocks stable files or catalog removals.
- Revalidate immediately before publication/opening where practical, because metadata stability reduces risk but cannot prove a writer has closed the file.

### Manual Refresh

The master library provides **Refresh**. It queues a full reconciliation through the same serialized scheduler, works in both watch and polling modes, and reports completion or actionable errors. Refresh is a recovery control, not a substitute for automatic safety scans.

## Persistent ordering interaction

Discovery reconciliation also maintains persistent `firstSeen` ordering. A removed path retains its historical record so restoring the same path restores its original `firstSeen`; rename/move is a new path and receives a new value. On an empty first boot, candidates from the same discovery generation are assigned deterministically using natural path order. Subsequent Added old/new sorts use persisted values, not filesystem timestamps or current scan order.

## Validation matrix

Test on the actual WSL distribution and `/mnt/d`, not only a native Linux temporary directory:

- create a small supported file;
- copy a large file slowly and confirm it remains pending until settled;
- make multiple changes in a burst;
- rename and move files and directories;
- delete and recreate the same path;
- change extension letter case;
- create unsupported files;
- stop/fail the watcher, change files, and verify polling converges;
- make changes during an active scan and verify the queued follow-up converges;
- use Refresh with healthy and failed watchers;
- restart and verify catalog and `firstSeen` persistence.

Assertions should compare the final catalog with a fresh independent filesystem inventory. Event counts or event order are diagnostic only.

### Completed WSL `/mnt/d` validation

On 2026-09-19, Node.js v24.19.0 under WSL2 (`Linux 6.18.33.2-microsoft-standard-WSL2`) was exercised with temporary roots created directly below `/mnt/d/Files/project/`. Both temporary roots and metadata were removed afterward.

The validation observed:

- recursive watching was available, and watcher/safety reconciliation discovered a newly created file without manual Refresh;
- a supported file grown in four 8 MiB writes remained pending at 8, 16, 24, and 32 MiB, then published only after the configured stable interval;
- burst creation, mixed-case `.WEBM`, `.mKv`, and `.MOV`, hidden entries, and an unsupported `.avi` produced the expected inventory;
- rename and move created new `firstSeen` values, moving into a nested folder produced the expected section, deletion removed the item, and restoring the identical path retained its moved-path `firstSeen`;
- a change made during an intentionally delayed scan caused a serialized follow-up generation;
- restart retained metadata ordering;
- manual Refresh succeeded with a healthy watcher;
- an injected watcher setup failure surfaced polling status, automatic safety polling discovered a change, and manual Refresh still succeeded.

A separate deterministic timer test covers adaptive cooldown growth from the configured minimum to its maximum and watcher-free automatic convergence. These observations validate this machine and mount configuration; they are not a portability guarantee for other WSL, Windows, storage, antivirus, or Node.js versions.

## Residual uncertainty

Official documentation establishes that watcher delivery has caveats; it does not quantify failure rates or ideal scan/settling intervals for this machine, drive, library size, Node version, or workload. Those values require local measurement. Antivirus, Windows applications, drive type, and WSL version can materially affect latency.

This study records the guidance used by the implemented discovery system; current operational details are in the repository root README.
