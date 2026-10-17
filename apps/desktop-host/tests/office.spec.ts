import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as desktopOffice from '../src/office.ts'
import { archiveMacOSPrimaryRuntime } from '../../desktop/scripts/archive-primary-runtime.mjs'

it.each(process.platform === 'darwin' ? [false, true] : [false])('loads Desktop Office CLI paths and removes them on disposal (archived=%s)', async (archived) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-'))
  const ctx = new Context()
  try {
    const assets = join(root, 'runtime', 'office-skills')
    await cp(new URL('../../../packages/skill/skill-office/assets/', import.meta.url), assets, { recursive: true })
    const nodeDirectory = join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
    await mkdir(nodeDirectory, { recursive: true })
    await writeFile(join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node'), 'fixture executable', { mode: 0o755 })
    if (archived) {
      const source = join(root, 'runtime', 'primary-runtime')
      await mkdir(join(source, 'dependencies/python/bin'), { recursive: true })
      await writeFile(join(source, 'dependencies/python/bin/python3'), 'fixture executable', { mode: 0o755 })
      await mkdir(join(source, 'dependencies/python/lib/python3.12/site-packages'), { recursive: true })
      await mkdir(join(source, 'dependencies/node/node_modules'), { recursive: true })
      await writeFile(join(source, 'runtime.json'), JSON.stringify({ desktopVersion: 'test', platform: process.platform,
        arch: process.arch, python: '3.12.0', node: '24.0.0', pythonPackages: {} }))
      await archiveMacOSPrimaryRuntime(source)
    }
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    expect('default' in desktopOffice).toBe(false)
    expect(ctx.loader.unwrapExports(desktopOffice)).toBe(desktopOffice)
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime],
      ['skills', SkillRegistry], ['office', desktopOffice],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: agents', '- name: systemPrompt', '- name: tools', '- name: skills', '- name: office',
      '  config:', `    source: ${JSON.stringify(join(root, 'runtime', 'primary-runtime'))}`,
      `    root: ${JSON.stringify(join(root, 'installed'))}`,
      `    runtimeDir: ${JSON.stringify(join(root, 'dsh'))}`, '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['office-docx', 'office-pptx', 'office-xlsx'])
    expect((await ctx.skills.get('office-pptx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-pptx') })
    expect((await ctx.skills.get('office-pptx'))?.content).toContain('libreofficeKit')
    expect((await ctx.skills.get('office-pptx'))?.content).toContain(JSON.stringify(archived
      ? join(root, 'installed', 'dependencies', 'node', 'bin') : nodeDirectory).slice(1, -1))
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'office')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
