import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { IndexStoreError, openIndexStore } from '../src/index-store/index.ts'
import { makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

const foreignOwnedDirectories = vi.hoisted(() => new Set<string>())

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync(path: string | Buffer | URL) {
      const status = actual.lstatSync(path)
      if (!foreignOwnedDirectories.has(String(path))) return status
      return new Proxy(status, {
        get(target, property, receiver) {
          if (property === 'uid') return target.uid === 0 ? 1 : target.uid + 1
          const value: unknown = Reflect.get(target, property, receiver)
          return value
        },
      })
    },
  }
})

afterEach(() => {
  foreignOwnedDirectories.clear()
  removeTestDirectories()
})

const testPosix = process.platform === 'win32' ? test.skip : test

testPosix('rejects a private parent below a sticky directory owned by another user', () => {
  const root = makeTestDirectory()
  const sticky = join(root, 'sticky')
  const parent = join(sticky, 'private')
  const path = join(parent, 'notion.sqlite')
  mkdirSync(sticky, { mode: 0o1777 })
  chmodSync(sticky, 0o1777)
  mkdirSync(parent, { mode: 0o700 })
  foreignOwnedDirectories.add(sticky)

  expect(() => openIndexStore(path)).toThrow(
    expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
  )
  expect(existsSync(path)).toBe(false)
})

testPosix('rejects a private parent below a non-writable directory owned by another user', () => {
  const root = makeTestDirectory()
  const ancestor = join(root, 'ancestor')
  const parent = join(ancestor, 'private')
  const path = join(parent, 'notion.sqlite')
  mkdirSync(ancestor, { mode: 0o755 })
  chmodSync(ancestor, 0o755)
  mkdirSync(parent, { mode: 0o700 })
  foreignOwnedDirectories.add(ancestor)

  expect(() => openIndexStore(path)).toThrow(
    expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
  )
  expect(existsSync(path)).toBe(false)
})
