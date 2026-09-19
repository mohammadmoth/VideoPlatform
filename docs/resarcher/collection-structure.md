# Collection structure study

## Question

Should seasons be nested below a show collection or represented as sibling collections?

## Compared models

### Nested seasons

Example: `Show/Season 1/Episode 01.mkv`.

- **Advantages:** preserves a show-level collection, scales naturally to more seasons, and uses the existing folder hierarchy without guessing from names.
- **Trade-off:** browsing needs recursive sections and may add one navigation level.

### Sibling season collections

Example: `Show - Season 1/Episode 01.mkv` and `Show - Season 2/Episode 01.mkv`.

- **Advantages:** shallow, simple, and compatible with existing media layouts.
- **Trade-off:** each season is independent; merging them would require fragile naming conventions or additional metadata.

## Decision

Nested seasons are recommended: a direct child of the media root is a collection, and descendant folders are recursive sections within it. Sibling season folders remain fully supported, but each is an independent collection.

There is no name-based merging or relationship inference. Similar prefixes, season-like words, or numbering do not alter structure. This makes the filesystem hierarchy the explicit owner-controlled organization and avoids surprising catalog changes after renames.

Files directly in the media root are placed in **Other**. Supported formats are `.mp4`, `.webm`, `.mkv`, and `.mov`, case-insensitively.

## Consequences

- Owners who want one show collection should move season folders beneath a single show folder.
- Existing sibling layouts continue to work without migration.
- Sections may be arbitrarily nested; the UI should represent their relative folder hierarchy.
- Tests should include ambiguous and similarly named folders to prove that no implicit merging occurs.

This approved design decision is implemented by the current catalog.
