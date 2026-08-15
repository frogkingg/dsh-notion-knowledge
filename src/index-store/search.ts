import type { DatabaseSync } from 'node:sqlite'
import { requirePositiveSafeInteger, rowNumber, rowString } from './rows.ts'
import { tokenizeCjkBigrams, tokenizeSearchWords } from './tokenize.ts'
import type { IndexSearchResult, SearchIndexOptions } from './types.ts'

function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

function unique(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

function buildMatchExpression(words: readonly string[], cjkTokens: readonly string[]): string | undefined {
  const wordExpression = words.map(quoteFtsToken).join(' AND ')
  const cjkExpression = cjkTokens.map(quoteFtsToken).join(' AND ')
  const scopedWordExpression = `{word_title_tokens word_markdown_tokens}:(${wordExpression})`
  const scopedCjkExpression = `{cjk_title_tokens cjk_markdown_tokens}:(${cjkExpression})`
  if (wordExpression !== '' && cjkExpression !== '') {
    return `${scopedWordExpression} AND ${scopedCjkExpression}`
  }
  if (wordExpression !== '') return scopedWordExpression
  if (cjkExpression !== '') return scopedCjkExpression
  return undefined
}

function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

function firstMatchIndex(body: string, tokens: readonly string[]): number {
  let normalized = ''
  const sourceIndexes: number[] = []
  let sourceIndex = 0
  for (const codePoint of body) {
    const folded = foldSearchText(codePoint)
    normalized += folded
    for (let index = 0; index < folded.length; index += 1) sourceIndexes.push(sourceIndex)
    sourceIndex += 1
  }
  let earliest = -1
  for (const token of tokens) {
    const foldedToken = foldSearchText(token)
    const index = normalized.indexOf(foldedToken)
    const originalIndex = index === -1 ? undefined : sourceIndexes[index]
    if (originalIndex !== undefined && (earliest === -1 || originalIndex < earliest)) earliest = originalIndex
  }
  return earliest
}

function makeSnippet(body: string, tokens: readonly string[], maxChars: number): string {
  const codePoints = Array.from(body)
  if (codePoints.length <= maxChars) return body
  const foundIndex = firstMatchIndex(body, tokens)
  const matchIndex = foundIndex === -1 ? 0 : foundIndex
  if (maxChars < 3) return codePoints.slice(matchIndex, matchIndex + maxChars).join('')

  let start = Math.max(0, matchIndex - Math.floor(maxChars / 3))
  let prefix = start > 0
  let available = maxChars - Number(prefix)
  let suffix = start + available < codePoints.length
  available = maxChars - Number(prefix) - Number(suffix)
  if (start + available >= codePoints.length) {
    start = Math.max(0, codePoints.length - available)
    prefix = start > 0
    available = maxChars - Number(prefix)
    suffix = false
  }
  return `${prefix ? '…' : ''}${codePoints.slice(start, start + available).join('')}${suffix ? '…' : ''}`
}

/**
 * Search one open local index using token-only FTS expressions.
 *
 * @param database - configured owned SQLite connection.
 * @param options - query and positive result bounds.
 * @returns ranked hits in deterministic order.
 */
export function searchIndex(database: DatabaseSync, options: SearchIndexOptions): IndexSearchResult[] {
  requirePositiveSafeInteger('limit', options.limit)
  requirePositiveSafeInteger('snippetChars', options.snippetChars)
  const words = unique(tokenizeSearchWords(options.query))
  const cjkTokens = unique(tokenizeCjkBigrams(options.query))
  const match = buildMatchExpression(words, cjkTokens)
  if (match === undefined) return []

  const rows = database.prepare(`
    SELECT
      pages.page_id,
      pages.title,
      pages.url,
      pages.last_edited_time,
      pages.markdown,
      pages.content_incomplete,
      bm25(pages_fts, 0.0, 0.0, 0.0, 5.0, 1.0, 5.0, 1.0) AS rank
    FROM pages_fts
    JOIN pages ON pages.page_id = pages_fts.page_id
    WHERE pages_fts MATCH ?
    ORDER BY rank ASC, pages.page_id ASC
    LIMIT ?
  `).all(match, options.limit)
  const snippetTokens = [...words, ...cjkTokens]
  return rows.map(row => ({
    pageId: rowString(row, 'page_id'),
    title: rowString(row, 'title'),
    url: rowString(row, 'url'),
    snippet: makeSnippet(rowString(row, 'markdown'), snippetTokens, options.snippetChars),
    lastEditedTime: rowString(row, 'last_edited_time'),
    contentIncomplete: rowNumber(row, 'content_incomplete') !== 0,
    rank: rowNumber(row, 'rank'),
  }))
}
