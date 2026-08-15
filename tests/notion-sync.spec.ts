import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openIndexStore } from '../src/index-store/index.ts'
import {
  type NotionCatalogObject,
  type NotionMarkdownResponse,
  type NotionParentObject,
  type NotionTransport,
  type SyncNotionOptions,
  syncNotionWorkspace,
} from '../src/notion/index.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

const ROOT = '11111111-1111-1111-1111-111111111111'
const CHILD = '22222222-2222-2222-2222-222222222222'
const OUTSIDE = '33333333-3333-3333-3333-333333333333'
const DATA_SOURCE = '44444444-4444-4444-4444-444444444444'

function object(overrides: Partial<NotionCatalogObject> & Pick<NotionCatalogObject, 'id'>): NotionCatalogObject {
  return {
    kind: 'page',
    title: `Page ${overrides.id.slice(0, 4)}`,
    url: `https://www.notion.so/${overrides.id}`,
    lastEditedTime: '2026-08-15T00:00:00.000Z',
    archived: false,
    inTrash: false,
    ...overrides,
  }
}

function markdown(value: string, overrides: Partial<NotionMarkdownResponse> = {}): NotionMarkdownResponse {
  return { markdown: value, truncated: false, unknownBlockIds: [], ...overrides }
}

class FakeTransport implements NotionTransport {
  readonly parents = new Map<string, NotionParentObject>()
  readonly markdowns = new Map<string, NotionMarkdownResponse>()
  private nextMarkdownFailure: string | undefined
  private selfShouldFail = false

  constructor(readonly objects: NotionCatalogObject[], readonly complete = true) {}

  failMarkdownOnce(pageId: string): void {
    this.nextMarkdownFailure = pageId
  }

  failSelfOnce(): void {
    this.selfShouldFail = true
  }

  getSelf(): Promise<Awaited<ReturnType<NotionTransport['getSelf']>>> {
    if (this.selfShouldFail) {
      this.selfShouldFail = false
      return Promise.reject(new Error('provider identity failed'))
    }
    return Promise.resolve({
      workspaceId: 'workspace-1',
      workspaceName: 'Acme',
      principalId: 'user-1',
      principalName: 'Ada',
    })
  }

  listObjects(): Promise<{ objects: NotionCatalogObject[]; complete: boolean }> {
    return Promise.resolve({ objects: this.objects, complete: this.complete })
  }

  getParent(object: NotionCatalogObject): Promise<NotionParentObject | undefined> {
    const parentId = object.parentPageId ?? object.parentDataSourceId ?? object.parentDatabaseId
    return Promise.resolve(parentId === undefined ? undefined : this.parents.get(parentId))
  }

  getMarkdown(pageId: string): Promise<NotionMarkdownResponse> {
    if (this.nextMarkdownFailure === pageId) {
      this.nextMarkdownFailure = undefined
      return Promise.reject(new Error('provider markdown failed'))
    }
    return Promise.resolve(this.markdowns.get(pageId) ?? markdown(`body of ${pageId}`))
  }
}

function options(overrides: Partial<SyncNotionOptions> = {}): SyncNotionOptions {
  return { rootPages: [ROOT], maxCatalogItems: 50_000, maxPageChars: 2_000_000, ...overrides }
}

describe('Notion workspace synchronization', () => {
  test('indexes root descendants and ignores pages outside the configured scope', async () => {
    const root = object({ id: ROOT, title: 'Root' })
    const child = object({ id: CHILD, parentPageId: ROOT, title: 'Child' })
    const outside = object({ id: OUTSIDE, title: 'Outside' })
    const source = object({ id: DATA_SOURCE, kind: 'data_source', parentPageId: ROOT, title: 'Source' })
    const transport = new FakeTransport([root, child, outside, source])
    transport.parents.set(ROOT, { id: ROOT, kind: 'page' })
    transport.markdowns.set(CHILD, markdown('unique child body'))
    transport.markdowns.set(OUTSIDE, markdown('outside body'))

    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    const result = await syncNotionWorkspace(store, transport, 'ntn-token', options())

    expect(result.inserted).toBe(2)
    expect(result.discovered).toBe(4)
    expect(store.listPageMetadata().map(page => page.pageId).sort()).toEqual([ROOT, CHILD])
    expect(store.getPage(CHILD)?.markdown).toBe('unique child body')
    expect(store.getPage(OUTSIDE)).toBeUndefined()
    store.close()
  })

  test('keeps existing pages when provider markdown retrieval fails', async () => {
    const root = object({ id: ROOT, title: 'Root' })
    const child = object({ id: CHILD, parentPageId: ROOT, title: 'Child' })
    const transport = new FakeTransport([root, child])
    transport.parents.set(ROOT, { id: ROOT, kind: 'page' })
    transport.failMarkdownOnce(CHILD)

    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({
      pageId: CHILD,
      title: 'Child',
      url: `https://www.notion.so/${CHILD}`,
      lastEditedTime: '2026-08-14T00:00:00.000Z',
      markdown: 'old body',
      contentHash: 'old-hash',
    }))

    await expect(syncNotionWorkspace(store, transport, 'ntn-token', options()))
      .rejects.toThrow('provider markdown failed')
    expect(store.getPage(CHILD)?.markdown).toBe('old body')
    expect(store.getState('last_success_at')).toBeUndefined()
    store.close()
  })

  test('keeps the previous binding when provider identity verification fails', async () => {
    const root = object({ id: ROOT, title: 'Root' })
    const transport = new FakeTransport([root])
    transport.failSelfOnce()

    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: CHILD, title: 'Old child' }))
    store.setState('active_token_hmac', 'old-binding')
    store.setState('active_scope_fingerprint', 'old-scope')

    await expect(syncNotionWorkspace(store, transport, 'ntn-token', options()))
      .rejects.toThrow('provider identity failed')
    expect(store.getPage(CHILD)?.title).toBe('Old child')
    expect(store.getState('active_token_hmac')).toBe('old-binding')
    store.close()
  })

  test('does not prune existing pages when catalog enumeration is incomplete', async () => {
    const transport = new FakeTransport([object({ id: ROOT, title: 'Root' })], false)
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    store.upsertPage(makePage({ pageId: CHILD, title: 'Old child' }))

    await expect(syncNotionWorkspace(store, transport, 'ntn-token', options()))
      .rejects.toMatchObject({ code: 'catalog-incomplete' })
    expect(store.getPage(CHILD)?.title).toBe('Old child')
    expect(store.getState('last_success_at')).toBeUndefined()
    store.close()
  })
})
