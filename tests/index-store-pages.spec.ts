import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { IndexStoreError, openIndexStore } from '../src/index-store/index.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

describe('index state and pages', () => {
  test('sets, overwrites, and deletes state values', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    expect(store.getState('cursor')).toBeUndefined()
    store.setState('cursor', 'one')
    store.setState('cursor', 'two')
    expect(store.getState('cursor')).toBe('two')
    expect(store.deleteState('cursor')).toBe(true)
    expect(store.deleteState('cursor')).toBe(false)
    expect(store.getState('cursor')).toBeUndefined()
    store.close()
  })

  test('inserts, reads, updates, and recognizes unchanged pages', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    const original = makePage()
    expect(store.upsertPage(original)).toBe('inserted')
    expect(store.getPage(original.pageId)).toEqual(original)

    const sameContent = { ...original, indexedAt: '2026-08-14T00:02:00.000Z' }
    expect(store.upsertPage(sameContent)).toBe('unchanged')
    expect(store.getPage(original.pageId)?.indexedAt).toBe(original.indexedAt)

    const updated = {
      ...original,
      title: 'Updated title',
      markdown: 'Updated searchable body',
      contentHash: 'hash-2',
      indexedAt: '2026-08-14T00:03:00.000Z',
    }
    expect(store.upsertPage(updated)).toBe('updated')
    expect(store.getPage(original.pageId)).toEqual(updated)
    expect(store.search({ query: 'Example', limit: 10, snippetChars: 100 })).toEqual([])
    expect(store.search({ query: 'Updated', limit: 10, snippetChars: 100 })).toHaveLength(1)
    store.close()
  })

  test('lists metadata without markdown or internal CJK tokens', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: 'b', markdown: '秘密正文', contentIncomplete: true }))
    store.upsertPage(makePage({ pageId: 'a', title: 'First' }))

    expect(store.countPages()).toBe(2)
    expect(store.listPageMetadata()).toEqual([
      {
        pageId: 'a',
        title: 'First',
        url: 'https://www.notion.so/page-1',
        lastEditedTime: '2026-08-14T00:00:00.000Z',
        contentIncomplete: false,
        contentHash: 'hash-1',
        indexedAt: '2026-08-14T00:01:00.000Z',
      },
      {
        pageId: 'b',
        title: 'Example page',
        url: 'https://www.notion.so/page-1',
        lastEditedTime: '2026-08-14T00:00:00.000Z',
        contentIncomplete: true,
        contentHash: 'hash-1',
        indexedAt: '2026-08-14T00:01:00.000Z',
      },
    ])
    expect(store.getPage('b')).not.toHaveProperty('cjkTokens')
    store.close()
  })

  test('deletes pages and removes their FTS rows', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: 'vanishingword' }))
    expect(store.deletePage('page-1')).toBe(true)
    expect(store.deletePage('page-1')).toBe(false)
    expect(store.getPage('page-1')).toBeUndefined()
    expect(store.search({ query: 'vanishingword', limit: 10, snippetChars: 100 })).toEqual([])
    store.close()
  })

  test('prunes pages atomically and treats an empty keep set as delete all', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    for (const pageId of ['a', 'b', 'c']) {
      store.upsertPage(makePage({ pageId, markdown: `token${pageId}` }))
    }

    expect(store.deletePagesExcept(new Set(['a', 'c']))).toBe(1)
    expect(store.listPageMetadata().map(page => page.pageId)).toEqual(['a', 'c'])
    expect(store.search({ query: 'tokenb', limit: 10, snippetChars: 100 })).toEqual([])
    expect(store.deletePagesExcept(new Set())).toBe(2)
    expect(store.countPages()).toBe(0)
    store.close()
  })

  test('rejects every operation deterministically after close', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.close()
    const operations = [
      () => store.getFormatInfo(),
      () => store.getState('key'),
      () => { store.setState('key', 'value') },
      () => store.deleteState('key'),
      () => store.upsertPage(makePage()),
      () => store.getPage('page-1'),
      () => store.deletePage('page-1'),
      () => store.countPages(),
      () => store.listPageMetadata(),
      () => store.deletePagesExcept(new Set()),
      () => store.search({ query: 'term', limit: 1, snippetChars: 1 }),
      () => store.readPage('page-1', { startLine: 1, maxLines: 1, maxChars: 1 }),
      () => { store.close() },
    ]
    for (const operation of operations) {
      expect(operation).toThrow(
        expect.objectContaining<Partial<IndexStoreError>>({ code: 'index-closed' }),
      )
    }
  })
})
