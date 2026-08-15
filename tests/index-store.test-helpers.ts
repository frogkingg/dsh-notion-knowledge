import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IndexedPage } from '../src/index-store/index.ts'

const testDirectories: string[] = []

/** Create one isolated directory for an index-store test. */
export function makeTestDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-notion-index-'))
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  testDirectories.push(directory)
  return directory
}

/** Remove every directory created by the current test file. */
export function removeTestDirectories(): void {
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
}

/** Build a complete page input with concise per-test overrides. */
export function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
  return {
    pageId: 'page-1',
    title: 'Example page',
    url: 'https://www.notion.so/page-1',
    lastEditedTime: '2026-08-14T00:00:00.000Z',
    markdown: 'Example body',
    contentIncomplete: false,
    contentHash: 'hash-1',
    indexedAt: '2026-08-14T00:01:00.000Z',
    ...overrides,
  }
}
