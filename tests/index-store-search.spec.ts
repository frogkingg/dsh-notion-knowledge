import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  openIndexStore,
  tokenizeCjkBigrams,
  tokenizeSearchWords,
} from '../src/index-store/index.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

describe('search tokenization', () => {
  test('creates overlapping CJK bigrams by Unicode code point without crossing run boundaries', () => {
    expect(tokenizeCjkBigrams('知识图谱 abc 搜索 A한글 片 𠮷野')).toEqual([
      '知识',
      '识图',
      '图谱',
      '搜索',
      '한글',
      '𠮷野',
    ])
  })

  test('extracts Latin and numeric words after excluding CJK runs', () => {
    expect(tokenizeSearchWords('中文 Café42 _ NEAR(foo) 版本2')).toEqual([
      'café42',
      'near',
      'foo',
      '2',
    ])
  })

  test('keeps Japanese prolonged sound marks inside CJK runs', () => {
    expect(tokenizeCjkBigrams('ユーザー おーい')).toEqual([
      'ユー',
      'ーザ',
      'ザー',
      'おー',
      'ーい',
    ])
  })

  test('does not join CJK bigrams across ordinary text or punctuation', () => {
    expect(tokenizeCjkBigrams('ユー ABC ザー・おー')).toEqual([
      'ユー',
      'ザー',
      'おー',
    ])
  })
})

describe('local FTS search', () => {
  test('uses AND semantics for English words', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: 'both', markdown: 'alpha beta' }))
    store.upsertPage(makePage({ pageId: 'one', markdown: 'alpha only' }))
    expect(store.search({ query: 'alpha beta', limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['both'])
    store.close()
  })

  test('uses all CJK bigrams and requires both token groups for mixed queries', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: 'both', markdown: 'alpha 企业知识图谱' }))
    store.upsertPage(makePage({ pageId: 'cjk', markdown: '企业知识图谱' }))
    store.upsertPage(makePage({ pageId: 'partial', markdown: 'alpha 知识清单' }))

    expect(store.search({ query: '知识图谱', limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['cjk', 'both'])
    expect(store.search({ query: 'alpha 知识图谱', limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['both'])
    store.close()
  })

  test.each([
    { query: '版本2', content: '版本2 发布说明' },
    { query: '中文ABC', content: '中文ABC 操作手册' },
    { query: '企业Knowledge图谱', content: '企业Knowledge图谱' },
  ])('finds adjacent mixed-script text for $query', ({ query, content }) => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: content }))

    expect(store.search({ query, limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['page-1'])
    store.close()
  })

  test('treats FTS syntax as token input and never as MATCH syntax', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: 'syntax', title: 'title near', markdown: 'alpha' }))
    store.upsertPage(makePage({ pageId: 'prefix-only', markdown: 'alphabet' }))

    expect(store.search({ query: 'title:alpha', limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['syntax'])
    expect(store.search({ query: 'NEAR(alpha)', limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['syntax'])
    for (const query of ['"alpha"', 'alpha*', '(alpha)', '-alpha']) {
      expect(store.search({ query, limit: 10, snippetChars: 100 }).map(row => row.pageId))
        .toEqual(['syntax'])
    }
    expect(store.search({ query: '* " () -', limit: 10, snippetChars: 100 })).toEqual([])
    store.close()
  })

  test('weights title matches above body matches and uses page id as a stable rank tie-break', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: 'title-hit', title: 'quantum', markdown: '' }))
    store.upsertPage(makePage({ pageId: 'body-hit', title: 'other', markdown: 'quantum' }))
    store.upsertPage(makePage({ pageId: 'tie-b', title: 'same', markdown: 'stableterm' }))
    store.upsertPage(makePage({ pageId: 'tie-a', title: 'same', markdown: 'stableterm' }))

    const weighted = store.search({ query: 'quantum', limit: 10, snippetChars: 100 })
    expect(weighted.map(row => row.pageId)).toEqual(['title-hit', 'body-hit'])
    expect(weighted[0]?.rank).toBeLessThan(weighted[1]?.rank ?? Number.NEGATIVE_INFINITY)
    expect(store.search({ query: 'stableterm', limit: 10, snippetChars: 100 }).map(row => row.pageId))
      .toEqual(['tie-a', 'tie-b'])
    store.close()
  })

  test('weights a CJK title match above an equal-length body match', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: 'z-title', title: '知识图谱', markdown: '无关文本' }))
    store.upsertPage(makePage({ pageId: 'a-body', title: '无关文本', markdown: '知识图谱' }))

    const results = store.search({ query: '知识图谱', limit: 10, snippetChars: 100 })
    expect(results.map(row => row.pageId)).toEqual(['z-title', 'a-body'])
    expect(results[0]?.rank).toBeLessThan(results[1]?.rank ?? Number.NEGATIVE_INFINITY)
    store.close()
  })

  test('returns bounded deterministic snippets near a body match and complete result metadata', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({
      pageId: 'snippet',
      title: 'Snippet',
      markdown: '01234567890123456789 needle 9876543210',
      contentIncomplete: true,
    }))

    const result = store.search({ query: 'needle', limit: 1, snippetChars: 12 })
    expect(result).toHaveLength(1)
    expect(Array.from(result[0]?.snippet ?? '')).toHaveLength(12)
    expect(result[0]?.snippet).toContain('needle')
    expect(result[0]).toMatchObject({
      pageId: 'snippet',
      title: 'Snippet',
      url: 'https://www.notion.so/page-1',
      lastEditedTime: '2026-08-14T00:00:00.000Z',
      contentIncomplete: true,
    })
    expect(result[0]?.rank).toEqual(expect.any(Number))
    expect(result[0]).not.toHaveProperty('markdown')
    expect(result[0]).not.toHaveProperty('cjkTokens')
    store.close()
  })

  test('locates snippets using unicode61-compatible diacritic folding', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ markdown: '01234567890123456789 Café 9876543210' }))

    const [result] = store.search({ query: 'cafe', limit: 1, snippetChars: 12 })
    expect(result?.snippet).toContain('Café')
    expect(Array.from(result?.snippet ?? '').length).toBeLessThanOrEqual(12)
    store.close()
  })

  test.each([
    { limit: 0, snippetChars: 1 },
    { limit: 1.5, snippetChars: 1 },
    { limit: Number.MAX_SAFE_INTEGER + 1, snippetChars: 1 },
    { limit: 1, snippetChars: 0 },
    { limit: 1, snippetChars: Number.POSITIVE_INFINITY },
  ])('rejects unsafe search bounds %#', options => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    expect(() => store.search({ query: 'term', ...options })).toThrow(TypeError)
    store.close()
  })
})
