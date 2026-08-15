import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { openIndexStore } from '../src/index-store/index.ts'
import {
  NotionCommandRuntime,
  type NotionTransportFactory,
} from '../src/surfaces/commands.ts'
import type { NotionTransport } from '../src/notion/index.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

const ROOT = '11111111-1111-1111-1111-111111111111'

class EmptyTransport implements NotionTransport {
  constructor(private readonly delayMs = 0) {}

  async getSelf() {
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs))
    return {
      workspaceId: 'workspace-1',
      workspaceName: 'Acme',
      principalId: 'user-1',
      principalName: 'Ada',
    }
  }

  listObjects(): Promise<Awaited<ReturnType<NotionTransport['listObjects']>>> {
    return Promise.resolve({
      objects: [{
        id: ROOT,
        kind: 'page' as const,
        title: 'Root',
        url: `https://www.notion.so/${ROOT}`,
        lastEditedTime: '2026-08-15T00:00:00.000Z',
        archived: false,
        inTrash: false,
      }],
      complete: true,
    })
  }

  getParent(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  getMarkdown(): Promise<{ markdown: string; truncated: boolean; unknownBlockIds: string[] }> {
    return Promise.resolve({ markdown: 'root body', truncated: false, unknownBlockIds: [] })
  }
}

describe('Notion command runtime', () => {
  test('projects configured status without exposing an absolute index path', () => {
    const directory = makeTestDirectory()
    const config = resolveConfig({
      rootPages: [ROOT],
      indexPath: join(directory, 'notion.sqlite'),
    })
    const store = openIndexStore(config.indexPath)
    store.upsertPage(makePage())
    store.setState('active_workspace_name', 'Acme')
    store.setState('last_success_at', '2026-08-15T00:00:00.000Z')

    const runtime = new NotionCommandRuntime({
      store,
      config,
      resolveToken: () => Promise.resolve('ntn-token'),
      transportFactory: () => new EmptyTransport(),
    })
    const result = runtime.status()
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Notion knowledge configured')
    expect(result.text).toContain('Workspace: Acme')
    expect(result.text).not.toContain(directory)
    store.close()
  })

  test('runs one manual sync and reports statistics', async () => {
    const directory = makeTestDirectory()
    const config = resolveConfig({
      rootPages: [ROOT],
      indexPath: join(directory, 'notion.sqlite'),
    })
    const store = openIndexStore(config.indexPath)
    const factory: NotionTransportFactory = () => new EmptyTransport()
    const runtime = new NotionCommandRuntime({
      store,
      config,
      resolveToken: () => Promise.resolve('ntn-token'),
      transportFactory: factory,
    })
    const result = await runtime.runSync()
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Notion sync complete')
    expect(store.countPages()).toBe(1)
    expect(store.getState('active_workspace_id')).toBe('workspace-1')
    store.close()
  })

  test('returns sync-in-progress for a concurrent manual sync', async () => {
    const directory = makeTestDirectory()
    const config = resolveConfig({
      rootPages: [ROOT],
      indexPath: join(directory, 'notion.sqlite'),
    })
    const store = openIndexStore(config.indexPath)
    const runtime = new NotionCommandRuntime({
      store,
      config,
      resolveToken: () => Promise.resolve('ntn-token'),
      transportFactory: () => new EmptyTransport(50),
    })
    const first = runtime.runSync()
    const second = await runtime.runSync()
    expect(second.kind).toBe('error')
    expect(second.text).toContain('sync-in-progress')
    await first
    store.close()
  })
})
