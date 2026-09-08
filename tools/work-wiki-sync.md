# work-wiki local sync companion

The sync companion creates an off-account copy of the complete owner archive. It uses the existing fixed service principal, so the server decides the owner; the CLI cannot choose another tenant.

```sh
export WORKWIKI_API_TOKEN='the same high-entropy value stored as YOPEDIA_SERVICE_TOKEN'
pnpm sync pull /Volumes/EncryptedBackup/work-wiki
```

For recurring snapshots, keep a terminal or service manager running:

```sh
WORKWIKI_SYNC_INTERVAL_MINUTES=360 WORKWIKI_SYNC_KEEP=30 \
  pnpm sync watch /Volumes/EncryptedBackup/work-wiki
```

Restore is deliberately two-step. The first command only verifies checksums and displays collisions. Add `--confirm` after reviewing that preview:

```sh
pnpm sync push /path/to/workwiki-archive.zip --confirm
```

Add `--overwrite` only when existing archive paths should be replaced. The default keeps existing files.

## Sync a local source folder

Preview is local-only and does not upload anything:

```sh
pnpm sync source-preview /Users/me/Documents/Research
```

Review the changed, deleted, and oversized lists, then explicitly confirm the
upload. A private journal named `.workwiki-source-sync.json` records hashes and
accepted job IDs so unchanged files are skipped on later runs.

```sh
pnpm sync source-push /Users/me/Documents/Research --confirm --vault=christianlee--research --tags=local-sync
```

Continuous source watching is opt-in and also requires `--confirm`:

```sh
WORKWIKI_SOURCE_INTERVAL_MINUTES=10 \
  pnpm sync source-watch /Users/me/Documents/Research --confirm --vault=christianlee--research
```

Hidden files, symlinks, and unsupported formats are ignored. Local deletions
are reported but never delete work-wiki pages; removal remains an owner review
action in the app.
