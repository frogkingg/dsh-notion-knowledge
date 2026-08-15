import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { IndexStore } from '../index-store/index.ts'
import type { ResolvedConfig } from '../config.ts'
import {
  createNotionTransport,
} from '../notion/transport.ts'
import {
  syncNotionWorkspace,
  type NotionTransport,
} from '../notion/index.ts'

/** Transport factory used by the sync command. */
export type NotionTransportFactory = (token: string) => NotionTransport

/** Dependencies shared by both Notion commands. */
export interface NotionCommandContext {
  /** Open local index. */
  store: IndexStore
  /** Resolved bundle configuration. */
  config: ResolvedConfig
  /** One-shot credential resolver. */
  resolveToken: () => Promise<string | undefined>
  /** Creates the transport for a freshly resolved token. */
  transportFactory: NotionTransportFactory
}

/** Runtime that owns single-instance sync and local status projection. */
export class NotionCommandRuntime {
  private syncPromise: Promise<unknown> | undefined
  private syncInProgress = false

  constructor(private readonly context: NotionCommandContext) {}

  /** Run one manual sync; a second concurrent request reports `sync-in-progress`. */
  async runSync(): Promise<CommandResult> {
    if (this.syncInProgress) {
      return { kind: 'error', text: 'notion sync is already in progress (sync-in-progress)' }
    }
    this.syncInProgress = true
    try {
      const token = await this.context.resolveToken()
      if (token === undefined || token.length === 0) {
        return { kind: 'error', text: 'The configured Notion credential is missing (credential-missing)' }
      }
      const startedAt = Date.now()
      this.syncPromise = (async () => {
        const transport = this.context.transportFactory(token)
        const result = await syncNotionWorkspace(
          this.context.store,
          transport,
          token,
          {
            rootPages: this.context.config.rootPages,
            maxCatalogItems: this.context.config.maxCatalogItems,
            maxPageChars: this.context.config.maxPageChars,
          },
        )
        const elapsedMs = Date.now() - startedAt
        return {
          kind: 'success' as const,
          text: `Notion sync complete: discovered ${String(result.discovered)}, inserted ${String(result.inserted)}, `
            + `updated ${String(result.updated)}, unchanged ${String(result.unchanged)}, removed ${String(result.removed)}, `
            + `incomplete ${String(result.incomplete)}, elapsed ${String(elapsedMs)}ms`,
        }
      })()
      return await this.syncPromise as CommandResult
    } finally {
      this.syncInProgress = false
      this.syncPromise = undefined
    }
  }

  /** Project local binding and freshness facts without exposing absolute paths or secrets. */
  status(): CommandResult {
    const store = this.context.store
    const workspace = store.getState('active_workspace_name')
    const pages = store.countPages()
    const lastSuccess = store.getState('last_success_at')
    const lastFailure = store.getState('last_failure_at')
    const configured = this.context.config.rootPages.length > 0
    const running = this.syncInProgress
    const lines = [
      `Notion knowledge ${configured ? 'configured' : 'not configured'}`,
      workspace === undefined ? '' : `Workspace: ${workspace}`,
      `Root pages: ${String(this.context.config.rootPages.length)}`,
      `Indexed pages: ${String(pages)}`,
      lastSuccess === undefined ? 'Last success: never' : `Last success: ${lastSuccess}`,
      lastFailure === undefined ? '' : `Last failure: ${lastFailure}`,
      `Sync running: ${running ? 'yes' : 'no'}`,
    ].filter(line => line.length > 0)
    return { kind: 'success', text: lines.join('\n') }
  }
}

/** Create the default SDK-backed transport factory. */
export function defaultNotionTransportFactory(config: ResolvedConfig): NotionTransportFactory {
  return token => createNotionTransport(token, config.baseUrl, config.requestTimeoutMs)
}
