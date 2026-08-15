import { createHmac, randomBytes } from 'node:crypto'
import type { IndexStore } from '../index-store/index.ts'

/** Stable Notion integration failure categories. */
export type NotionKnowledgeErrorCode =
  | 'not-configured'
  | 'credential-missing'
  | 'index-missing'
  | 'index-stale'
  | 'token-changed'
  | 'scope-changed'
  | 'query-invalid'
  | 'page-not-found'
  | 'sync-in-progress'
  | 'catalog-incomplete'
  | 'provider-failed'

/** Error carrying a stable Notion integration failure category. */
export class NotionKnowledgeError extends Error {
  /** Machine-readable failure category. */
  readonly code: NotionKnowledgeErrorCode

  /**
   * @param code - stable failure category.
   * @param message - actionable description without secrets.
   * @param options - optional underlying failure.
   */
  constructor(code: NotionKnowledgeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NotionKnowledgeError'
    this.code = code
  }
}

/** Identity facts returned by `users.me`. */
export interface NotionIdentity {
  /** Notion workspace identifier. */
  workspaceId: string
  /** Display name of the workspace, if present. */
  workspaceName: string | null
  /** Authenticated user or bot identifier. */
  principalId: string
  /** Display name of the authenticated principal, if present. */
  principalName: string | null
}

/** Identity facts associated with the active durable index binding. */
export interface ActiveNotionBinding extends NotionIdentity {
  /** Timestamp of the last fully successful sync. */
  lastSuccessAt: string | undefined
}

/** Pending durable binding computed before provider identity is known. */
export interface PendingNotionBinding {
  /** Salt used for the current token HMAC. */
  salt: Buffer
  /** Hex-encoded salted token HMAC. */
  tokenHmac: string
  /** Durable scope fingerprint for the pending roots. */
  scopeFingerprint: string
  /** Which durable input changed, or `none` when the binding is current. */
  changed: 'none' | 'token-changed' | 'scope-changed'
}

const STATE_SALT = 'binding_salt'
const STATE_TOKEN_HMAC = 'active_token_hmac'
const STATE_SCOPE_FINGERPRINT = 'active_scope_fingerprint'
const STATE_WORKSPACE_ID = 'active_workspace_id'
const STATE_WORKSPACE_NAME = 'active_workspace_name'
const STATE_PRINCIPAL_ID = 'active_principal_id'
const STATE_PRINCIPAL_NAME = 'active_principal_name'
const STATE_LAST_SUCCESS_AT = 'last_success_at'

const DANGEROUS_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const SIGNED_MEDIA_QUERY = /(?:^|[?&])(?:X-Amz-|Credential=|Signature=|token=)/i
const BARE_URL_PATTERN = /https?:\/\/[^\s<>()]+/gi

/** Return a deterministic fingerprint for the canonical, ordered root list. */
function rootScopeFingerprint(rootPages: readonly string[]): string {
  return createHmac('sha256', 'dsh-notion-knowledge:scope:v1')
    .update(rootPages.join('\n'))
    .digest('hex')
}

/** Compute a salted HMAC that identifies a token without storing it. */
function tokenFingerprint(token: string, salt: Buffer): string {
  return createHmac('sha256', salt).update(token).digest('hex')
}

/** Remove every active-binding and freshness state value. */
function clearActiveBinding(store: IndexStore): void {
  store.deletePagesExcept(new Set())
  for (const key of [
    STATE_SALT,
    STATE_TOKEN_HMAC,
    STATE_SCOPE_FINGERPRINT,
    STATE_WORKSPACE_ID,
    STATE_WORKSPACE_NAME,
    STATE_PRINCIPAL_ID,
    STATE_PRINCIPAL_NAME,
    STATE_LAST_SUCCESS_AT,
    'last_failure_at',
  ]) store.deleteState(key)
}

/**
 * Compare the current token and roots against the durable binding. A token or
 * scope change removes every indexed page and all freshness state before the
 * pending binding is returned, so stale content can never be searched after
 * the credential or configured roots change.
 *
 * @param store - open local index.
 * @param token - freshly resolved integration token.
 * @param rootPages - canonical, ordered root page identifiers.
 * @param saltBytes - injectable random salt for deterministic tests.
 * @returns pending binding and which durable input changed.
 */
export function beginIndexBinding(
  store: IndexStore,
  token: string,
  rootPages: readonly string[],
  saltBytes: Buffer = randomBytes(32),
): PendingNotionBinding {
  const scopeFingerprint = rootScopeFingerprint(rootPages)
  const storedSalt = store.getState(STATE_SALT)
  const storedTokenHmac = store.getState(STATE_TOKEN_HMAC)
  const storedScopeFingerprint = store.getState(STATE_SCOPE_FINGERPRINT)

  const salt = storedSalt === undefined ? saltBytes : Buffer.from(storedSalt, 'hex')
  const tokenHmac = tokenFingerprint(token, salt)
  let changed: PendingNotionBinding['changed'] = 'none'
  if (storedTokenHmac === undefined && storedScopeFingerprint === undefined) {
    if (storedSalt !== undefined) changed = 'token-changed'
  } else if (storedTokenHmac !== tokenHmac) {
    changed = 'token-changed'
  } else if (storedScopeFingerprint !== scopeFingerprint) {
    changed = 'scope-changed'
  }

  if (changed !== 'none') {
    clearActiveBinding(store)
    store.setState(STATE_SALT, salt.toString('hex'))
  }
  return { salt, tokenHmac, scopeFingerprint, changed }
}

/**
 * Persist a validated pending binding together with the workspace identity.
 * This is called only after `users.me` succeeded for the same token.
 *
 * @param store - open local index.
 * @param pending - binding produced by {@link beginIndexBinding}.
 * @param identity - provider identity facts.
 * @param lastSuccessAt - timestamp of the completing sync.
 */
export function activateIndexBinding(
  store: IndexStore,
  pending: PendingNotionBinding,
  identity: NotionIdentity,
  lastSuccessAt: string,
): void {
  store.setState(STATE_SALT, pending.salt.toString('hex'))
  store.setState(STATE_TOKEN_HMAC, pending.tokenHmac)
  store.setState(STATE_SCOPE_FINGERPRINT, pending.scopeFingerprint)
  store.setState(STATE_WORKSPACE_ID, identity.workspaceId)
  store.setState(STATE_WORKSPACE_NAME, identity.workspaceName ?? '')
  store.setState(STATE_PRINCIPAL_ID, identity.principalId)
  store.setState(STATE_PRINCIPAL_NAME, identity.principalName ?? '')
  store.setState(STATE_LAST_SUCCESS_AT, lastSuccessAt)
  store.deleteState('last_failure_at')
}

/**
 * Verify that the current token and roots still match the durable binding.
 *
 * @param store - open local index.
 * @param rootPages - canonical, ordered root page identifiers.
 * @param resolveToken - one-shot credential resolver.
 * @returns the active binding identity.
 */
export async function assertActiveIndexBinding(
  store: IndexStore,
  rootPages: readonly string[],
  resolveToken: () => Promise<string | undefined>,
): Promise<ActiveNotionBinding> {
  if (rootPages.length === 0) {
    throw new NotionKnowledgeError('not-configured', 'Configure rootPages before using Notion knowledge')
  }
  const token = await resolveToken()
  if (token === undefined || token.length === 0) {
    throw new NotionKnowledgeError('credential-missing', 'The configured Notion credential is missing')
  }
  const storedTokenHmac = store.getState(STATE_TOKEN_HMAC)
  const storedScopeFingerprint = store.getState(STATE_SCOPE_FINGERPRINT)
  if (storedTokenHmac === undefined || storedScopeFingerprint === undefined) {
    throw new NotionKnowledgeError('index-missing', 'Notion knowledge has not been synchronized yet')
  }
  const saltValue = store.getState(STATE_SALT)
  const salt = saltValue === undefined ? Buffer.alloc(0) : Buffer.from(saltValue, 'hex')
  if (tokenFingerprint(token, salt) !== storedTokenHmac) {
    throw new NotionKnowledgeError('token-changed', 'The Notion credential changed; run /notion-sync again')
  }
  if (rootScopeFingerprint(rootPages) !== storedScopeFingerprint) {
    throw new NotionKnowledgeError('scope-changed', 'The configured root pages changed; run /notion-sync again')
  }
  const workspaceId = store.getState(STATE_WORKSPACE_ID)
  const principalId = store.getState(STATE_PRINCIPAL_ID)
  if (workspaceId === undefined || principalId === undefined) {
    throw new NotionKnowledgeError('index-missing', 'Notion knowledge has not been synchronized yet')
  }
  return {
    workspaceId,
    workspaceName: store.getState(STATE_WORKSPACE_NAME) || null,
    principalId,
    principalName: store.getState(STATE_PRINCIPAL_NAME) || null,
    lastSuccessAt: store.getState(STATE_LAST_SUCCESS_AT),
  }
}

/** Return whether one URL query string carries a signed or credential parameter. */
function hasSignedMediaQuery(search: string): boolean {
  return SIGNED_MEDIA_QUERY.test(search)
}

/**
 * Clean one Notion Markdown body for local indexing. Signed media URLs and
 * URLs carrying credential query parameters are removed in place; dangerous
 * control characters are removed while tabs and newlines survive. The result
 * is capped by Unicode code points without splitting surrogate pairs.
 *
 * @param markdown - provider-supplied Markdown body.
 * @param maxCodePoints - maximum Unicode code points to retain.
 * @returns sanitized body and whether the local cap truncated it.
 */
export function sanitizeNotionMarkdown(markdown: string, maxCodePoints: number): {
  markdown: string
  truncated: boolean
} {
  let cleaned = markdown.replace(DANGEROUS_CONTROL, '')
  cleaned = cleaned.replace(/\[[^\]]*]\(([^)]+)\)/g, (_match, url: string) => (
    hasSignedMediaQuery(url.slice(url.indexOf('?') + 1)) ? '[media URL removed]' : _match
  ))
  cleaned = cleaned.replace(BARE_URL_PATTERN, url => (
    hasSignedMediaQuery(url.slice(url.indexOf('?') + 1)) ? '[media URL removed]' : url
  ))
  const codePoints = Array.from(cleaned)
  if (codePoints.length <= maxCodePoints) return { markdown: cleaned, truncated: false }
  return { markdown: codePoints.slice(0, maxCodePoints).join(''), truncated: true }
}

/** Minimal Notion object categories used by the local synchronization. */
export type NotionObjectKind = 'page' | 'data_source'

/** Normalized Notion page or data source used for scope calculation. */
export interface NotionCatalogObject {
  /** Notion object identifier. */
  id: string
  /** Object category. */
  kind: NotionObjectKind
  /** Display title. */
  title: string
  /** Canonical Notion page URL. */
  url: string
  /** Provider-reported edit timestamp. */
  lastEditedTime: string
  /** Whether the object is currently archived. */
  archived: boolean
  /** Whether the object is currently in the workspace trash. */
  inTrash: boolean
  /** Parent page identifier, when known. */
  parentPageId?: string
  /** Parent data source identifier, when known. */
  parentDataSourceId?: string
  /** Parent database identifier, when known. */
  parentDatabaseId?: string
}

/** Normalized provider parent object used to complete an ancestry chain. */
export interface NotionParentObject {
  /** Notion object identifier. */
  id: string
  /** Parent object category. */
  kind: 'page' | 'database'
  /** Parent page identifier, when known. */
  parentPageId?: string
}

/** Markdown representation returned for one Notion page. */
export interface NotionMarkdownResponse {
  /** Complete or locally truncated Markdown body. */
  markdown: string
  /** Whether the provider truncated the Markdown response. */
  truncated: boolean
  /** Provider-reported identifiers it could not convert to Markdown. */
  unknownBlockIds: readonly string[]
}

/** Read-only Notion provider operations used by the sync engine. */
export interface NotionTransport {
  /** Retrieve the identity behind the current integration token. */
  getSelf(): Promise<NotionIdentity>
  /** Page through every non-archived page and data source visible to the token. */
  listObjects(): Promise<{
    objects: NotionCatalogObject[]
    complete: boolean
  }>
  /** Resolve one parent object or return `undefined` for a workspace root. */
  getParent(object: NotionCatalogObject): Promise<NotionParentObject | undefined>
  /** Retrieve Markdown for one page identifier. */
  getMarkdown(pageId: string): Promise<NotionMarkdownResponse>
}

/** Tunables shared by one synchronization run. */
export interface SyncNotionOptions {
  /** Canonical, ordered root page identifiers. */
  rootPages: readonly string[]
  /** Maximum accepted catalog objects before declaring the catalog incomplete. */
  maxCatalogItems: number
  /** Maximum Unicode code points stored for one page body. */
  maxPageChars: number
}

/** Statistics produced by one completed synchronization. */
export interface SyncNotionResult {
  /** Number of objects discovered in the catalog. */
  discovered: number
  /** Number of pages newly inserted. */
  inserted: number
  /** Number of pages whose content changed. */
  updated: number
  /** Number of pages skipped because their stored content was current. */
  unchanged: number
  /** Number of pages removed after leaving the configured scope. */
  removed: number
  /** Number of pages whose provider Markdown was truncated or unavailable. */
  incomplete: number
}

/** Return a deterministic content digest for one indexed body. */
function contentHash(value: string): string {
  return createHmac('sha256', 'dsh-notion-knowledge:content:v1').update(value).digest('hex')
}

/** Build the public Notion page URL for one object identifier. */
function pageUrl(objectId: string): string {
  return `https://www.notion.so/${objectId.replaceAll('-', '')}`
}

/** Whether one object is the configured root itself or a descendant of it. */
function isInScope(
  object: NotionCatalogObject,
  rootSet: ReadonlySet<string>,
  ancestors: ReadonlySet<string>,
): boolean {
  const parentId = object.parentPageId ?? object.parentDataSourceId ?? object.parentDatabaseId
  return parentId !== undefined && (ancestors.has(parentId) || rootSet.has(parentId))
}

/** Whether a normalized object can still be read from Notion. */
function isAvailableObject(object: NotionCatalogObject): boolean {
  return !object.archived && !object.inTrash
}

/** Collect the page ancestry for one catalog object. */
async function collectAncestors(
  object: NotionCatalogObject,
  transport: NotionTransport,
): Promise<Set<string>> {
  const ancestors = new Set<string>()
  let nextId = object.parentPageId ?? object.parentDataSourceId ?? object.parentDatabaseId
  while (nextId !== undefined) {
    const parent = await transport.getParent({
      id: nextId,
      kind: 'page',
      title: '',
      url: '',
      lastEditedTime: '',
      archived: false,
      inTrash: false,
    })
    if (parent === undefined) break
    const parentId = parent.id
    if (ancestors.has(parentId)) break
    ancestors.add(parentId)
    nextId = parent.parentPageId
  }
  return ancestors
}

/**
 * Synchronize the scoped Notion workspace into the local index. The active
 * binding is only advanced after the catalog is complete and every required
 * page was fetched; any provider failure leaves the previous pages in place.
 *
 * @param store - open local index.
 * @param transport - read-only Notion provider.
 * @param token - freshly resolved integration token.
 * @param options - synchronization tunables.
 * @returns synchronization statistics.
 */
export async function syncNotionWorkspace(
  store: IndexStore,
  transport: NotionTransport,
  token: string,
  options: SyncNotionOptions,
): Promise<SyncNotionResult> {
  const rootSet = new Set(options.rootPages)
  const identity = await transport.getSelf()
  const pending = beginIndexBinding(store, token, options.rootPages)
  const catalog = await transport.listObjects()
  if (!catalog.complete || catalog.objects.length > options.maxCatalogItems) {
    store.deleteState('last_failure_at')
    store.setState('last_failure_at', new Date().toISOString())
    throw new NotionKnowledgeError('catalog-incomplete', 'Notion catalog enumeration was incomplete')
  }
  const available = catalog.objects.filter(isAvailableObject)
  const missingRoots = options.rootPages.filter(root => !available.some(object => object.id === root))
  if (missingRoots.length > 0) {
    store.setState('last_failure_at', new Date().toISOString())
    throw new NotionKnowledgeError('provider-failed', 'A configured root page is unavailable')
  }

  const rootAncestors = new Set<string>()
  for (const object of available) {
    if (rootSet.has(object.id)) rootAncestors.add(object.id)
    for (const ancestor of await collectAncestors(object, transport)) rootAncestors.add(ancestor)
  }
  const scoped = available.filter(object => rootSet.has(object.id) || isInScope(object, rootSet, rootAncestors))

  let inserted = 0
  let updated = 0
  let unchanged = 0
  let incomplete = 0
  const keepPageIds = new Set<string>()
  const now = new Date().toISOString()

  for (const object of scoped) {
    if (object.kind !== 'page') continue
    keepPageIds.add(object.id)
    const existing = store.getPage(object.id)
    if (existing !== undefined
      && existing.lastEditedTime === object.lastEditedTime
      && existing.contentHash !== '') {
      unchanged += 1
      continue
    }
    const markdown = await transport.getMarkdown(object.id)
    const sanitized = sanitizeNotionMarkdown(markdown.markdown, options.maxPageChars)
    const digest = contentHash(sanitized.markdown)
    const contentIncomplete = markdown.truncated
      || sanitized.truncated
      || markdown.unknownBlockIds.length > 0
    if (contentIncomplete) incomplete += 1
    const result = store.upsertPage({
      pageId: object.id,
      title: object.title,
      url: object.url || pageUrl(object.id),
      lastEditedTime: object.lastEditedTime,
      markdown: sanitized.markdown,
      contentIncomplete,
      contentHash: digest,
      indexedAt: now,
    })
    if (result === 'inserted') inserted += 1
    else if (result === 'updated') updated += 1
  }

  const removed = store.deletePagesExcept(keepPageIds)
  activateIndexBinding(store, pending, identity, now)
  return {
    discovered: catalog.objects.length,
    inserted,
    updated,
    unchanged,
    removed,
    incomplete,
  }
}
