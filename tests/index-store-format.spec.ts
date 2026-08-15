import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  INDEX_APPLICATION_ID,
  INDEX_SCHEMA_VERSION,
  IndexStoreError,
  openIndexStore,
} from '../src/index-store/index.ts'
import { openIndexDatabase } from '../src/index-store/schema.ts'
import { makeTestDirectory, removeTestDirectories } from './index-store.test-helpers.ts'

afterEach(removeTestDirectories)

const IS_POSIX = process.platform !== 'win32'
const testPosix = IS_POSIX ? test : test.skip

function sqliteValue(path: string, sql: string): unknown {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare(sql).get()
  } finally {
    database.close()
  }
}

function createOwnedIncompleteIndex(path: string, version: number): void {
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA application_id = ${String(INDEX_APPLICATION_ID)};
    PRAGMA user_version = ${String(version)};
    CREATE TABLE obsolete(secret TEXT NOT NULL) STRICT;
    INSERT INTO obsolete VALUES ('derived data');
  `)
  database.close()
}

function createOwnedSchemaVariant(path: string, weakTables: boolean, tokenizer: 'unicode61' | 'porter'): void {
  const database = new DatabaseSync(path)
  const tables = weakTables
    ? `
      CREATE TABLE state(key TEXT, value TEXT);
      CREATE TABLE pages(
        page_id TEXT, title TEXT, url TEXT, last_edited_time TEXT, markdown TEXT,
        content_incomplete INTEGER, content_hash TEXT, indexed_at TEXT
      );
    `
    : `
      CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
      CREATE TABLE pages(
        page_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        last_edited_time TEXT NOT NULL,
        markdown TEXT NOT NULL,
        content_incomplete INTEGER NOT NULL CHECK (content_incomplete IN (0, 1)),
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
    `
  database.exec(`
    PRAGMA application_id = ${String(INDEX_APPLICATION_ID)};
    PRAGMA user_version = ${String(INDEX_SCHEMA_VERSION)};
    ${tables}
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      page_id UNINDEXED, title, markdown,
      cjk_title_tokens, cjk_markdown_tokens,
      tokenize = '${tokenizer}'
    );
    INSERT INTO state(key, value) VALUES ('marker', 'stale');
  `)
  database.close()
}

function corruptFtsConfigDefinition(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true })
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'pages_fts_config'").get()
  database.close()
  if (typeof row?.sql !== 'string') throw new Error('FTS config schema SQL is unavailable')
  const corruptedSql = row.sql.replace('(k PRIMARY KEY', '(x PRIMARY KEY')
  if (corruptedSql === row.sql || Buffer.byteLength(corruptedSql) !== Buffer.byteLength(row.sql)) {
    throw new Error('FTS config schema SQL cannot be corrupted without changing its size')
  }
  const file = readFileSync(path)
  const offset = file.indexOf(Buffer.from(row.sql))
  if (offset === -1) throw new Error('FTS config schema SQL is absent from the database file')
  file.set(Buffer.from(corruptedSql), offset)
  writeFileSync(path, file)
}

async function leaveHotRollbackJournal(path: string): Promise<void> {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 1; BEGIN IMMEDIATE');
    database.prepare('UPDATE pages SET title = ? WHERE page_id = ?').run('uncommitted', 'page-1');
    database.prepare('INSERT INTO state(key, value) VALUES (?, ?)').run('pending', 'value');
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  child.stdout.setEncoding('utf8')
  let errors = ''
  child.stderr.on('data', (chunk: string) => { errors += chunk })
  await new Promise<void>((resolve, reject) => {
    let ready = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out creating hot journal: ${errors}`))
    }, 10_000)
    child.stdout.on('data', (chunk: string) => {
      if (!chunk.includes('ready')) return
      ready = true
      child.kill('SIGKILL')
    })
    child.on('exit', (_code, signal) => {
      clearTimeout(timeout)
      if (ready && signal === 'SIGKILL') resolve()
      else reject(new Error(`Journal child exited before ready: ${errors}`))
    })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

describe('index format', () => {
  test('creates a private parent and database with the owned schema and durable pragmas', () => {
    const root = makeTestDirectory()
    const parent = join(root, 'new', 'knowledge')
    const path = join(parent, 'notion.sqlite')

    const store = openIndexStore(path)
    expect(store.getFormatInfo()).toEqual({
      applicationId: INDEX_APPLICATION_ID,
      schemaVersion: INDEX_SCHEMA_VERSION,
      foreignKeys: true,
      journalMode: 'delete',
      synchronous: 'full',
    })
    store.close()

    if (IS_POSIX) {
      expect(statSync(parent).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(sqliteValue(path, 'PRAGMA application_id')).toEqual({ application_id: INDEX_APPLICATION_ID })
    expect(sqliteValue(path, 'PRAGMA user_version')).toEqual({ user_version: INDEX_SCHEMA_VERSION })

    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const objects = database.prepare(`
        SELECT name, type
        FROM sqlite_master
        WHERE name IN ('state', 'pages', 'pages_fts')
        ORDER BY name
      `).all()
      expect(objects).toEqual([
        { name: 'pages', type: 'table' },
        { name: 'pages_fts', type: 'table' },
        { name: 'state', type: 'table' },
      ])
      const fts = database.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'pages_fts'",
      ).get()
      expect(fts?.sql).toMatch(/USING fts5/i)
      expect(fts?.sql).toMatch(/tokenize\s*=\s*'unicode61'/i)
    } finally {
      database.close()
    }
  })

  testPosix('does not chmod an existing parent directory', () => {
    const root = makeTestDirectory()
    const parent = join(root, 'existing')
    mkdirSync(parent, { mode: 0o755 })
    chmodSync(parent, 0o755)
    const store = openIndexStore(join(parent, 'notion.sqlite'))
    store.close()
    expect(statSync(parent).mode & 0o777).toBe(0o755)
  })

  testPosix('rejects a symbolic-link parent without touching its target', () => {
    const root = makeTestDirectory()
    const targetParent = join(root, 'target')
    const linkedParent = join(root, 'linked')
    mkdirSync(targetParent, { mode: 0o700 })
    symlinkSync(targetParent, linkedParent, 'dir')

    expect(() => openIndexStore(join(linkedParent, 'notion.sqlite'))).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(existsSync(join(targetParent, 'notion.sqlite'))).toBe(false)
  })

  testPosix('rejects a group-or-world-writable existing parent', () => {
    const parent = join(makeTestDirectory(), 'shared')
    mkdirSync(parent, { mode: 0o777 })
    chmodSync(parent, 0o777)

    expect(() => openIndexStore(join(parent, 'notion.sqlite'))).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(statSync(parent).mode & 0o777).toBe(0o777)
  })

  testPosix('rejects a private parent below a non-sticky writable ancestor', () => {
    const root = makeTestDirectory()
    const shared = join(root, 'shared')
    const parent = join(shared, 'private')
    const path = join(parent, 'notion.sqlite')
    mkdirSync(shared, { mode: 0o777 })
    chmodSync(shared, 0o777)
    mkdirSync(parent, { mode: 0o700 })

    expect(() => openIndexStore(path)).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(existsSync(path)).toBe(false)
    expect(statSync(shared).mode & 0o777).toBe(0o777)
    expect(statSync(parent).mode & 0o777).toBe(0o700)
  })

  testPosix('does not create a missing parent below a non-sticky writable ancestor', () => {
    const shared = join(makeTestDirectory(), 'shared')
    const missing = join(shared, 'missing')
    mkdirSync(shared, { mode: 0o777 })
    chmodSync(shared, 0o777)

    expect(() => openIndexStore(join(missing, 'knowledge', 'notion.sqlite'))).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(existsSync(missing)).toBe(false)
  })

  testPosix('allows a current-user private parent below a sticky writable ancestor', () => {
    const root = makeTestDirectory()
    const sticky = join(root, 'sticky')
    const parent = join(sticky, 'private')
    const path = join(parent, 'notion.sqlite')
    mkdirSync(sticky, { mode: 0o1777 })
    chmodSync(sticky, 0o1777)
    mkdirSync(parent, { mode: 0o700 })

    const store = openIndexStore(path)
    store.close()

    expect(existsSync(path)).toBe(true)
    expect(statSync(sticky).mode & 0o1777).toBe(0o1777)
    expect(statSync(parent).mode & 0o777).toBe(0o700)
  })

  test('initializes an existing empty SQLite file', () => {
    const path = join(makeTestDirectory(), 'empty.sqlite')
    const database = new DatabaseSync(path)
    database.close()
    if (IS_POSIX) chmodSync(path, 0o644)

    const store = openIndexStore(path)
    expect(store.getFormatInfo().applicationId).toBe(INDEX_APPLICATION_ID)
    store.close()
    if (IS_POSIX) expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('persists across reopen and tightens an owned database file', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const first = openIndexStore(path)
    first.setState('cursor', 'next')
    first.close()
    if (IS_POSIX) chmodSync(path, 0o644)

    const reopened = openIndexStore(path)
    expect(reopened.getState('cursor')).toBe('next')
    if (IS_POSIX) expect(statSync(path).mode & 0o777).toBe(0o600)
    reopened.close()
  })

  testPosix('rejects a multiply linked main database before changing its mode', () => {
    const root = makeTestDirectory()
    const path = join(root, 'notion.sqlite')
    const alias = join(root, 'alias.sqlite')
    const first = openIndexStore(path)
    first.setState('cursor', 'preserve')
    first.close()
    if (IS_POSIX) chmodSync(path, 0o644)
    linkSync(path, alias)
    const before = readFileSync(path)

    expect(() => openIndexStore(path)).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mode & 0o777).toBe(0o644)
    expect(statSync(path).nlink).toBe(2)
  })

  testPosix('rejects a hard-linked current journal before opening the database writable', () => {
    const root = makeTestDirectory()
    const path = join(root, 'notion.sqlite')
    const victim = join(root, 'victim')
    const first = openIndexStore(path)
    first.close()
    writeFileSync(victim, '')
    chmodSync(victim, 0o640)
    linkSync(victim, `${path}-journal`)
    const before = readFileSync(victim)
    const beforeMode = statSync(victim).mode & 0o777
    let error: unknown
    let reopened: ReturnType<typeof openIndexStore> | undefined

    try {
      reopened = openIndexStore(path)
    } catch (caught) {
      error = caught
    } finally {
      reopened?.close()
    }

    expect(error).toEqual(expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }))
    expect(readFileSync(victim)).toEqual(before)
    expect(statSync(victim).mode & 0o777).toBe(beforeMode)
    expect(statSync(victim).nlink).toBe(2)
  })

  testPosix('rejects a current sidecar identity swap after classification', () => {
    const root = makeTestDirectory()
    const path = join(root, 'notion.sqlite')
    const preserved = join(root, 'preserved-journal')
    const first = openIndexStore(path)
    first.close()
    writeFileSync(`${path}-journal`, '')

    expect(() => openIndexDatabase(path, {
      beforeFinalPathMutation() {
        renameSync(`${path}-journal`, preserved)
        writeFileSync(`${path}-journal`, '')
      },
    })).toThrow(expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }))
    expect(existsSync(preserved)).toBe(true)
  })

  testPosix('rejects a final-path identity swap before chmod', () => {
    const root = makeTestDirectory()
    const path = join(root, 'notion.sqlite')
    const preserved = join(root, 'preserved.sqlite')
    const replacement = join(root, 'replacement.sqlite')
    const first = openIndexStore(path)
    first.close()
    if (IS_POSIX) chmodSync(path, 0o644)
    const foreign = new DatabaseSync(replacement)
    foreign.exec('PRAGMA application_id = 305419896; CREATE TABLE customer_data(value TEXT) STRICT;')
    foreign.close()
    chmodSync(replacement, 0o644)
    const foreignBytes = readFileSync(replacement)

    expect(() => openIndexDatabase(path, {
      beforeFinalPathMutation() {
        renameSync(path, preserved)
        renameSync(replacement, path)
      },
    })).toThrow(expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }))
    expect(readFileSync(path)).toEqual(foreignBytes)
    expect(statSync(path).mode & 0o777).toBe(0o644)
    expect(existsSync(preserved)).toBe(true)
  })

  test.each([
    { applicationId: 0x12345678, label: 'another application id' },
    { applicationId: 0, label: 'an unowned user schema' },
  ])('rejects $label without changing content or permissions', ({ applicationId }) => {
    const path = join(makeTestDirectory(), 'foreign.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`
      PRAGMA application_id = ${String(applicationId)};
      CREATE TABLE customer_data(value TEXT NOT NULL) STRICT;
      INSERT INTO customer_data VALUES ('preserve me');
    `)
    database.close()
    if (IS_POSIX) chmodSync(path, 0o644)
    const before = readFileSync(path)
    const beforeMode = IS_POSIX ? statSync(path).mode & 0o777 : undefined

    expect(() => openIndexStore(path)).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'foreign-index' }),
    )
    expect(readFileSync(path)).toEqual(before)
    if (beforeMode !== undefined) expect(statSync(path).mode & 0o777).toBe(beforeMode)

    const preserved = new DatabaseSync(path, { readOnly: true })
    expect(preserved.prepare('SELECT value FROM customer_data').get()).toEqual({ value: 'preserve me' })
    preserved.close()
  })

  test.each([
    { version: 99 },
    { version: INDEX_SCHEMA_VERSION },
  ])('rebuilds an owned incompatible or incomplete version $version database', ({ version }) => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    createOwnedIncompleteIndex(path, version)

    const store = openIndexStore(path)
    expect(store.countPages()).toBe(0)
    expect(store.getState('secret')).toBeUndefined()
    store.close()

    expect(sqliteValue(path, 'PRAGMA user_version')).toEqual({ user_version: INDEX_SCHEMA_VERSION })
    expect(sqliteValue(path, "SELECT count(*) AS count FROM sqlite_master WHERE name = 'obsolete'"))
      .toEqual({ count: 0 })
  })

  test.each([
    {
      label: 'an existing empty SQLite file',
      prepare: (path: string) => {
        const database = new DatabaseSync(path)
        database.close()
        if (IS_POSIX) chmodSync(path, 0o640)
      },
    },
    {
      label: 'an owned incompatible index',
      prepare: (path: string) => {
        createOwnedIncompleteIndex(path, 99)
        if (IS_POSIX) chmodSync(path, 0o640)
      },
    },
  ])('preserves $label when replacement initialization fails', ({ prepare }) => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    prepare(path)
    const before = readFileSync(path)
    const beforeMode = IS_POSIX ? statSync(path).mode & 0o777 : undefined

    expect(() => openIndexDatabase(path, {
      afterReplacementInitialized() {
        throw new Error('injected replacement failure')
      },
    })).toThrow('injected replacement failure')
    expect(readFileSync(path)).toEqual(before)
    if (beforeMode !== undefined) expect(statSync(path).mode & 0o777).toBe(beforeMode)
  })

  test('does not create the final path when new-index initialization fails', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')

    expect(() => openIndexDatabase(path, {
      afterReplacementInitialized() {
        throw new Error('injected replacement failure')
      },
    })).toThrow('injected replacement failure')
    expect(existsSync(path)).toBe(false)
  })

  test('skips full integrity scans for current indexes and scans incompatible and replacement databases', () => {
    const root = makeTestDirectory()
    const currentPath = join(root, 'current.sqlite')
    const first = openIndexStore(currentPath)
    first.close()
    let currentChecks = 0
    const current = openIndexDatabase(currentPath, {
      onIntegrityCheck() {
        currentChecks += 1
      },
    })
    current.close()
    expect(currentChecks).toBe(0)

    const incompatiblePath = join(root, 'incompatible.sqlite')
    createOwnedIncompleteIndex(incompatiblePath, 99)
    let replacementChecks = 0
    const replacement = openIndexDatabase(incompatiblePath, {
      onIntegrityCheck() {
        replacementChecks += 1
      },
    })
    replacement.close()
    expect(replacementChecks).toBe(2)
  })

  test.each([
    { weakTables: true, tokenizer: 'unicode61' as const, label: 'wrong table constraints' },
    { weakTables: false, tokenizer: 'porter' as const, label: 'the porter tokenizer' },
    { weakTables: false, tokenizer: 'unicode61' as const, label: 'missing ordinary-word projections' },
  ])('rebuilds an owned version 1 database with $label', ({ weakTables, tokenizer }) => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    createOwnedSchemaVariant(path, weakTables, tokenizer)

    const store = openIndexStore(path)
    expect(store.getState('marker')).toBeUndefined()
    expect(store.countPages()).toBe(0)
    store.close()
  })

  test('rebuilds an owned version 1 database containing an unknown trigger', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const first = openIndexStore(path)
    first.upsertPage({
      pageId: 'page-1',
      title: 'Derived page',
      url: 'https://www.notion.so/page-1',
      lastEditedTime: '2026-08-14T00:00:00.000Z',
      markdown: 'Derived body',
      contentIncomplete: false,
      contentHash: 'derived',
      indexedAt: '2026-08-14T00:01:00.000Z',
    })
    first.close()
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TRIGGER corrupt_fts AFTER INSERT ON state
      BEGIN
        DELETE FROM pages_fts;
      END;
    `)
    database.close()

    const rebuilt = openIndexStore(path)
    expect(rebuilt.countPages()).toBe(0)
    rebuilt.setState('probe', 'value')
    rebuilt.close()
    expect(sqliteValue(path, "SELECT count(*) AS count FROM sqlite_master WHERE name = 'corrupt_fts'"))
      .toEqual({ count: 0 })
  })

  test('rebuilds an owned version 1 database containing an extra SQLite statistics table', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const first = openIndexStore(path)
    first.setState('marker', 'stale')
    first.close()
    const database = new DatabaseSync(path)
    database.exec('ANALYZE')
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get())
      .toEqual({ name: 'sqlite_stat1' })
    database.close()

    const rebuilt = openIndexStore(path)
    expect(rebuilt.getState('marker')).toBeUndefined()
    rebuilt.close()
  })

  test('rebuilds an owned version 1 database whose FTS shadow definition cannot construct the virtual table', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const first = openIndexStore(path)
    first.setState('marker', 'stale')
    first.close()
    corruptFtsConfigDefinition(path)

    const rebuilt = openIndexStore(path)
    expect(rebuilt.search({ query: 'probe', limit: 1, snippetChars: 10 })).toEqual([])
    expect(rebuilt.getState('marker')).toBeUndefined()
    rebuilt.close()
  })

  test('removes exact SQLite sidecars after read-only classification proves the index incompatible', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    createOwnedIncompleteIndex(path, 99)
    for (const suffix of ['-journal', '-wal', '-shm']) writeFileSync(`${path}${suffix}`, '')

    const store = openIndexStore(path)
    store.close()

    for (const suffix of ['-journal', '-wal', '-shm']) expect(existsSync(`${path}${suffix}`)).toBe(false)
  })

  testPosix('removes a dangling owned journal sidecar during an incompatible rebuild', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    createOwnedIncompleteIndex(path, 99)
    symlinkSync('missing-journal-target', `${path}-journal`)

    const store = openIndexStore(path)
    store.close()

    expect(() => lstatSync(`${path}-journal`)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  test('keeps the owned main database when sidecar removal fails', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    createOwnedIncompleteIndex(path, 99)
    mkdirSync(`${path}-journal`)
    const before = readFileSync(path)
    const beforeMode = IS_POSIX ? statSync(path).mode & 0o777 : undefined

    expect(() => openIndexStore(path)).toThrow()
    expect(readFileSync(path)).toEqual(before)
    if (beforeMode !== undefined) expect(statSync(path).mode & 0o777).toBe(beforeMode)
  })

  test('fails closed when recovery of an owned hot journal exposes main-file corruption', async () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const store = openIndexStore(path)
    store.upsertPage({
      pageId: 'page-1',
      title: 'Large page',
      url: 'https://www.notion.so/page-1',
      lastEditedTime: '2026-08-14T00:00:00.000Z',
      markdown: 'content '.repeat(30_000),
      contentIncomplete: false,
      contentHash: 'large',
      indexedAt: '2026-08-14T00:01:00.000Z',
    })
    store.close()
    await leaveHotRollbackJournal(path)
    expect(existsSync(`${path}-journal`)).toBe(true)

    const corrupted = readFileSync(path)
    const encodedPageSize = corrupted.readUInt16BE(16)
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize
    for (let offset = pageSize; offset < corrupted.length; offset += pageSize) corrupted[offset] = 0
    writeFileSync(path, corrupted)
    if (IS_POSIX) {
      chmodSync(path, 0o640)
      chmodSync(`${path}-journal`, 0o600)
    }
    const beforeMain = readFileSync(path)
    const beforeJournal = readFileSync(`${path}-journal`)
    const beforeMainMode = IS_POSIX ? statSync(path).mode & 0o777 : undefined
    const beforeJournalMode = IS_POSIX ? statSync(`${path}-journal`).mode & 0o777 : undefined

    expect(() => openIndexStore(path)).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(readFileSync(path)).toEqual(beforeMain)
    expect(readFileSync(`${path}-journal`)).toEqual(beforeJournal)
    if (beforeMainMode !== undefined) expect(statSync(path).mode & 0o777).toBe(beforeMainMode)
    if (beforeJournalMode !== undefined) {
      expect(statSync(`${path}-journal`).mode & 0o777).toBe(beforeJournalMode)
    }
  })

  test('recovers an owned hot journal by rolling back uncommitted page and state writes', async () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const first = openIndexStore(path)
    first.upsertPage({
      pageId: 'page-1',
      title: 'Committed title',
      url: 'https://www.notion.so/page-1',
      lastEditedTime: '2026-08-14T00:00:00.000Z',
      markdown: 'Committed body',
      contentIncomplete: false,
      contentHash: 'committed',
      indexedAt: '2026-08-14T00:01:00.000Z',
    })
    first.setState('committed', 'yes')
    first.close()
    await leaveHotRollbackJournal(path)

    const recovered = openIndexStore(path)
    expect(recovered.getPage('page-1')?.title).toBe('Committed title')
    expect(recovered.getState('committed')).toBe('yes')
    expect(recovered.getState('pending')).toBeUndefined()
    recovered.close()
    expect(existsSync(`${path}-journal`)).toBe(false)
  })

  test('does not overwrite corrupt non-SQLite content', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    writeFileSync(path, 'this is not sqlite')
    if (IS_POSIX) chmodSync(path, 0o640)
    const before = readFileSync(path)
    const beforeMode = IS_POSIX ? statSync(path).mode & 0o777 : undefined

    expect(() => openIndexStore(path)).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(readFileSync(path)).toEqual(before)
    if (beforeMode !== undefined) expect(statSync(path).mode & 0o777).toBe(beforeMode)
  })

  test('does not rebuild a corrupt owned version 1 database from its header alone', () => {
    const path = join(makeTestDirectory(), 'notion.sqlite')
    const store = openIndexStore(path)
    store.close()
    const corrupted = readFileSync(path)
    corrupted[100] = 0
    writeFileSync(path, corrupted)
    const before = readFileSync(path)

    expect(() => openIndexStore(path)).toThrow(
      expect.objectContaining<Partial<IndexStoreError>>({ code: 'invalid-index' }),
    )
    expect(readFileSync(path)).toEqual(before)
  })
})
