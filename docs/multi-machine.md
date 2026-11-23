# Multi-machine usage

If you work across multiple machines (e.g. a Mac and a Linux PC), you can merge
their usage into one report. Nothing here runs in the background or over the
network: you export a file on one machine, copy it yourself, and merge or
import it on the other.

## Export a snapshot on the other machine

```sh
bun run cli -- snapshot --out ~/Desktop/mac-usage.json
```

Transfer the file to this machine (AirDrop, scp, Syncthing, USB...).

The first export creates a stable machine identity in `~/.config/ai-usage/machine.json`. Rename it for friendlier labels:

```sh
bun run cli -- machine                 # show current id + label
bun run cli -- machine set-label "MacBook Pro"
```

## Merge snapshots into a report

```sh
# Merge a copied snapshot with this machine's local history
bun run cli -- merge ./mac-usage.json --local

# All normal report options work on merged data
bun run cli -- merge ./mac-usage.json --local --since 30d --project meridian --csv
```

Duplicate sessions (same machine, same harness, same session ID) are deduplicated automatically. The newest snapshot wins. The report options are listed in [reports](reports.md#options).

## Import or export stored usage in the web app

The interactive report includes a file-only transfer workspace at `/sync`. Export this machine's stored usage as a JSON merge bundle, copy the file with a tool you trust, then preview the exact insert/update/delete effects. The web stages bounded uploads and sends only an opaque handoff ID; the usage engine revalidates and executes the transfer. A first preview may initialize an empty current-schema private store without inserting usage rows or advancing semantic generation. Previewing an existing store may run migrations, but never imports the peer bundle. Confirmation requires the separately returned document digest and one bounded, versioned, opaque, stateless `confirmationToken` bound to the canonical bundle and relevant logical store state; the web app transports that token without decoding it. If either the selected document or bound store state changed, confirmation returns `preview-stale` and requires a fresh preview. Imports are explicit and bounded; the application does not open a LAN listener or synchronize in the background.

Usage snapshots and merge bundles serve different workflows: `snapshot` plus
`merge` does not import peer snapshot rows into the local store; `snapshot` and
`merge --local` may first collect and publish local usage through the engine.
By contrast, `/sync` imports a merge bundle into the local usage store for
future reports. Both write portable schema version 3. Version-3 files can carry
bounded, credential-free session source-control facts; their rows remain
portable and cannot authorize local prompt reads or provider lookup. Readers
migrate version-1 and version-2 files with source-control context absent.

## See where sessions come from

Merged reports include a `Machine` column (CLI `--wide`, CSV, and dashboard). CSV also includes `machine_id` for scripting.

Projects with the same name from different machines stay separate by default and are displayed with the machine label.
If those folders are intentionally the same project, create a project group under **Analysis › Projects** in the dashboard.

## Group project folders across machines

The same project often lives at different paths on different machines. Project groups let you merge those sources under one native project name for analytics, filtering, CSV, sessions, and the Projects analysis.

Create `~/.config/ai-usage/config.json`:

```json
{
  "projectGroups": [
    {
      "id": "meridian",
      "name": "meridian",
      "sources": [
        { "machineId": "macbook-machine-id", "sourcePath": "/Users/alex/projects/meridian" },
        { "machineId": "linux-machine-id", "sourcePath": "/home/alex/projects/meridian" },
        { "machineId": "macbook-machine-id", "sourcePath": "/Users/alex/projects/meridian2" }
      ]
    }
  ]
}
```

Or use the live dashboard:

```sh
bun run dev
```

Then open **Analysis › Projects**. The UI shows detected project sources with machine labels and sends project-group changes to the usage engine, which updates your local config and publishes a successor revision.

Legacy `projectAliases` are still supported as broad report-time groups, but new dashboard edits write `projectGroups`.
Config stays local to your machine and is never read from the repo.

## Discover project sources

See all project folders across machines to decide which ones to group:

```sh
bun run cli -- projects list --paths ./mac-usage.json --local
```
