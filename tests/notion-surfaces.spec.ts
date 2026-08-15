import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openIndexStore } from '../src/index-store/index.ts'
import { readNotionPage, searchNotionIndex } from '../src/surfaces/notion.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

function storeWithPages() {
  const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
  store.upsertPage(makePage({
    pageId: 'page-1',
    title: 'First',
    url: 'https://www.notion.so/page-1',
    markdown: 'unique alpha word\nsecond line\nthird line',
    indexedAt: '2026-08-15T00:00:00.000Z',
  }))
  store.upsertPage(makePage({
    pageId: 'page-2',
    title: 'Second',
    url: 'https://www.notion.so/page-2',
    markdown: 'different body',
    indexedAt: '2026-08-15T00:01:00.000Z',
  }))
  return store
}

describe('Notion search and read surfaces', () => {
  test('searches the local index and returns stable model-facing fields', () => {
    const store = storeWithPages()
    const result = searchNotionIndex(store, 'alpha word', 8, 600, '2026-08-15T00:02:00.000Z', false)
    expect(result.results.map(hit => hit.pageId)).toContain('page-1')
    expect(result.results.map(hit => hit.pageId)).not.toContain('page-2')
    expect(result.truncated).toBe(false)
    expect(result.syncedAt).toBe('2026-08-15T00:02:00.000Z')
    expect(result.stale).toBe(false)
    store.close()
  })

  test('rejects queries with fewer than two non-whitespace characters', () => {
    const store = storeWithPages()
    expect(() => searchNotionIndex(store, ' a ', 8, 600, undefined, false)).toThrow(
      expect.objectContaining({ code: 'query-invalid' }),
    )
    store.close()
  })

  test('reads a bounded local page window with pagination metadata', () => {
    const store = storeWithPages()
    const result = readNotionPage(store, 'page-1', 1, 1, 100, '2026-08-15T00:02:00.000Z')
    expect(result.pageId).toBe('page-1')
    expect(result.content).toContain('unique alpha word')
    expect(result.startLine).toBe(1)
    expect(result.endLine).toBe(1)
    expect(result.nextStartLine).toBe(2)
    store.close()
  })

  test('returns page-not-found for an unknown local page', () => {
    const store = storeWithPages()
    expect(() => readNotionPage(store, 'missing', 1, 10, 100, undefined)).toThrow(
      expect.objectContaining({ code: 'page-not-found' }),
    )
    store.close()
  })
})
