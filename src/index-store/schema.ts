import {
  chmodSync,
  closeSync,
  copyFileSync,
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { IndexFormatInfo } from './types.ts'

/** Four-byte ASCII identifier `DSHN` used to claim this derived index. */
export const INDEX_APPLICATION_ID = 0x4453_484e

/** Current durable SQLite schema version. */
export const INDEX_SCHEMA_VERSION = 1

/** Stable local-index failure categories. */
export type IndexStoreErrorCode = 'foreign-index' | 'invalid-index' | 'index-closed'

/** Error carrying a stable local-index failure category. */
export class IndexStoreError extends Error {
  /** Machine-readable failure category. */
  readonly code: IndexStoreErrorCode

  /**
   * @param code - stable failure category.
   * @param message - actionable description without database content.
   * @param options - optional underlying failure.
   */
  constructor(code: IndexStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IndexStoreError'
    this.code = code
  }
}

const STATE_TABLE_SQL = `
  CREATE TABLE state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT, WITHOUT ROWID
`

const PAGES_TABLE_SQL = `
  CREATE TABLE pages (
    page_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    last_edited_time TEXT NOT NULL,
    markdown TEXT NOT NULL,
    content_incomplete INTEGER NOT NULL CHECK (content_incomplete IN (0, 1)),
    content_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID
`

const PAGES_FTS_SQL = `
  CREATE VIRTUAL TABLE pages_fts USING fts5(
    page_id UNINDEXED,
    title,
    markdown,
    word_title_tokens,
    word_markdown_tokens,
    cjk_title_tokens,
    cjk_markdown_tokens,
    tokenize = 'unicode61'
  )
`

const SCHEMA_SQL = `${STATE_TABLE_SQL};${PAGES_TABLE_SQL};${PAGES_FTS_SQL};`

type ExistingIndexKind = 'empty' | 'owned' | 'rebuild'
type SchemaCompatibility = 'complete' | 'incompatible' | 'fts-unavailable'
interface FileIdentity {
  readonly dev: number
  readonly ino: number
}
interface SidecarIdentity extends FileIdentity {
  readonly isOrdinarySingleLink: boolean
}
type SidecarSnapshot = ReadonlyMap<(typeof SQLITE_SIDECAR_SUFFIXES)[number], SidecarIdentity>

/** Optional callbacks for observing or interrupting safe-install stages. */
export interface IndexDatabaseOpenHooks {
  /** Called after a private replacement passes its SQLite validation. */
  readonly afterReplacementInitialized?: () => void
  /** Called immediately before the final path could be changed. */
  readonly beforeFinalPathMutation?: () => void
  /** Called whenever the store deliberately requests a full SQLite integrity scan. */
  readonly onIntegrityCheck?: () => void
}

const SQLITE_READONLY_ROLLBACK = 776
const SQLITE_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const
const OWNED_SCHEMA_OBJECTS = new Map<string, 'table'>([
  ['pages', 'table'],
  ['pages_fts', 'table'],
  ['pages_fts_config', 'table'],
  ['pages_fts_content', 'table'],
  ['pages_fts_data', 'table'],
  ['pages_fts_docsize', 'table'],
  ['pages_fts_idx', 'table'],
  ['state', 'table'],
])
const IS_POSIX = process.platform !== 'win32'

function headerApplicationId(path: string): number | undefined {
  const header = Buffer.alloc(100)
  const descriptor = openSync(path, 'r')
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return undefined
  } finally {
    closeSync(descriptor)
  }
  if (header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') return undefined
  return header.readInt32BE(68)
}

function pragmaValue(database: DatabaseSync, sql: string): SQLOutputValue {
  const row = database.prepare(sql).get()
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (value === undefined) throw new Error(`SQLite returned no value for ${sql}`)
  return value
}

function pragmaNumber(database: DatabaseSync, sql: string): number {
  const value = pragmaValue(database, sql)
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`SQLite returned a non-integer value for ${sql}`)
  }
  return value
}

function normalizeSchemaSql(value: string): string {
  return value.toLowerCase().replace(/[\s;]+/g, '')
}

function schemaCompatibility(database: DatabaseSync): SchemaCompatibility {
  const objects = database.prepare(`
    SELECT name, type, sql
    FROM sqlite_master
  `).all()
  const byName = new Map(objects.map(row => [String(row.name), row]))
  const state = byName.get('state')
  const pages = byName.get('pages')
  const fts = byName.get('pages_fts')
  const ftsDefinitionMatches = fts?.type === 'table'
    && typeof fts.sql === 'string'
    && normalizeSchemaSql(fts.sql) === normalizeSchemaSql(PAGES_FTS_SQL)
  if (ftsDefinitionMatches) {
    try {
      database.prepare('SELECT rowid FROM pages_fts LIMIT 1').get()
    } catch {
      return 'fts-unavailable'
    }
  }
  if (objects.length !== OWNED_SCHEMA_OBJECTS.size) return 'incompatible'
  for (const [name, type] of OWNED_SCHEMA_OBJECTS) {
    if (byName.get(name)?.type !== type) return 'incompatible'
  }
  if (state?.type !== 'table' || pages?.type !== 'table' || !ftsDefinitionMatches) return 'incompatible'
  if (typeof state.sql !== 'string' || typeof pages.sql !== 'string') return 'incompatible'
  const definitionsMatch = normalizeSchemaSql(state.sql) === normalizeSchemaSql(STATE_TABLE_SQL)
    && normalizeSchemaSql(pages.sql) === normalizeSchemaSql(PAGES_TABLE_SQL)
  return definitionsMatch ? 'complete' : 'incompatible'
}

function hasCompleteSchema(database: DatabaseSync): boolean {
  return schemaCompatibility(database) === 'complete'
}

function assertDatabaseIntegrity(database: DatabaseSync, hooks: IndexDatabaseOpenHooks): void {
  hooks.onIntegrityCheck?.()
  const rows = database.prepare('PRAGMA integrity_check').all()
  const result = rows.length === 1 ? Object.values(rows[0] ?? {})[0] : undefined
  if (result !== 'ok') throw new Error('SQLite integrity check failed')
}

function inspectDatabase(
  database: DatabaseSync,
  path: string,
  checkIntegrity: boolean,
  hooks: IndexDatabaseOpenHooks,
): ExistingIndexKind {
  const applicationId = pragmaNumber(database, 'PRAGMA application_id')
  if (applicationId === 0) {
    const objects = database.prepare('SELECT name FROM sqlite_master LIMIT 1').all()
    if (objects.length === 0) return 'empty'
    throw new IndexStoreError(
      'foreign-index',
      `Refusing to replace an unowned SQLite database at ${JSON.stringify(path)}`,
    )
  }
  if (applicationId !== INDEX_APPLICATION_ID) {
    throw new IndexStoreError(
      'foreign-index',
      `Refusing to replace another application's SQLite database at ${JSON.stringify(path)}`,
    )
  }
  const version = pragmaNumber(database, 'PRAGMA user_version')
  const compatibility = version === INDEX_SCHEMA_VERSION ? schemaCompatibility(database) : 'incompatible'
  const kind = compatibility === 'complete' ? 'owned' : 'rebuild'
  if (checkIntegrity || compatibility === 'incompatible') assertDatabaseIntegrity(database, hooks)
  return kind
}

function isReadonlyRollback(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && Reflect.get(error, 'errcode') === SQLITE_READONLY_ROLLBACK
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

function invalidIndexPath(path: string, detail: string): IndexStoreError {
  return new IndexStoreError('invalid-index', `Unsafe local knowledge index path ${JSON.stringify(path)}: ${detail}`)
}

function fileIdentity(status: Stats): FileIdentity {
  return { dev: status.dev, ino: status.ino }
}

function sameIdentity(status: Stats, expected: FileIdentity): boolean {
  return status.dev === expected.dev && status.ino === expected.ino
}

function assertDirectDirectory(path: string, status: Stats, parent: string): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw invalidIndexPath(parent, `parent component ${JSON.stringify(path)} is not a direct directory`)
  }
}

function assertSafeDirectoryEntry(
  parent: string,
  directory: string,
  status: Stats,
  child: string,
  childStatus?: Stats,
): void {
  if (!IS_POSIX) return
  const currentUid = process.getuid?.()
  if (currentUid === undefined || (status.uid !== 0 && status.uid !== currentUid)) {
    throw invalidIndexPath(
      parent,
      `parent component ${JSON.stringify(directory)} is not owned by root or the current user`,
    )
  }
  if ((status.mode & 0o022) === 0) return
  if ((status.mode & 0o1000) === 0) {
    throw invalidIndexPath(
      parent,
      `parent component ${JSON.stringify(directory)} is writable without the sticky bit`,
    )
  }
  if (childStatus !== undefined && childStatus.uid !== currentUid) {
    throw invalidIndexPath(
      parent,
      `directory entry ${JSON.stringify(child)} in a writable parent is not owned by the current user`,
    )
  }
}

function assertTrustedParent(parent: string, expected?: FileIdentity): FileIdentity {
  const root = parse(parent).root
  const components = parent.slice(root.length).split(sep).filter(component => component !== '')
  let current = root
  let currentStatus = lstatSync(root)
  assertDirectDirectory(root, currentStatus, parent)
  for (const component of components) {
    const child = join(current, component)
    let status: Stats
    try {
      status = lstatSync(child)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      assertSafeDirectoryEntry(parent, current, currentStatus, child)
      mkdirSync(child, { mode: 0o700 })
      status = lstatSync(child)
    }
    assertDirectDirectory(child, status, parent)
    assertSafeDirectoryEntry(parent, current, currentStatus, child, status)
    current = child
    currentStatus = status
  }
  const status = currentStatus
  if (expected !== undefined && !sameIdentity(status, expected)) {
    throw invalidIndexPath(parent, 'parent directory identity changed while opening the index')
  }
  if (IS_POSIX) {
    const currentUid = process.getuid?.()
    if (currentUid === undefined || status.uid !== currentUid) {
      throw invalidIndexPath(parent, 'existing parent directory is not owned by the current user')
    }
    if ((status.mode & 0o022) !== 0) {
      throw invalidIndexPath(parent, 'existing parent directory is group- or world-writable')
    }
  }
  return fileIdentity(status)
}

function assertFinalPathIdentity(path: string, expected: FileIdentity | undefined): void {
  let status: Stats
  try {
    status = lstatSync(path)
  } catch (error) {
    if (expected === undefined && isMissingPath(error)) return
    if (isMissingPath(error)) throw invalidIndexPath(path, 'database disappeared while opening')
    throw error
  }
  if (expected === undefined) throw invalidIndexPath(path, 'database appeared while opening')
  if (!status.isFile() || status.nlink !== 1 || !sameIdentity(status, expected)) {
    throw invalidIndexPath(path, 'database identity changed while opening')
  }
}

function existingFileIdentity(path: string): FileIdentity {
  const status = lstatSync(path)
  if (!status.isFile() || status.nlink !== 1) {
    throw invalidIndexPath(path, 'database must be a regular file with exactly one hard link')
  }
  return fileIdentity(status)
}

function snapshotSidecars(path: string): SidecarSnapshot {
  const snapshot = new Map<(typeof SQLITE_SIDECAR_SUFFIXES)[number], SidecarIdentity>()
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    let status: Stats
    try {
      status = lstatSync(`${path}${suffix}`)
    } catch (error) {
      if (isMissingPath(error)) continue
      throw error
    }
    snapshot.set(suffix, {
      ...fileIdentity(status),
      isOrdinarySingleLink: status.isFile() && status.nlink === 1,
    })
  }
  return snapshot
}

function assertSidecarSnapshot(path: string, expected: SidecarSnapshot, requireOrdinary: boolean): void {
  const current = snapshotSidecars(path)
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const expectedIdentity = expected.get(suffix)
    const currentIdentity = current.get(suffix)
    if (expectedIdentity === undefined && currentIdentity === undefined) continue
    if (expectedIdentity === undefined || currentIdentity === undefined
      || expectedIdentity.dev !== currentIdentity.dev
      || expectedIdentity.ino !== currentIdentity.ino) {
      throw invalidIndexPath(path, `SQLite sidecar ${JSON.stringify(`${path}${suffix}`)} changed while opening`)
    }
    if (requireOrdinary
      && (!expectedIdentity.isOrdinarySingleLink || !currentIdentity.isOrdinarySingleLink)) {
      throw invalidIndexPath(
        path,
        `SQLite sidecar ${JSON.stringify(`${path}${suffix}`)} must be a regular file with one hard link`,
      )
    }
  }
}

function copyOrdinaryFile(source: string, destination: string, required: boolean): boolean {
  let status
  try {
    status = lstatSync(source)
  } catch (error) {
    if (!isMissingPath(error)) throw error
    if (required) throw new Error(`Required SQLite file ${JSON.stringify(source)} disappeared`, { cause: error })
    return false
  }
  if (!status.isFile()) throw new Error(`SQLite recovery source ${JSON.stringify(source)} is not a regular file`)
  copyFileSync(source, destination)
  chmodSync(destination, 0o600)
  return true
}

function removeTemporaryFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }
}

function inspectRecoveredCopy(path: string, hooks: IndexDatabaseOpenHooks): ExistingIndexKind {
  const temporaryDirectory = mkdtempSync(join(dirname(path), '.notion-index-verify-'))
  chmodSync(temporaryDirectory, 0o700)
  const temporaryPath = join(temporaryDirectory, basename(path))
  let database: DatabaseSync | undefined
  try {
    copyOrdinaryFile(path, temporaryPath, true)
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      copyOrdinaryFile(`${path}${suffix}`, `${temporaryPath}${suffix}`, false)
    }
    database = new DatabaseSync(temporaryPath)
    const kind = inspectDatabase(database, path, true, hooks)
    if (kind === 'empty') throw new Error('Recovered SQLite copy lost its owned application id')
    return kind
  } finally {
    database?.close()
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) removeTemporaryFile(`${temporaryPath}${suffix}`)
    removeTemporaryFile(temporaryPath)
    rmdirSync(temporaryDirectory)
  }
}

function classifyExistingIndex(path: string, hooks: IndexDatabaseOpenHooks): ExistingIndexKind {
  const headerId = headerApplicationId(path)
  if (headerId !== undefined && headerId !== 0 && headerId !== INDEX_APPLICATION_ID) {
    throw new IndexStoreError(
      'foreign-index',
      `Refusing to replace another application's SQLite database at ${JSON.stringify(path)}`,
    )
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    return inspectDatabase(database, path, false, hooks)
  } catch (error) {
    if (error instanceof IndexStoreError) throw error
    if (headerId === INDEX_APPLICATION_ID && isReadonlyRollback(error)) {
      try {
        return inspectRecoveredCopy(path, hooks)
      } catch (recoveryError) {
        throw new IndexStoreError(
          'invalid-index',
          `Cannot safely recover the local knowledge index at ${JSON.stringify(path)}`,
          { cause: recoveryError },
        )
      }
    }
    throw new IndexStoreError(
      'invalid-index',
      `Cannot open the local knowledge index at ${JSON.stringify(path)} as SQLite`,
      { cause: error },
    )
  } finally {
    database?.close()
  }
}

function createPrivateFile(path: string): void {
  const descriptor = openSync(path, 'wx', 0o600)
  closeSync(descriptor)
}

/** Remove only sidecars owned by one positively identified derived SQLite index. */
function removeOwnedSidecars(path: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const ownedPath = `${path}${suffix}`
    try {
      lstatSync(ownedPath)
      unlinkSync(ownedPath)
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
  }
}

function assertNoSidecars(path: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      lstatSync(`${path}${suffix}`)
    } catch (error) {
      if (isMissingPath(error)) continue
      throw error
    }
    throw invalidIndexPath(path, `unexpected SQLite sidecar ${JSON.stringify(`${path}${suffix}`)}`)
  }
}

function initializeSchema(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(SCHEMA_SQL)
    database.exec(`PRAGMA application_id = ${String(INDEX_APPLICATION_ID)}`)
    database.exec(`PRAGMA user_version = ${String(INDEX_SCHEMA_VERSION)}`)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Index schema initialization and rollback both failed')
    }
    throw error
  }
}

function configureConnection(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = DELETE')
  database.exec('PRAGMA synchronous = FULL')
}

interface ReplacementDatabase {
  readonly directory: string
  readonly path: string
}

function cleanupTemporaryDatabase(replacement: ReplacementDatabase): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) removeTemporaryFile(`${replacement.path}${suffix}`)
  removeTemporaryFile(replacement.path)
  rmdirSync(replacement.directory)
}

function buildReplacementDatabase(
  path: string,
  parent: string,
  hooks: IndexDatabaseOpenHooks,
): ReplacementDatabase {
  const directory = mkdtempSync(join(parent, '.notion-index-build-'))
  if (IS_POSIX) chmodSync(directory, 0o700)
  const replacement = { directory, path: join(directory, basename(path)) }
  try {
    createPrivateFile(replacement.path)
    const database = new DatabaseSync(replacement.path)
    try {
      configureConnection(database)
      initializeSchema(database)
    } finally {
      database.close()
    }
    const verification = new DatabaseSync(replacement.path, { readOnly: true })
    try {
      if (inspectDatabase(verification, path, true, hooks) !== 'owned') {
        throw new Error('Replacement index did not validate as the current owned schema')
      }
    } finally {
      verification.close()
    }
    hooks.afterReplacementInitialized?.()
    return replacement
  } catch (error) {
    cleanupTemporaryDatabase(replacement)
    throw error
  }
}

/** Return durable ownership identifiers and active safety pragmas. */
export function getIndexFormatInfo(database: DatabaseSync): IndexFormatInfo {
  const synchronous = pragmaNumber(database, 'PRAGMA synchronous')
  const synchronousName = ['off', 'normal', 'full', 'extra'][synchronous] ?? String(synchronous)
  return {
    applicationId: pragmaNumber(database, 'PRAGMA application_id'),
    schemaVersion: pragmaNumber(database, 'PRAGMA user_version'),
    foreignKeys: pragmaNumber(database, 'PRAGMA foreign_keys') === 1,
    journalMode: String(pragmaValue(database, 'PRAGMA journal_mode')).toLowerCase(),
    synchronous: synchronousName,
  }
}

function openConfiguredDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  try {
    configureConnection(database)
    const info = getIndexFormatInfo(database)
    if (info.applicationId !== INDEX_APPLICATION_ID
      || info.schemaVersion !== INDEX_SCHEMA_VERSION
      || !info.foreignKeys
      || info.journalMode !== 'delete'
      || info.synchronous !== 'full'
      || !hasCompleteSchema(database)) {
      throw new Error('The local knowledge index did not open with the required format')
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

/**
 * Open an owned database connection after classifying any existing file.
 *
 * @param path - file-backed SQLite path.
 * @param hooks - optional callbacks around integrity checks and final-path mutation.
 * @returns configured writable connection with the current schema.
 */
export function openIndexDatabase(
  path: string,
  hooks: IndexDatabaseOpenHooks = {},
): DatabaseSync {
  if (path === '' || path === ':memory:') throw new TypeError('index path must be a file path')
  const indexPath = resolve(path)
  const parent = dirname(indexPath)
  const parentIdentity = assertTrustedParent(parent)
  const sidecars = snapshotSidecars(indexPath)
  const finalIdentity = existsSync(indexPath) ? existingFileIdentity(indexPath) : undefined
  const kind = finalIdentity === undefined ? 'empty' : classifyExistingIndex(indexPath, hooks)

  if (kind === 'owned') {
    hooks.beforeFinalPathMutation?.()
    assertTrustedParent(parent, parentIdentity)
    assertFinalPathIdentity(indexPath, finalIdentity)
    assertSidecarSnapshot(indexPath, sidecars, true)
    if (IS_POSIX) chmodSync(indexPath, 0o600)
    return openConfiguredDatabase(indexPath)
  }

  const replacement = buildReplacementDatabase(indexPath, parent, hooks)
  try {
    hooks.beforeFinalPathMutation?.()
    assertTrustedParent(parent, parentIdentity)
    assertFinalPathIdentity(indexPath, finalIdentity)
    assertSidecarSnapshot(indexPath, sidecars, false)
    if (kind === 'rebuild') removeOwnedSidecars(indexPath)
    else assertNoSidecars(indexPath)
    renameSync(replacement.path, indexPath)
  } finally {
    cleanupTemporaryDatabase(replacement)
  }
  if (IS_POSIX) chmodSync(indexPath, 0o600)
  return openConfiguredDatabase(indexPath)
}
