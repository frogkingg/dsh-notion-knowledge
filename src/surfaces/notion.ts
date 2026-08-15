import type { IndexStore, IndexSearchResult } from '../index-store/index.ts'
import { NotionKnowledgeError } from '../notion/index.ts'

/** One model-visible search hit. */
export interface NotionSearchHit {
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
}

/** Search result returned to the model. */
export interface NotionSearchOutput {
  /** Ranked local hits. */
  results: NotionSearchHit[]
  /** Whether the requested result cap was reached. */
  truncated: boolean
  /** Timestamp of the last successful sync, when known. */
  syncedAt?: string
  /** Whether the local index has exceeded its maximum stale age. */
  stale: boolean
}

/** Bounded local read result returned to the model. */
export interface NotionReadOutput {
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
  /** Last consumed line. */
  endLine: number
  /** Number of logical lines in the stored body. */
  totalLines: number
  /** First unread logical line when another window exists. */
  nextStartLine?: number
  /** Whether one logical line was cut and its unreturned suffix was skipped. */
  lineTruncated: boolean
  /** Whether the character budget stopped or cut this window. */
  characterLimitReached: boolean
  /** Timestamp of the last successful sync, when known. */
  syncedAt?: string
}

/** Determine the number of non-whitespace Unicode characters in a query. */
function nonWhitespaceCount(query: string): number {
  return Array.from(query).filter(character => !/\s/u.test(character)).length
}

/**
 * Search the local Notion index using token-only AND semantics. Invalid
 * queries fail before touching the store, and results never perform a live
 * Notion request.
 *
 * @param store - open local index.
 * @param query - untrusted model query.
 * @param maxResults - maximum returned hits.
 * @param snippetChars - maximum Unicode code points in one snippet.
 * @param syncedAt - last successful sync timestamp, when known.
 * @param stale - whether the index exceeds its maximum stale age.
 * @returns model-visible search output.
 */
export function searchNotionIndex(
  store: IndexStore,
  query: string,
  maxResults: number,
  snippetChars: number,
  syncedAt: string | undefined,
  stale: boolean,
): NotionSearchOutput {
  if (typeof query !== 'string' || nonWhitespaceCount(query) < 2) {
    throw new NotionKnowledgeError('query-invalid', 'notion_search query must contain at least 2 non-whitespace characters')
  }
  const raw = store.search({ query, limit: maxResults + 1, snippetChars })
  const truncated = raw.length > maxResults
  const results = raw.slice(0, maxResults).map(toSearchHit)
  return {
    results,
    truncated,
    ...syncedAt === undefined ? {} : { syncedAt },
    stale,
  }
}

/** Read one bounded local page window without making a live Notion request. */
export function readNotionPage(
  store: IndexStore,
  pageId: string,
  startLine: number,
  maxLines: number,
  maxChars: number,
  syncedAt: string | undefined,
): NotionReadOutput {
  if (typeof pageId !== 'string' || pageId.length === 0) {
    throw new NotionKnowledgeError('page-not-found', 'notion_read requires a non-empty page_id')
  }
  const page = store.readPage(pageId, { startLine, maxLines, maxChars })
  if (page === undefined) throw new NotionKnowledgeError('page-not-found', 'The requested page is not in the local index')
  return {
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    lastEditedTime: page.lastEditedTime,
    contentIncomplete: page.contentIncomplete,
    content: page.content,
    startLine: page.startLine,
    endLine: page.endLine,
    totalLines: page.totalLines,
    ...page.nextStartLine === undefined ? {} : { nextStartLine: page.nextStartLine },
    lineTruncated: page.lineTruncated,
    characterLimitReached: page.characterLimitReached,
    ...syncedAt === undefined ? {} : { syncedAt },
  }
}

function toSearchHit(result: IndexSearchResult): NotionSearchHit {
  return {
    pageId: result.pageId,
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    lastEditedTime: result.lastEditedTime,
    contentIncomplete: result.contentIncomplete,
  }
}
