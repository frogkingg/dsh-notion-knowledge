import type { DatabaseSync } from 'node:sqlite'
import { readPageFromIndex } from './read.ts'
import { rowNumber, rowString, rowToMetadata, rowToPage } from './rows.ts'
import { getIndexFormatInfo, IndexStoreError, openIndexDatabase } from './schema.ts'
import { searchIndex } from './search.ts'
import { tokenizeCjkBigrams, tokenizeSearchWords } from './tokenize.ts'
import type {
  IndexedPage,
  IndexFormatInfo,
  IndexSearchResult,
  IndexStore,
  PageMetadata,
  ReadPageOptions,
  ReadPageResult,
  SearchIndexOptions,
  UpsertPageResult,
} from './types.ts'

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Index operation and rollback both failed')
    }
    throw error
  }
}

function pageChanged(previous: IndexedPage, next: IndexedPage): boolean {
  return previous.title !== next.title
    || previous.url !== next.url
    || previous.lastEditedTime !== next.lastEditedTime
    || previous.markdown !== next.markdown
    || previous.contentIncomplete !== next.contentIncomplete
    || previous.contentHash !== next.contentHash
}

function insertFts(database: DatabaseSync, page: IndexedPage): void {
  const wordTitleTokens = tokenizeSearchWords(page.title).join(' ')
  const wordMarkdownTokens = tokenizeSearchWords(page.markdown).join(' ')
  const cjkTitleTokens = tokenizeCjkBigrams(page.title).join(' ')
  const cjkMarkdownTokens = tokenizeCjkBigrams(page.markdown).join(' ')
  database.prepare(`
    INSERT INTO pages_fts(
      page_id, title, markdown,
      word_title_tokens, word_markdown_tokens,
      cjk_title_tokens, cjk_markdown_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    page.pageId,
    page.title,
    page.markdown,
    wordTitleTokens,
    wordMarkdownTokens,
    cjkTitleTokens,
    cjkMarkdownTokens,
  )
}

function deletePageRows(database: DatabaseSync, pageId: string): boolean {
  const result = database.prepare('DELETE FROM pages WHERE page_id = ?').run(pageId)
  database.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId)
  return Number(result.changes) !== 0
}

class SqliteIndexStore implements IndexStore {
  private closed = false

  constructor(private readonly database: DatabaseSync) {}

  private assertOpen(): void {
    if (this.closed) throw new IndexStoreError('index-closed', 'The local knowledge index is closed')
  }

  getFormatInfo(): IndexFormatInfo {
    this.assertOpen()
    return getIndexFormatInfo(this.database)
  }

  getState(key: string): string | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT value FROM state WHERE key = ?').get(key)
    return row === undefined ? undefined : rowString(row, 'value')
  }

  setState(key: string, value: string): void {
    this.assertOpen()
    this.database.prepare(`
      INSERT INTO state(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  deleteState(key: string): boolean {
    this.assertOpen()
    return Number(this.database.prepare('DELETE FROM state WHERE key = ?').run(key).changes) !== 0
  }

  upsertPage(page: IndexedPage): UpsertPageResult {
    this.assertOpen()
    return transaction(this.database, () => {
      const existingRow = this.database.prepare('SELECT * FROM pages WHERE page_id = ?').get(page.pageId)
      if (existingRow !== undefined && !pageChanged(rowToPage(existingRow), page)) return 'unchanged'
      if (existingRow === undefined) {
        this.database.prepare(`
          INSERT INTO pages(
            page_id, title, url, last_edited_time, markdown,
            content_incomplete, content_hash, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          page.pageId,
          page.title,
          page.url,
          page.lastEditedTime,
          page.markdown,
          Number(page.contentIncomplete),
          page.contentHash,
          page.indexedAt,
        )
      } else {
        this.database.prepare(`
          UPDATE pages
          SET title = ?, url = ?, last_edited_time = ?, markdown = ?,
              content_incomplete = ?, content_hash = ?, indexed_at = ?
          WHERE page_id = ?
        `).run(
          page.title,
          page.url,
          page.lastEditedTime,
          page.markdown,
          Number(page.contentIncomplete),
          page.contentHash,
          page.indexedAt,
          page.pageId,
        )
        this.database.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(page.pageId)
      }
      insertFts(this.database, page)
      return existingRow === undefined ? 'inserted' : 'updated'
    })
  }

  getPage(pageId: string): IndexedPage | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId)
    return row === undefined ? undefined : rowToPage(row)
  }

  deletePage(pageId: string): boolean {
    this.assertOpen()
    return transaction(this.database, () => deletePageRows(this.database, pageId))
  }

  countPages(): number {
    this.assertOpen()
    const row = this.database.prepare('SELECT count(*) AS count FROM pages').get()
    if (row === undefined) throw new Error('SQLite returned no page count')
    return rowNumber(row, 'count')
  }

  listPageMetadata(): PageMetadata[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT page_id, title, url, last_edited_time, content_incomplete, content_hash, indexed_at
      FROM pages
      ORDER BY page_id
    `).all().map(rowToMetadata)
  }

  deletePagesExcept(keepPageIds: ReadonlySet<string>): number {
    this.assertOpen()
    return transaction(this.database, () => {
      const rows = this.database.prepare('SELECT page_id FROM pages ORDER BY page_id').all()
      const pageIds = rows.map(row => rowString(row, 'page_id')).filter(pageId => !keepPageIds.has(pageId))
      let deleted = 0
      for (const pageId of pageIds) deleted += Number(deletePageRows(this.database, pageId))
      return deleted
    })
  }

  search(options: SearchIndexOptions): IndexSearchResult[] {
    this.assertOpen()
    return searchIndex(this.database, options)
  }

  readPage(pageId: string, options: ReadPageOptions): ReadPageResult | undefined {
    this.assertOpen()
    return readPageFromIndex(this.database, pageId, options)
  }

  close(): void {
    this.assertOpen()
    this.database.close()
    this.closed = true
  }
}

/**
 * Open or initialize the file-backed local knowledge index.
 *
 * New directories and files are private. Existing owned files are tightened to
 * `0600`; unowned or invalid files are rejected without changing their content
 * or permissions. An owned incompatible format is discarded and rebuilt
 * because it contains only derived data.
 *
 * @param path - SQLite database file path; in-memory databases are not accepted.
 * @returns synchronous local index store.
 * @throws `IndexStoreError` when an existing file cannot safely be claimed.
 */
export function openIndexStore(path: string): IndexStore {
  return new SqliteIndexStore(openIndexDatabase(path))
}
