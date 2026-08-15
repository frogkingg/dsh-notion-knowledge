import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openIndexStore } from '../src/index-store/index.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

describe('local page reads', () => {
  test('reads a bounded multi-line window with a forward cursor', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: 'one\ntwo\nthree\nfour' }))
    expect(store.readPage('page-1', { startLine: 2, maxLines: 2, maxChars: 100 })).toEqual({
      pageId: 'page-1',
      title: 'Example page',
      url: 'https://www.notion.so/page-1',
      lastEditedTime: '2026-08-14T00:00:00.000Z',
      contentIncomplete: false,
      content: 'two\nthree',
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      nextStartLine: 4,
      lineTruncated: false,
      characterLimitReached: false,
    })
    store.close()
  })

  test('normalizes CRLF and CR line endings and ignores one trailing line terminator', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: 'one\r\ntwo\rthree\nfour\n' }))
    const result = store.readPage('page-1', { startLine: 1, maxLines: 10, maxChars: 100 })
    expect(result?.content).toBe('one\ntwo\nthree\nfour')
    expect(result?.totalLines).toBe(4)
    expect(result?.nextStartLine).toBeUndefined()
    store.close()
  })

  test('returns a deterministic empty window for empty content and starts beyond the page', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: '' }))
    expect(store.readPage('page-1', { startLine: 1, maxLines: 10, maxChars: 100 })).toMatchObject({
      content: '',
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      lineTruncated: false,
      characterLimitReached: false,
    })

    store.upsertPage(makePage({ markdown: 'one\ntwo', contentHash: 'hash-2' }))
    expect(store.readPage('page-1', { startLine: 5, maxLines: 10, maxChars: 100 })).toMatchObject({
      content: '',
      startLine: 5,
      endLine: 2,
      totalLines: 2,
      lineTruncated: false,
      characterLimitReached: false,
    })
    expect(store.readPage('missing', { startLine: 1, maxLines: 1, maxChars: 1 })).toBeUndefined()
    store.close()
  })

  test('enforces both line and character limits at exact boundaries', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: '1234\n5678\n90' }))

    const characters = store.readPage('page-1', { startLine: 1, maxLines: 3, maxChars: 9 })
    expect(characters).toMatchObject({
      content: '1234\n5678',
      endLine: 2,
      nextStartLine: 3,
      lineTruncated: false,
      characterLimitReached: true,
    })
    expect(Array.from(characters?.content ?? '')).toHaveLength(9)

    expect(store.readPage('page-1', { startLine: 1, maxLines: 1, maxChars: 100 })).toMatchObject({
      content: '1234',
      endLine: 1,
      nextStartLine: 2,
      lineTruncated: false,
      characterLimitReached: false,
    })
    store.close()
  })

  test('truncates an overlong logical line once and advances to the next real line', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: 'abcdefghij\nnext' }))

    expect(store.readPage('page-1', { startLine: 1, maxLines: 10, maxChars: 5 })).toMatchObject({
      content: 'abcde',
      startLine: 1,
      endLine: 1,
      nextStartLine: 2,
      lineTruncated: true,
      characterLimitReached: true,
    })
    expect(store.readPage('page-1', { startLine: 2, maxLines: 10, maxChars: 5 })).toMatchObject({
      content: 'next',
      startLine: 2,
      endLine: 2,
      lineTruncated: false,
      characterLimitReached: false,
    })
    store.close()
  })

  test.each([
    { startLine: 0, maxLines: 1, maxChars: 1 },
    { startLine: 1.5, maxLines: 1, maxChars: 1 },
    { startLine: 1, maxLines: 0, maxChars: 1 },
    { startLine: 1, maxLines: 1, maxChars: -1 },
    { startLine: 1, maxLines: 1, maxChars: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects unsafe read bounds %#', options => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    expect(() => store.readPage('page-1', options)).toThrow(TypeError)
    store.close()
  })
})
