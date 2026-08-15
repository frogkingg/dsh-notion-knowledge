import { readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

interface Registrations {
  commands: number
  systemPrompt: number
  tools: number
}

interface LoadedComposition {
  context: Context
  includeId: string
  registrations: Registrations
}

const projectRoot = resolve(import.meta.dirname, '..')
const builtEntryUrl = pathToFileURL(join(projectRoot, 'lib', 'index.js')).href
const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function bundleRow(): EntryOptions {
  const parsed = yaml.load(readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  }) as PatchOptions[]
  const rows = applyEntryPatches([], parsed, () => {})
  const row = rows.find(candidate => candidate.id === 'notion-knowledge')
  if (row === undefined) throw new Error('bundle patch must insert notion-knowledge')
  return row
}

async function loadBuiltComposition(config: unknown): Promise<LoadedComposition> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-notion-built-loader-'))
  temporaryDirectories.push(directory)
  const registrations: Registrations = { commands: 0, systemPrompt: 0, tools: 0 }
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, yaml.dump([{
    ...bundleRow(),
    name: builtEntryUrl,
    config,
  }], { noRefs: true }))

  const context = new Context()
  contexts.push(context)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.provide('credentials', {} as never)
  context.provide('commands', {
    register: () => { registrations.commands += 1 },
  } as never)
  context.provide('tools', {
    register: () => {
      registrations.tools += 1
      return () => {}
    },
  } as never)
  context.provide('systemPrompt', {
    section: () => {
      registrations.systemPrompt += 1
      return () => {}
    },
  } as never)
  const includeId = await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { context, includeId, registrations }
}

describe('built package Loader composition', () => {
  it('publishes named ESM exports without an accidental default export', async () => {
    const plugin: unknown = await import(builtEntryUrl)

    expect(plugin).toMatchObject({
      NOTION_API_VERSION: '2026-03-11',
      name: 'notion-knowledge',
    })
    expect(plugin).toHaveProperty('Config')
    expect(plugin).toHaveProperty('apply')
    expect(plugin).toHaveProperty('inject')
    expect(plugin).toHaveProperty('resolveConfig')
    expect(plugin).not.toHaveProperty('default')
  })

  it('starts and unloads empty configuration with status commands only', async () => {
    const directory = await mkdtemp(join(realpathSync(tmpdir()), 'dsh-notion-built-loader-empty-'))
    temporaryDirectories.push(directory)
    const loaded = await loadBuiltComposition({ rootPages: [], indexPath: join(directory, 'notion.sqlite') })
    const entry = [...loaded.context.loader.entries()]
      .find(candidate => candidate.options.id === 'notion-knowledge')

    expect(entry?.fiber).toBeDefined()
    expect(loaded.registrations).toEqual({ commands: 2, systemPrompt: 0, tools: 0 })

    await loaded.context.loader.remove(loaded.includeId)
    expect([...loaded.context.loader.entries()]).toEqual([])
  })

  it('rejects invalid serialized configuration before startup', async () => {
    await expect(loadBuiltComposition({ rootPages: ['not-a-page'] })).rejects.toThrow(/rootPages/)
  })

  it('registers read-only tools and prompt guidance when roots are configured', async () => {
    const directory = await mkdtemp(join(realpathSync(tmpdir()), 'dsh-notion-built-loader-configured-'))
    temporaryDirectories.push(directory)
    const loaded = await loadBuiltComposition({
      rootPages: ['11111111-1111-1111-1111-111111111111'],
      indexPath: join(directory, 'notion.sqlite'),
    })
    expect(loaded.registrations).toEqual({ commands: 2, systemPrompt: 1, tools: 2 })
    await loaded.context.loader.remove(loaded.includeId)
    expect([...loaded.context.loader.entries()]).toEqual([])
  })
})
