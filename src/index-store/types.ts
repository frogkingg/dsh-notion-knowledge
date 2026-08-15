/** Stored representation of one indexed Notion page. */
export interface IndexedPage {
  /** Opaque Notion page identifier. */
  pageId: string
  /** Display title. */
  title: string
  /** Canonical Notion page URL. */
  url: string
  /** Provider-reported edit timestamp. */
  lastEditedTime: string
  /** Searchable Markdown body. */
  markdown: string
  /** Whether the synchronized body was truncated or partially unavailable. */
  contentIncomplete: boolean
  /** Synchronizer-owned digest of the indexed content. */
  contentHash: string
  /** Timestamp at which this representation was indexed. */
  indexedAt: string
}

/** Stored page fields that exclude the potentially large Markdown body. */
export type PageMetadata = Omit<IndexedPage, 'markdown'>

/** Result of an atomic page upsert. */
export type UpsertPageResult = 'inserted' | 'updated' | 'unchanged'

/** Validated bounds for one local full-text query. */
export interface SearchIndexOptions {
  /** Untrusted user query to tokenize without accepting FTS syntax. */
  query: string
  /** Maximum returned rows. */
  limit: number
  /** Maximum Unicode code points in each snippet. */
  snippetChars: number
}

/** One ranked local search hit. */
export interface IndexSearchResult {
  /** Opaque Notion page identifier. */
  pageId: string
  /** Display title. */
  title: string
  /** Canonical Notion page URL. */
  url: string
  /** Deterministic Markdown excerpt near the first matching token. */
  snippet: string
  /** Provider-reported edit timestamp. */
  lastEditedTime: string
  /** Whether the synchronized body was truncated or partially unavailable. */
  contentIncomplete: boolean
  /** SQLite BM25 score; lower values rank first. */
  rank: number
}

/** Validated bounds for one local line-oriented page read. */
export interface ReadPageOptions {
  /** First logical line to return, using one-based numbering. */
  startLine: number
  /** Maximum logical lines to consume. */
  maxLines: number
  /** Maximum Unicode code points in the returned content. */
  maxChars: number
}

/** One bounded local page window. */
export interface ReadPageResult {
  /** Opaque Notion page identifier. */
  pageId: string
  /** Display title. */
  title: string
  /** Canonical Notion page URL. */
  url: string
  /** Provider-reported edit timestamp. */
  lastEditedTime: string
  /** Whether the synchronized body was truncated or partially unavailable. */
  contentIncomplete: boolean
  /** Selected logical lines joined with LF separators. */
  content: string
  /** Requested one-based starting line. */
  startLine: number
  /** Last consumed line, or the total line count for an empty out-of-range window. */
  endLine: number
  /** Number of logical lines in the stored body. */
  totalLines: number
  /** First unread logical line when another window exists. */
  nextStartLine?: number
  /** Whether one logical line was cut and its unreturned suffix was intentionally skipped. */
  lineTruncated: boolean
  /** Whether the character budget stopped or cut this window. */
  characterLimitReached: boolean
}

/** Connection settings and durable ownership identifiers for an open store. */
export interface IndexFormatInfo {
  /** SQLite application identifier owned by this plugin. */
  applicationId: number
  /** Durable schema version. */
  schemaVersion: number
  /** Whether foreign-key enforcement is enabled on this connection. */
  foreignKeys: boolean
  /** Active rollback-journal mode. */
  journalMode: string
  /** Active SQLite synchronous mode. */
  synchronous: string
}

/** Synchronous local index API. Every method throws `index-closed` after close. */
export interface IndexStore {
  /** Return ownership identifiers and active safety pragmas. */
  getFormatInfo(): IndexFormatInfo
  /** Return one state value, or `undefined` when absent. */
  getState(key: string): string | undefined
  /** Durably insert or replace one state value. */
  setState(key: string, value: string): void
  /** Delete one state value and report whether it existed. */
  deleteState(key: string): boolean
  /** Atomically synchronize the page row and its FTS row. */
  upsertPage(page: IndexedPage): UpsertPageResult
  /** Return one complete page, or `undefined` when absent. */
  getPage(pageId: string): IndexedPage | undefined
  /** Atomically delete a page and its FTS row. */
  deletePage(pageId: string): boolean
  /** Return the number of indexed pages. */
  countPages(): number
  /** List page metadata in stable page-id order. */
  listPageMetadata(): PageMetadata[]
  /**
   * Delete every page absent from `keepPageIds` and return the deletion count.
   * An empty set deliberately deletes every page.
   */
  deletePagesExcept(keepPageIds: ReadonlySet<string>): number
  /** Search the local FTS index using token-only AND semantics; invalid bounds throw `TypeError`. */
  search(options: SearchIndexOptions): IndexSearchResult[]
  /** Return one bounded local page window, or `undefined` when absent; invalid bounds throw `TypeError`. */
  readPage(pageId: string, options: ReadPageOptions): ReadPageResult | undefined
  /** Close the connection. Calling this or any other method again throws `index-closed`. */
  close(): void
}
