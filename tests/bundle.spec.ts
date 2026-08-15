import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

interface Manifest {
  dsh?: { bundle?: { patch?: string } }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files?: string[]
  scripts?: Record<string, string>
}

interface CiWorkflow {
  jobs?: {
    verify?: {
      'runs-on'?: string
      strategy?: {
        matrix?: {
          include?: Array<{ os?: string, 'node-version'?: string }>
        }
      }
    }
  }
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

describe('bundle manifest and patch', () => {
  it('publishes exactly the prebuilt runtime, patch, license, and bilingual package documentation', () => {
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/types/**/*.d.ts',
      'cordis.patch.yml',
      'README.md',
      'README.zh-CN.md',
      'docs/architecture.md',
      'docs/architecture.zh-CN.md',
      'LICENSE',
    ])
    expect(manifest.dependencies).toEqual({
      '@notionhq/client': '^5.23.3',
      'p-queue': '^9.3.3',
    })
    expect(manifest.scripts).not.toHaveProperty('install')
    expect(manifest.scripts).not.toHaveProperty('postinstall')
  })

  it('links each readme to its packaged architecture document', () => {
    expect(readFileSync(resolve(root, 'README.md'), 'utf8'))
      .toContain('(docs/architecture.md#local-index)')
    expect(readFileSync(resolve(root, 'README.zh-CN.md'), 'utf8'))
      .toContain('(docs/architecture.zh-CN.md#本地索引)')
  })

  it('runs Ubuntu across supported Node lines plus Node 24 on macOS and Windows', () => {
    const workflow = yaml.load(
      readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
      { schema: yaml.JSON_SCHEMA },
    ) as CiWorkflow
    const verify = workflow.jobs?.verify
    expect(verify?.['runs-on']).toBe('${{ matrix.os }}')
    expect(verify?.strategy?.matrix?.include).toEqual([
      { os: 'ubuntu-latest', 'node-version': '22.19.0' },
      { os: 'ubuntu-latest', 'node-version': '24' },
      { os: 'ubuntu-latest', 'node-version': '26' },
      { os: 'macos-latest', 'node-version': '24' },
      { os: 'windows-latest', 'node-version': '24' },
    ])
  })

  it('declares the current Harness peer API and Cordis 4.x', () => {
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '^4.0.1',
      '@deepseek-ai/dsh-commands': '>=0.1.0-rc.5 <0.2.0',
      '@deepseek-ai/dsh-credentials': '>=0.1.0-rc.5 <0.2.0',
      '@deepseek-ai/dsh-home-paths': '>=0.1.0-rc.5 <0.2.0',
      '@deepseek-ai/dsh-system-prompt': '>=0.1.0-rc.5 <0.2.0',
      '@deepseek-ai/dsh-tools': '>=0.1.0-rc.5 <0.2.0',
    })
  })

  it('parses the declared bundle patch and inserts one Web-profile plugin row', () => {
    const declaredPatch = manifest.dsh?.bundle?.patch
    expect(declaredPatch).toBe('./cordis.patch.yml')
    if (declaredPatch === undefined) throw new Error('manifest must declare dsh.bundle.patch')
    const patchPath = resolve(root, declaredPatch)
    const parsed = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)

    const warnings: string[] = []
    const rows = applyEntryPatches([], parsed as PatchOptions[], message => warnings.push(message))
    expect(warnings).toEqual([])
    expect(rows).toEqual([{
      id: 'notion-knowledge',
      name: 'dsh-notion-knowledge',
      inject: ['credentials', 'commands', 'tools', 'systemPrompt'],
      config: { rootPages: [] },
    }])
  })
})
