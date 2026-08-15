import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

interface LoaderObservation {
  applies: number
  disposes: number
  registrations: {
    commands: number
    systemPrompt: number
    tools: number
  }
  resolvedConfig?: plugin.ResolvedConfig
}

declare global {
  // Runtime bridge used only by the Loader's plain-JavaScript fixture module.
  var __dshNotionKnowledgeLoaderTest: {
    observation: LoaderObservation
    plugin: typeof plugin
  } | undefined
}

const temporaryDirectories: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  for (const context of contexts) await context.fiber.dispose()
  contexts.clear()
  globalThis.__dshNotionKnowledgeLoaderTest = undefined
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function bundleRow(): EntryOptions {
  const root = resolve(import.meta.dirname, '..')
  const parsed = yaml.load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  }) as PatchOptions[]
  const rows = applyEntryPatches([], parsed, () => {})
  const row = rows.find(candidate => candidate.id === 'notion-knowledge')
  if (row === undefined) throw new Error('bundle patch must insert notion-knowledge')
  return row
}

async function boot(config: unknown): Promise<{
  context: Context
  observation: LoaderObservation
}> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-notion-loader-'))
  temporaryDirectories.push(directory)
  const observation: LoaderObservation = {
    applies: 0,
    disposes: 0,
    registrations: { commands: 0, systemPrompt: 0, tools: 0 },
  }
  globalThis.__dshNotionKnowledgeLoaderTest = { observation, plugin }

  const adapterPath = join(directory, 'plugin-adapter.mjs')
  writeFileSync(adapterPath, `
const target = globalThis.__dshNotionKnowledgeLoaderTest
export const name = target.plugin.name
export const inject = target.plugin.inject
export const Config = target.plugin.Config
export function apply(ctx, config) {
  target.observation.applies += 1
  target.observation.resolvedConfig = config
  const disposePlugin = target.plugin.apply(ctx, config)
  ctx.effect(() => () => {
    try {
      disposePlugin()
    } finally {
      target.observation.disposes += 1
    }
  })
}
`)
  const row = bundleRow()
  const configPath = join(directory, 'cordis.yml')
  writeFileSync(configPath, yaml.dump([{
    ...row,
    name: pathToFileURL(adapterPath).href,
    config,
  }], { noRefs: true }))

  const context = new Context()
  contexts.add(context)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.provide('credentials', {} as never)
  context.provide('commands', {
    register: () => { observation.registrations.commands += 1 },
  } as never)
  context.provide('tools', {
    register: () => { observation.registrations.tools += 1 },
  } as never)
  context.provide('systemPrompt', {
    section: () => { observation.registrations.systemPrompt += 1 },
  } as never)
  try {
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    return { context, observation }
  } catch (error) {
    await context.fiber.dispose()
    contexts.delete(context)
    throw error
  }
}

describe('real Loader composition', () => {
  it('loads and unloads empty configuration with status commands only', async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-notion-loader-configured-'))
    temporaryDirectories.push(directory)
    const { context, observation } = await boot({ rootPages: [], indexPath: join(directory, 'notion.sqlite') })
    expect(observation.applies).toBe(1)
    expect(observation.resolvedConfig).toMatchObject({ rootPages: [] })
    expect(observation.registrations).toEqual({ commands: 2, systemPrompt: 0, tools: 0 })

    await context.fiber.dispose()
    contexts.delete(context)
    expect(observation.disposes).toBe(1)
  })

  it('fails plugin loading when the serialized configuration is invalid', async () => {
    await expect(boot({ rootPages: ['not-a-page'] })).rejects.toThrow(/rootPages/)
  })
})
