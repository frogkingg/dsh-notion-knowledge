import type { DatabaseSync } from 'node:sqlite'
import { requirePositiveSafeInteger, rowToPage } from './rows.ts'
import type { ReadPageOptions, ReadPageResult } from './types.ts'

function logicalLines(markdown: string): string[] {
  if (markdown === '') return []
  const lines = markdown.split(/\r\n|\r|\n/)
  if (/(?:\r\n|\r|\n)$/.test(markdown)) lines.pop()
  return lines
}

/**
 * Read one bounded line window from an open local index.
 *
 * Line endings normalize to LF. When a single line exceeds the complete
 * character budget, its returned prefix is consumed once and the cursor moves
 * to the next logical line.
 *
 * @param database - configured owned SQLite connection.
 * @param pageId - opaque stored page identifier.
 * @param options - positive line and character bounds.
 * @returns bounded window, or `undefined` when the page is absent.
 */
export function readPageFromIndex(
  database: DatabaseSync,
  pageId: string,
  options: ReadPageOptions,
): ReadPageResult | undefined {
  requirePositiveSafeInteger('startLine', options.startLine)
  requirePositiveSafeInteger('maxLines', options.maxLines)
  requirePositiveSafeInteger('maxChars', options.maxChars)
  const row = database.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId)
  if (row === undefined) return undefined
  const page = rowToPage(row)

  const lines = logicalLines(page.markdown)
  const firstIndex = options.startLine - 1
  const base = {
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    lastEditedTime: page.lastEditedTime,
    contentIncomplete: page.contentIncomplete,
    startLine: options.startLine,
    totalLines: lines.length,
  }
  if (firstIndex >= lines.length) {
    return {
      ...base,
      content: '',
      endLine: lines.length,
      lineTruncated: false,
      characterLimitReached: false,
    }
  }

  const selected: string[] = []
  let index = firstIndex
  let usedCharacters = 0
  let lineTruncated = false
  let characterLimitReached = false
  while (index < lines.length && selected.length < options.maxLines) {
    const line = lines[index]
    if (line === undefined) throw new Error('Logical line index is out of bounds')
    const codePoints = Array.from(line)
    if (codePoints.length > options.maxChars) {
      if (selected.length !== 0) {
        characterLimitReached = true
        break
      }
      selected.push(codePoints.slice(0, options.maxChars).join(''))
      index += 1
      lineTruncated = true
      characterLimitReached = true
      break
    }

    const separatorCharacters = selected.length === 0 ? 0 : 1
    if (usedCharacters + separatorCharacters + codePoints.length > options.maxChars) {
      characterLimitReached = true
      break
    }
    selected.push(line)
    usedCharacters += separatorCharacters + codePoints.length
    index += 1
  }

  const result: ReadPageResult = {
    ...base,
    content: selected.join('\n'),
    endLine: firstIndex + selected.length,
    lineTruncated,
    characterLimitReached,
  }
  if (index < lines.length) result.nextStartLine = index + 1
  return result
}
