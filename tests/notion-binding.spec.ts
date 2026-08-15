import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openIndexStore } from '../src/index-store/index.ts'
import {
  activateIndexBinding,
  assertActiveIndexBinding,
  beginIndexBinding,
  type NotionKnowledgeError,
} from '../src/notion/index.ts'
import { makePage, makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

const ROOT = '11111111-1111-1111-1111-111111111111'
const IDENTITY = {
  workspaceId: 'workspace-1',
  workspaceName: 'Acme',
  principalId: 'user-1',
  principalName: 'Ada',
}

function bindingError(promise: Promise<unknown>): Promise<NotionKnowledgeError> {
  return promise.then(
    () => {
      throw new Error('expected binding assertion to reject')
    },
    (error: unknown) => error as NotionKnowledgeError,
  )
}

describe('Notion index binding', () => {
  test('stores a salted token HMAC without persisting the token', async () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    const token = 'ntn_secret_token_value'
    const pending = beginIndexBinding(store, token, [ROOT], Buffer.alloc(32, 7))
    activateIndexBinding(store, pending, IDENTITY, '2026-08-15T00:00:00.000Z')

    const stateValues = [
      'binding_salt',
      'active_token_hmac',
      'active_scope_fingerprint',
      'active_workspace_id',
      'active_principal_id',
      'active_principal_name',
      'last_success_at',
    ].map(key => store.getState(key)).join('\n')
    expect(stateValues).not.toContain(token)
    expect(store.getState('active_token_hmac')).toMatch(/^[a-f\d]{64}$/)

    await expect(assertActiveIndexBinding(store, [ROOT], () => Promise.resolve(token))).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      principalId: 'user-1',
    })
    store.close()
  })

  test('maps missing configuration, credentials, and successful sync to stable errors', async () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))

    await expect(assertActiveIndexBinding(store, [], () => Promise.resolve('token'))).rejects.toMatchObject({
      code: 'not-configured',
    })
    await expect(assertActiveIndexBinding(store, [ROOT], () => Promise.resolve(undefined))).rejects.toMatchObject({
      code: 'credential-missing',
    })
    await expect(assertActiveIndexBinding(store, [ROOT], () => Promise.resolve('token'))).rejects.toMatchObject({
      code: 'index-missing',
    })
    store.close()
  })

  test('distinguishes token and scope changes without exposing either secret', async () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    const pending = beginIndexBinding(store, 'ntn_original_secret', [ROOT], Buffer.alloc(32, 9))
    activateIndexBinding(store, pending, IDENTITY, '2026-08-15T00:00:00.000Z')

    const tokenError = await bindingError(
      assertActiveIndexBinding(store, [ROOT], () => Promise.resolve('ntn_rotated_secret')),
    )
    expect(tokenError.code).toBe('token-changed')
    expect(String(tokenError)).not.toContain('ntn_original_secret')
    expect(String(tokenError)).not.toContain('ntn_rotated_secret')

    await expect(assertActiveIndexBinding(store, [ROOT.replaceAll('1', '2')], () => Promise.resolve('ntn_original_secret')))
      .rejects.toMatchObject({ code: 'scope-changed' })
    store.close()
  })

  test('clears old pages before a changed token or scope can be synchronized', () => {
    const store = openIndexStore(join(makeTestDirectory(), 'notion.sqlite'))
    const first = beginIndexBinding(store, 'first-token', [ROOT], Buffer.alloc(32, 3))
    activateIndexBinding(store, first, IDENTITY, '2026-08-15T00:00:00.000Z')
    store.upsertPage(makePage())

    const next = beginIndexBinding(store, 'second-token', [ROOT], Buffer.alloc(32, 3))
    expect(next.changed).toBe('token-changed')
    expect(store.countPages()).toBe(0)
    expect(store.getState('last_success_at')).toBeUndefined()
    expect(store.getState('active_token_hmac')).toBeUndefined()
    store.close()
  })
})
