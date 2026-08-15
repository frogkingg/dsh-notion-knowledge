import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Config,
  NOTION_API_VERSION,
  normalizeRootPage,
  resolveConfig,
  resolveConfigForTest,
} from '../src/index.ts'

describe('Notion knowledge config', () => {
  it('resolves the complete defaults under the DSH home', () => {
    const dshHome = join(process.cwd(), '.test-dsh-home')

    expect(resolveConfig({}, { dshHome })).toEqual({
      credentialRef: 'NOTION_API_KEY',
      rootPages: [],
      indexPath: join(dshHome, 'knowledge', 'notion.sqlite'),
      baseUrl: 'https://api.notion.com',
      staleAfterMinutes: 60,
      maxStaleHours: 24,
      searchMaxResults: 8,
      snippetChars: 600,
      readMaxLines: 200,
      readMaxChars: 30_000,
      maxPageChars: 2_000_000,
      maxCatalogItems: 50_000,
      requestTimeoutMs: 60_000,
      syncConcurrency: 2,
      requestsPerSecond: 3,
    })
    expect(NOTION_API_VERSION).toBe('2026-03-11')
  })

  it('normalizes UUIDs and Notion page URLs, preserving first-seen order', () => {
    const first = '1429989f-e8ac-4eff-bc8f-57f56486db54'
    const second = 'ABCDEF0123456789ABCDEF0123456789'

    expect(resolveConfig({
      rootPages: [
        first.toUpperCase(),
        `https://www.notion.so/${first}`,
        `https://www.notion.so/Enterprise-Knowledge-${first.replaceAll('-', '')}?pvs=4`,
        `https://team.notion.site/Runbook-${second}`,
      ],
    }).rootPages).toEqual([
      first,
      'abcdef01-2345-6789-abcd-ef0123456789',
    ])
    expect(normalizeRootPage(`https://notion.so/${second}`)).toBe(
      'abcdef01-2345-6789-abcd-ef0123456789',
    )
  })

  it.each([
    '1429989f-e8ac4effbc8f57f56486db54',
    'https://www.notion.so/1429989f-e8ac4eff-bc8f-57f56486db54/extra',
    'https://www.notion.so/1429989f-e8ac-4eff-bc8f-57f56486db54-extra',
    'https://www.notion.so/1429989fe8ac4effbc8f57f56486db54-abcdef0123456789abcdef0123456789',
    'https://www.notion.so:443/1429989fe8ac4effbc8f57f56486db54',
  ])('rejects ambiguous or non-canonical root page %j', (rootPage) => {
    expect(() => resolveConfig({ rootPages: [rootPage] })).toThrow(/rootPages/)
  })

  it('reports credentials or an explicit port in a Notion root URL', () => {
    const rootPage = 'https://user:password@www.notion.so/1429989fe8ac4effbc8f57f56486db54'

    expect(() => resolveConfig({ rootPages: [rootPage] })).toThrow(
      `rootPages entry ${JSON.stringify(rootPage)} must not contain credentials or an explicit port`,
    )
  })

  it.each([
    '',
    'not-a-page',
    'https://example.com/1429989fe8ac4effbc8f57f56486db54',
    'http://www.notion.so/1429989fe8ac4effbc8f57f56486db54',
    'https://www.notion.so/no-page-id',
  ])('rejects invalid root page %j', (rootPage) => {
    expect(() => resolveConfig({ rootPages: [rootPage] })).toThrow(/rootPages/)
  })

  it('requires a valid credential reference', () => {
    expect(() => resolveConfig({ credentialRef: 'NOTION-API-KEY' })).toThrow(/credential ref/)
  })

  it.each([
    'staleAfterMinutes',
    'maxStaleHours',
    'searchMaxResults',
    'snippetChars',
    'readMaxLines',
    'readMaxChars',
    'maxPageChars',
    'maxCatalogItems',
    'requestTimeoutMs',
    'syncConcurrency',
    'requestsPerSecond',
  ] as const)('requires %s to be a positive safe integer', (field) => {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => resolveConfig({ [field]: invalid })).toThrow(`${field} must be a positive safe integer`)
    }
  })

  it('requires the stale threshold to be lower than the maximum stale age', () => {
    expect(() => resolveConfig({ staleAfterMinutes: 60, maxStaleHours: 1 })).toThrow(
      'staleAfterMinutes must be lower than maxStaleHours',
    )
    expect(resolveConfig({ staleAfterMinutes: 59, maxStaleHours: 1 })).toMatchObject({
      staleAfterMinutes: 59,
      maxStaleHours: 1,
    })
  })

  it('accepts only HTTPS origins in production parsing', () => {
    expect(resolveConfig({ baseUrl: 'https://gateway.example.com/' }).baseUrl).toBe(
      'https://gateway.example.com',
    )
    expect(() => resolveConfig({ baseUrl: 'http://127.0.0.1:8080' })).toThrow(/baseUrl must use HTTPS/)
    expect(() => resolveConfig({ baseUrl: 'not a URL' })).toThrow(/baseUrl must be an absolute URL/)
  })

  it.each([
    'https://user:password@gateway.example.com',
    'https://gateway.example.com/v1',
    'https://gateway.example.com//',
    'https://gateway.example.com?api=notion',
    'https://gateway.example.com#notion',
  ])('rejects base URLs that are not origins: %s', (baseUrl) => {
    expect(() => resolveConfig({ baseUrl })).toThrow(/baseUrl must be an origin/)
  })

  it('has an explicit test-only parser that permits only loopback HTTP', () => {
    expect(resolveConfigForTest({ baseUrl: 'http://127.0.0.1:8080/' }).baseUrl).toBe(
      'http://127.0.0.1:8080',
    )
    expect(resolveConfigForTest({ baseUrl: 'http://[::1]:8080/' }).baseUrl).toBe(
      'http://[::1]:8080',
    )
    expect(() => resolveConfigForTest({ baseUrl: 'http://192.0.2.1:8080' })).toThrow(
      /test parser allows HTTP only for loopback/,
    )
    expect(() => resolveConfigForTest({ baseUrl: 'http://localhost:8080/v1' })).toThrow(
      /baseUrl must be an origin/,
    )
  })

  it('rejects non-record and unknown configuration before plugin apply', () => {
    class ConfigInstance {
      get kind(): string {
        return 'config-instance'
      }
    }
    const invalidInputs: unknown[] = [
      null,
      [],
      'config',
      new Date(),
      new Map(),
      new ConfigInstance(),
      { allowLoopbackHttp: true },
    ]
    for (const input of invalidInputs) {
      const result = Config['~standard'].validate(input)
      expect(result).toHaveProperty('issues')
    }

    expect(Config['~standard'].validate(Object.create(null) as object)).toHaveProperty('value')
  })
})
