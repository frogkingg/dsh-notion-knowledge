import type { SQLOutputValue } from 'node:sqlite'
import type { IndexedPage, PageMetadata } from './types.ts'

/** Read a required text field from a durable SQLite row. */
export function rowString(row: Record<string, SQLOutputValue>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`Invalid text in index field ${field}`)
  return value
}

/** Read a required finite number field from a durable SQLite row. */
export function rowNumber(row: Record<string, SQLOutputValue>, field: string): number {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid number in index field ${field}`)
  }
  return value
}

/** Convert one durable row to the public page representation. */
export function rowToPage(row: Record<string, SQLOutputValue>): IndexedPage {
  return {
    pageId: rowString(row, 'page_id'),
    title: rowString(row, 'title'),
    url: rowString(row, 'url'),
    lastEditedTime: rowString(row, 'last_edited_time'),
    markdown: rowString(row, 'markdown'),
    contentIncomplete: rowNumber(row, 'content_incomplete') !== 0,
    contentHash: rowString(row, 'content_hash'),
    indexedAt: rowString(row, 'indexed_at'),
  }
}

/** Convert one durable row to public metadata. */
export function rowToMetadata(row: Record<string, SQLOutputValue>): PageMetadata {
  return {
    pageId: rowString(row, 'page_id'),
    title: rowString(row, 'title'),
    url: rowString(row, 'url'),
    lastEditedTime: rowString(row, 'last_edited_time'),
    contentIncomplete: rowNumber(row, 'content_incomplete') !== 0,
    contentHash: rowString(row, 'content_hash'),
    indexedAt: rowString(row, 'indexed_at'),
  }
}

/** Validate one public positive safe-integer bound. */
export function requirePositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}
