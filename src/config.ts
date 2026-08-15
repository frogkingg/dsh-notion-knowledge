import { isIP } from 'node:net'
import { join } from 'node:path'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Notion API version required by subsequent client requests. */
export const NOTION_API_VERSION = '2026-03-11'

/** User-facing plugin configuration before defaults are applied. */
export interface Config {
  /** Credential-provider reference used for the Notion integration token. */
  credentialRef?: string
  /** Root Notion page UUIDs or Notion page URLs. */
  rootPages?: string[]
  /** SQLite index file. */
  indexPath?: string
  /** Notion API origin. */
  baseUrl?: string
  /** Age after which reads schedule a refresh. */
  staleAfterMinutes?: number
  /** Maximum age that may still be served when refresh fails. */
  maxStaleHours?: number
  /** Maximum results returned by one search. */
  searchMaxResults?: number
  /** Maximum characters in one search snippet. */
  snippetChars?: number
  /** Maximum lines returned by one read. */
  readMaxLines?: number
  /** Maximum characters returned by one read. */
  readMaxChars?: number
  /** Maximum indexed characters from one page. */
  maxPageChars?: number
  /** Maximum catalog items accepted from one workspace. */
  maxCatalogItems?: number
  /** Timeout for one Notion API request. */
  requestTimeoutMs?: number
  /** Maximum concurrent synchronization workers. */
  syncConcurrency?: number
  /** Aggregate Notion API request rate. */
  requestsPerSecond?: number
}

/** Fully defaulted, normalized configuration supplied to the plugin body. */
export interface ResolvedConfig {
  /** Validated credential-provider reference. */
  credentialRef: CredentialRef
  /** Canonical, de-duplicated Notion page UUIDs. */
  rootPages: string[]
  /** SQLite index file. */
  indexPath: string
  /** Validated Notion API origin. */
  baseUrl: string
  /** Age after which reads schedule a refresh. */
  staleAfterMinutes: number
  /** Maximum age that may still be served when refresh fails. */
  maxStaleHours: number
  /** Maximum results returned by one search. */
  searchMaxResults: number
  /** Maximum characters in one search snippet. */
  snippetChars: number
  /** Maximum lines returned by one read. */
  readMaxLines: number
  /** Maximum characters returned by one read. */
  readMaxChars: number
  /** Maximum indexed characters from one page. */
  maxPageChars: number
  /** Maximum catalog items accepted from one workspace. */
  maxCatalogItems: number
  /** Timeout for one Notion API request. */
  requestTimeoutMs: number
  /** Maximum concurrent synchronization workers. */
  syncConcurrency: number
  /** Aggregate Notion API request rate. */
  requestsPerSecond: number
}

/** Trusted dependencies for deterministic config tests. Not read from Cordis config. */
export interface ResolveConfigOptions {
  /** Explicit Harness home used instead of process-level DSH_HOME resolution. */
  dshHome?: string
}

/** Static defaults whose values do not depend on the resolved Harness home. */
export const DEFAULT_CONFIG = Object.freeze({
  credentialRef: 'NOTION_API_KEY',
  rootPages: Object.freeze([] as string[]),
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

const CONFIG_FIELDS = new Set<keyof Config>([
  'credentialRef',
  'rootPages',
  'indexPath',
  'baseUrl',
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
])

const POSITIVE_INTEGER_FIELDS = [
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
] as const satisfies readonly (keyof ResolvedConfig)[]

const CANONICAL_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const COMPACT_UUID_SOURCE = '[0-9a-f]{32}'
const UUID_PATTERN = new RegExp(`^(?:${CANONICAL_UUID_SOURCE}|${COMPACT_UUID_SOURCE})$`, 'i')
const PAGE_ID_PATTERN = new RegExp(`${CANONICAL_UUID_SOURCE}|${COMPACT_UUID_SOURCE}`, 'gi')
const FINAL_PAGE_ID_PATTERN = new RegExp(
  `(?:^|[^0-9a-f])(${CANONICAL_UUID_SOURCE}|${COMPACT_UUID_SOURCE})$`,
  'i',
)

/** Convert one canonical or 32-hex Notion page id to lowercase UUID spelling. */
function formatPageId(value: string): string {
  const compact = value.replaceAll('-', '').toLowerCase()
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`
    + `-${compact.slice(16, 20)}-${compact.slice(20)}`
}

/** Return whether the source URL contains an explicit port. */
function hasExplicitPort(value: string): boolean {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1]
  if (authority === undefined) return false
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  return host.startsWith('[') ? host.includes(']:') : host.includes(':')
}

/**
 * Normalize one configured root page UUID or Notion-hosted page URL.
 *
 * @param value - canonical UUID, 32-hex UUID, or HTTPS Notion page URL.
 * @returns lowercase, hyphenated page UUID.
 */
export function normalizeRootPage(value: string): string {
  if (UUID_PATTERN.test(value)) return formatPageId(value)

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`rootPages entry ${JSON.stringify(value)} must be a UUID or Notion page URL`)
  }
  const hostname = url.hostname.toLowerCase()
  const notionHost = hostname === 'notion.so' || hostname.endsWith('.notion.so')
    || hostname === 'notion.site' || hostname.endsWith('.notion.site')
  if (url.protocol !== 'https:' || !notionHost) {
    throw new TypeError(`rootPages entry ${JSON.stringify(value)} must be an HTTPS Notion page URL`)
  }
  if (url.username !== '' || url.password !== '' || hasExplicitPort(value)) {
    throw new TypeError(
      `rootPages entry ${JSON.stringify(value)} must not contain credentials or an explicit port`,
    )
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    throw new TypeError(`rootPages entry ${JSON.stringify(value)} has an invalid encoded path`)
  }
  const segments = pathname.split('/').filter(segment => segment.length > 0)
  const lastSegment = segments.at(-1)
  const occurrences = pathname.match(PAGE_ID_PATTERN) ?? []
  const finalMatch = lastSegment?.match(FINAL_PAGE_ID_PATTERN)
  if (occurrences.length !== 1 || finalMatch?.[1] === undefined) {
    throw new TypeError(`rootPages entry ${JSON.stringify(value)} must end with exactly one Notion page UUID`)
  }
  return formatPageId(finalMatch[1])
}

/** Validate the top-level config value and reject fields this version does not own. */
function parseConfigObject(value: unknown): Config {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('config must be a plain record')
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('config must be a plain record')
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(key as keyof Config)) throw new TypeError(`unknown config field ${JSON.stringify(key)}`)
  }
  return value
}

/** Validate and normalize the configured root list. */
function resolveRootPages(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('rootPages must be an array')
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new TypeError('rootPages entries must be strings')
    const normalized = normalizeRootPage(entry)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/** Return whether a URL hostname is an explicit loopback address. */
function isLoopbackHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (unwrapped.toLowerCase() === 'localhost' || unwrapped === '::1') return true
  if (isIP(unwrapped) !== 4) return false
  return unwrapped.split('.')[0] === '127'
}

/** Validate and normalize the API origin. */
function resolveBaseUrl(value: unknown, allowTestLoopbackHttp: boolean): string {
  if (typeof value !== 'string') throw new TypeError('baseUrl must be a string')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('baseUrl must be an absolute URL')
  }
  if (url.protocol === 'http:' && allowTestLoopbackHttp) {
    if (!isLoopbackHostname(url.hostname)) {
      throw new TypeError('baseUrl test parser allows HTTP only for loopback hosts')
    }
  } else if (url.protocol !== 'https:') {
    throw new TypeError('baseUrl must use HTTPS')
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '') {
    throw new TypeError('baseUrl must be an origin without credentials, path, query, or fragment')
  }
  return url.origin
}

/** Resolve one positive safe integer field. */
function resolvePositiveInteger(field: typeof POSITIVE_INTEGER_FIELDS[number], value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value as number
}

/** Internal parser; the HTTP switch is code-owned and absent from public config. */
function resolveConfigWithMode(
  value: unknown,
  options: ResolveConfigOptions,
  allowTestLoopbackHttp: boolean,
): ResolvedConfig {
  const input = parseConfigObject(value)
  const credential = input.credentialRef ?? DEFAULT_CONFIG.credentialRef
  if (typeof credential !== 'string') throw new TypeError('credentialRef must be a string')
  const indexPath = input.indexPath ?? join(options.dshHome ?? resolveDshHome(), 'knowledge', 'notion.sqlite')
  if (typeof indexPath !== 'string' || indexPath.length === 0) {
    throw new TypeError('indexPath must be a non-empty string')
  }
  const numericValues = Object.fromEntries(POSITIVE_INTEGER_FIELDS.map(field => [
    field,
    resolvePositiveInteger(field, input[field] ?? DEFAULT_CONFIG[field]),
  ])) as Pick<ResolvedConfig, typeof POSITIVE_INTEGER_FIELDS[number]>

  if (BigInt(numericValues.staleAfterMinutes) * 60n
    >= BigInt(numericValues.maxStaleHours) * 3_600n) {
    throw new TypeError('staleAfterMinutes must be lower than maxStaleHours when both are converted to seconds')
  }

  return {
    credentialRef: credentialRef(credential),
    rootPages: resolveRootPages(input.rootPages),
    indexPath,
    baseUrl: resolveBaseUrl(input.baseUrl ?? DEFAULT_CONFIG.baseUrl, allowTestLoopbackHttp),
    ...numericValues,
  }
}

/**
 * Resolve the public configuration into values used at runtime.
 *
 * @param input - untrusted Cordis configuration.
 * @param options - trusted resolver dependencies used by tests.
 * @returns complete runtime configuration.
 */
export function resolveConfig(input: Config = {}, options: ResolveConfigOptions = {}): ResolvedConfig {
  return resolveConfigWithMode(input, options, false)
}

/**
 * Parse configuration for HTTP fixture servers. This explicit code-only entry
 * admits loopback HTTP; no serialized config field can enable the exception.
 *
 * @param input - untrusted Cordis configuration.
 * @param options - trusted resolver dependencies used by tests.
 * @returns complete runtime configuration.
 */
export function resolveConfigForTest(input: Config = {}, options: ResolveConfigOptions = {}): ResolvedConfig {
  return resolveConfigWithMode(input, options, true)
}

/** Minimal Standard Schema issue understood by Cordis. */
interface ConfigIssue {
  message: string
}

/** Cordis config schema: all normalization happens before plugin apply. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-notion-knowledge',
    validate(value: unknown): { value: ResolvedConfig } | { issues: ConfigIssue[] } {
      try {
        return { value: resolveConfigWithMode(value, {}, false) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}
