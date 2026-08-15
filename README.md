# dsh-notion-knowledge

English | [中文](README.zh-CN.md)

`dsh-notion-knowledge` is a DeepSeek Harness bundle for searching and reading enterprise Notion knowledge from the Web profile. Version `0.1.0-rc.1` is a release candidate: configuration and package compatibility may change before `0.1.0`. The bundle keeps a local SQLite index, exposes `notion_search` and `notion_read` tools, and provides `/notion-sync` and `/notion-status` commands. Indexing is read-only and never writes back to Notion.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- A Notion integration token referenced by `credentialRef`

## Install

Install the published bundle into the Web profile:

```sh
dsh plugin --profile web add dsh-notion-knowledge
```

For a local checkout, run the same command with the checkout path. The package declares `dsh.bundle.patch`, so the profile appends its patch after the existing Web bundles.

## Quick Start

1. Store the Notion integration token under the `NOTION_API_KEY` credential reference through the DSH credential UI or environment.
2. Install the bundle into the Web profile:

   ```sh
   dsh plugin --profile web add dsh-notion-knowledge
   ```

3. Configure the `notion-knowledge` row in the profile's `cordis.patch.yml`. Replace the URL below with one root Notion page URL:

   ```yaml
   - id: notion-knowledge
     name: dsh-notion-knowledge
     config:
       credentialRef: NOTION_API_KEY
       rootPages:
         - https://www.notion.so/<workspace>/<page-title>-<page-id>
   ```

4. Start the profile, run `/notion-sync`, then `/notion-status`. Search and read are available to the model immediately after the first successful sync.

## Configuration

The bundle inserts the `notion-knowledge` row with `rootPages: []`. An empty root list is the only unconfigured state: it registers only `/notion-sync` and `/notion-status`. After `rootPages` is configured, the bundle also registers `notion_search`, `notion_read`, and a system-prompt section. Configure the complete row in a later profile patch because Cordis patch entries replace `config` rather than merge individual keys.

| Field | Default | Meaning |
|---|---:|---|
| `credentialRef` | `NOTION_API_KEY` | DSH credential reference for the Notion integration token. |
| `rootPages` | `[]` | Root page UUIDs or HTTPS Notion page URLs; values normalize to unique UUIDs. |
| `indexPath` | `$DSH_HOME/knowledge/notion.sqlite` | Resolved SQLite index path. |
| `baseUrl` | `https://api.notion.com` | Notion API origin; production configuration requires HTTPS. |
| `staleAfterMinutes` | `60` | Age that makes indexed content stale. |
| `maxStaleHours` | `24` | Oldest indexed content that may be served after refresh failure. |
| `searchMaxResults` | `8` | Maximum search results. |
| `snippetChars` | `600` | Maximum characters in a search snippet. |
| `readMaxLines` | `200` | Maximum lines in a read response. |
| `readMaxChars` | `30000` | Maximum characters in a read response. |
| `maxPageChars` | `2000000` | Maximum indexed characters per page. |
| `maxCatalogItems` | `50000` | Maximum items accepted into one catalog. |
| `requestTimeoutMs` | `60000` | Timeout for one Notion API request. |
| `syncConcurrency` | `2` | Concurrent synchronization workers. |
| `requestsPerSecond` | `3` | Aggregate Notion API request rate. |

`baseUrl` is an origin only: credentials, paths, queries, and fragments are rejected. Every numeric field is a positive safe integer. `staleAfterMinutes` must represent fewer seconds than `maxStaleHours`. Invalid configuration stops plugin loading. The package exposes the Notion API version constant `2026-03-11`; the Notion SDK transport uses it for every request.

## Local index development

The package exports `openIndexStore(indexPath)` as a standalone local API. It uses Node's built-in `node:sqlite` module and stores state, page Markdown and metadata, and an FTS5 projection. Page writes, updates, deletion, and full-catalog pruning keep the page and FTS rows in one transaction. Search and bounded line reads use only this local database; they do not call Notion.

The format is owned by SQLite `application_id` `0x4453484e` (`DSHN`) and `user_version` `1`. Every writable connection enables foreign keys and uses the `DELETE` journal with `FULL` synchronization. On POSIX systems, new parent directories use `0700`, database files use `0600`, and an existing final parent must belong to the current user without group or world write permission; an owner-controlled `0755` parent is accepted without chmod. Every parent-path entry must also be protected from rename by a containing directory owned by root or the current user. A group- or world-writable containing directory must additionally have the sticky bit and contain a child owned by the current user. Parent-path symbolic links or junctions, multiply linked database files, and non-regular or multiply linked current SQLite sidecars are rejected. Windows confidentiality relies on the current user's DSH home ACL and host disk encryption such as BitLocker; this RC does not manage Windows ACLs.

An unowned database with schema or data, a different nonzero application ID, and corrupt or non-SQLite content are rejected without changing the file or its permissions. An owned incompatible or incomplete index is rebuilt because it contains only derived data. The replacement is completely initialized and integrity-checked in a same-parent private directory before exact sidecar cleanup and atomic installation; build or installation failure preserves the old main database. A hot rollback journal is recovered and integrity-checked in a private copy before the original file can qualify for opening or rebuilding. Normal current-schema opens validate ownership and the schema object allowlist without a full database scan.

FTS5 uses `unicode61` with store-generated ordinary-word and CJK projections so adjacent text such as `版本2` and `中文ABC` is searchable. CJK bigrams use Unicode Script Extensions for Han, Hiragana, Katakana, and Hangul, retain Japanese prolonged sound marks, and stop at punctuation or ordinary text. Query text is tokenized before a parameterized `MATCH`; raw FTS operators are never accepted. Ordinary tokens and CJK bigrams each use AND semantics, mixed queries require both groups, BM25 applies a `5:1` title-to-body weight, and page ID is the stable tie-break. Returned page records do not expose internal token columns.

The local store does not fetch, sanitize, or authorize Notion content. The synchronization layer owns those provider and scope checks. See [the architecture](docs/architecture.md#local-index) for the current ownership and rebuild rules.

## Notion synchronization

After configuring `rootPages`, run `/notion-sync` to create or refresh the local index. The command resolves the credential from `credentialRef` on every run, verifies the token identity, enumerates pages and data sources, filters to the configured roots and their descendants, and stores sanitized Markdown for new or changed pages. A failed or incomplete catalog never deletes previously indexed pages. `/notion-status` reports local index facts without exposing the token or the absolute index path.

Search and read tools only query the local index. Results and page bodies are normal model-visible content and therefore enter the standard DSH session log. Notion content is data, not instructions; the bundle's prompt asks the model to cite the returned page URL when it uses Notion material.

## Development

```sh
pnpm install
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
```

The npm package contains prebuilt `lib/` artifacts. Installation does not compile TypeScript.

## Roadmap

- Guided setup command (`dsh plugin` or a small initialization script) to replace the manual profile patch with a few prompts.
- Optional real-API acceptance suite that stays skipped without `NOTION_API_KEY` and `NOTION_TEST_ROOT_PAGE`.

## License

[MIT](LICENSE)
