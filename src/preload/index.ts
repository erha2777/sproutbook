/**
 * preload：唯一的渲染进程 ↔ 主进程通道。
 *
 * 安全约束：
 *  - contextIsolation 开启，渲染进程拿不到 Node API
 *  - 只暴露白名单方法，不暴露 ipcRenderer 本身
 *  - 主进程返回 { ok, data } / { ok, error }，这里把 error 转成异常，
 *    让渲染层可以自然使用 try/catch，而不是到处判断 ok
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { SproutbookApi } from '../shared/api'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string }
  if (!result || typeof result !== 'object') {
    throw new Error(`IPC 调用 ${channel} 返回了非法结果`)
  }
  if (!result.ok) throw new Error(result.error)
  return result.data
}

const api: SproutbookApi = {
  app: {
    info: () => call('app:info'),
    paths: () => call('app:paths'),
    backups: () => call('app:backups'),
    backupNow: () => call('app:backupNow'),
    openDataDir: () => call('app:openDataDir'),
    openImagesDir: () => call('app:openImagesDir')
  },
  sandbox: {
    status: () => call('sandbox:status'),
    createShortcut: (scope) => call('sandbox:createShortcut', scope ?? 'desktop'),
    removeShortcuts: () => call('sandbox:removeShortcuts')
  },
  ai: {
    getSettings: () => call('settings:getAi'),
    setSettings: (patch) => call('settings:setAi', patch),
    clearApiKey: () => call('settings:clearApiKey'),
    keyWarning: () => call('settings:keyWarning'),
    test: () => call('settings:testAi'),
    autofill: (payload) => call('ai:autofill', payload),
    cancel: (requestId) => call('ai:cancel', requestId),
    runs: (limit) => call('ai:runs', limit)
  },
  fields: {
    list: (ownerKind, includeArchived) => call('fields:list', ownerKind, includeArchived ?? false),
    create: (input) => call('fields:create', input),
    update: (id, patch) => call('fields:update', id, patch),
    setArchived: (id, archived) => call('fields:setArchived', id, archived),
    remove: (id) => call('fields:delete', id),
    usage: (ownerKind) => call('fields:usage', ownerKind),
    reorder: (ownerKind, orderedIds) => call('fields:reorder', ownerKind, orderedIds)
  },
  species: {
    list: (options) => call('species:list', options ?? {}),
    get: (id) => call('species:get', id),
    save: (payload) => call('species:save', payload),
    verify: (id, fieldKeys, verified) => call('species:verify', id, fieldKeys, verified !== false),
    remove: (id) => call('species:delete', id),
    families: () => call('species:families')
  },
  plants: {
    list: (options) => call('plants:list', options ?? {}),
    get: (id) => call('plants:get', id),
    save: (payload) => call('plants:save', payload),
    remove: (id) => call('plants:delete', id),
    stats: (month) => call('plants:stats', month)
  },
  env: {
    list: (includeArchived) => call('env:list', includeArchived ?? false),
    save: (input) => call('env:save', input),
    remove: (id) => call('env:delete', id)
  },
  images: {
    list: (owner) => call('images:list', owner),
    pick: (owner) => call('images:pick', owner),
    remove: (id) => call('images:delete', id),
    reveal: (fileName) => call('images:reveal', fileName)
  },
  materials: {
    list: (query) => call('materials:list', query),
    save: (input) => call('materials:save', input),
    remove: (id) => call('materials:delete', id),
    usage: (id) => call('materials:usage', id)
  },
  recipes: {
    list: (options) => call('recipes:list', options ?? {}),
    get: (id) => call('recipes:get', id),
    save: (input) => call('recipes:save', input),
    archive: (id) => call('recipes:archive', id),
    restore: (id) => call('recipes:restore', id),
    kinds: () => call('recipes:kinds'),
    stats: () => call('recipes:stats')
  },
  transfer: {
    export: (kind, format) => call('transfer:export', kind, format),
    previewImport: (kind) => call('transfer:previewImport', kind),
    applyImport: (token, options) => call('transfer:applyImport', token, options ?? {}),
    discardImport: (token) => call('transfer:discardImport', token)
  }
}

contextBridge.exposeInMainWorld('api', api)
