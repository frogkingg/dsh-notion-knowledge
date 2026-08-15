/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Client } from '@notionhq/client'
import { NOTION_API_VERSION } from '../config.ts'
import type {
  NotionCatalogObject,
  NotionIdentity,
  NotionMarkdownResponse,
  NotionObjectKind,
  NotionParentObject,
  NotionTransport,
} from './index.ts'

type AnyObject = Record<string, any>

/** Extract plain text from one Notion rich-text title array. */
function plainText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map(item => typeof (item as AnyObject).plain_text === 'string'
    ? (item as AnyObject).plain_text as string
    : '').join('')
}

/** Extract the identifier from one Notion parent response. */
function parentId(value: AnyObject): string | undefined {
  switch (value.type) {
    case 'page_id': return value.page_id as string | undefined
    case 'database_id': return value.database_id as string | undefined
    case 'data_source_id': return value.data_source_id as string | undefined
    default: return undefined
  }
}

/** Map one Notion search result into the normalized sync catalog shape. */
function normalizeObject(value: AnyObject): NotionCatalogObject {
  const pageParent = parentId(value.parent)
  const kind: NotionObjectKind = value.object === 'data_source' ? 'data_source' : 'page'
  const base = {
    id: value.id as string,
    kind,
    title: plainText(value.object === 'data_source' ? value.title : value.title),
    url: typeof value.url === 'string' ? value.url : `https://www.notion.so/${String(value.id).replaceAll('-', '')}`,
    lastEditedTime: value.last_edited_time as string,
    archived: value.archived === true || value.in_trash === true,
    inTrash: value.in_trash === true,
  }
  if (kind === 'page' && pageParent !== undefined) {
    return { ...base, parentPageId: pageParent }
  }
  if (kind === 'data_source') {
    const databaseId = value.database_parent?.database_id as string | undefined
    if (pageParent !== undefined && databaseId !== undefined) {
      return { ...base, parentDataSourceId: pageParent, parentDatabaseId: databaseId }
    }
    if (pageParent !== undefined) return { ...base, parentDataSourceId: pageParent }
    if (databaseId !== undefined) return { ...base, parentDatabaseId: databaseId }
  }
  return base
}

/** SDK-backed read-only transport used by the local synchronization engine. */
class NotionSdkTransport implements NotionTransport {
  constructor(private readonly client: Client) {}

  async getSelf(): Promise<NotionIdentity> {
    const response = await this.client.users.me({}) as AnyObject
    const bot = response.type === 'bot' ? response.bot as AnyObject : undefined
    const owner = bot?.owner?.type === 'user' ? bot.owner.user as AnyObject : undefined
    return {
      workspaceId: bot?.workspace_id ?? response.workspace_id ?? '',
      workspaceName: bot?.workspace_name ?? response.workspace_name ?? null,
      principalId: owner?.id ?? response.id ?? '',
      principalName: owner?.name ?? response.name ?? null,
    }
  }

  async listObjects(): Promise<{ objects: NotionCatalogObject[]; complete: boolean }> {
    const objects: NotionCatalogObject[] = []
    let complete = true
    for (const kind of ['page', 'data_source'] as const) {
      let cursor: string | null | undefined
      do {
        const response = await this.client.search({
          filter: { property: 'object', value: kind },
          page_size: 100,
          ...cursor === undefined ? {} : { start_cursor: cursor },
        }) as AnyObject
        for (const result of response.results ?? []) objects.push(normalizeObject(result as AnyObject))
        complete = complete && response.request_status?.type !== 'incomplete'
        cursor = response.has_more === true ? response.next_cursor : undefined
      } while (cursor !== undefined)
    }
    return { objects, complete }
  }

  async getParent(object: NotionCatalogObject): Promise<NotionParentObject | undefined> {
    const parentIdValue = object.parentPageId ?? object.parentDataSourceId ?? object.parentDatabaseId
    if (parentIdValue === undefined) return undefined
    const page = await this.client.pages.retrieve({ page_id: parentIdValue }) as AnyObject
    if (page.object !== 'page') return undefined
    const pageParent = parentId(page.parent)
    return {
      id: page.id as string,
      kind: 'page',
      ...pageParent === undefined ? {} : { parentPageId: pageParent },
    }
  }

  async getMarkdown(pageId: string): Promise<NotionMarkdownResponse> {
    const response = await this.client.pages.retrieveMarkdown({ page_id: pageId }) as AnyObject
    return {
      markdown: response.markdown as string,
      truncated: response.truncated === true,
      unknownBlockIds: response.unknown_block_ids ?? [],
    }
  }
}

/**
 * Create the read-only Notion transport backed by the official SDK.
 *
 * @param token - freshly resolved integration token.
 * @param baseUrl - validated Notion API origin.
 * @param timeoutMs - per-request timeout.
 * @returns SDK-backed transport.
 */
export function createNotionTransport(token: string, baseUrl: string, timeoutMs: number): NotionTransport {
  return new NotionSdkTransport(new Client({
    auth: token,
    baseUrl,
    notionVersion: NOTION_API_VERSION,
    timeoutMs,
  }))
}
