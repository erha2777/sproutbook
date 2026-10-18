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
  win: {
    minimize: () => call('window:minimize'),
    toggleMaximize: () => call('window:toggleMaximize'),
    close: () => call('window:close')
  },
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
    identifyFile: (payload) => call('ai:identifyFile', payload),
    cancel: (requestId) => call('ai:cancel', requestId),
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
    save: (payload) => call('plants:save', payload),
    setCover: (plantId, imageId) => call('plants:cover', plantId, imageId ?? null),
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
    importUrl: (owner, url) => call('images:importUrl', owner, url),
    search: (query) => call('images:search', query),
    copyFromSpecies: (plantId, imageId) => call('images:copyFromSpecies', plantId, imageId),
    remove: (id) => call('images:delete', id),
  },
  materials: {
    list: (query) => call('materials:list', query),
    save: (input) => call('materials:save', input),
    remove: (id) => call('materials:delete', id),
    usage: (id) => call('materials:usage', id)
  },
  recipes: {
    list: (options) => call('recipes:list', options ?? {}),
    save: (input) => call('recipes:save', input),
    archive: (id) => call('recipes:archive', id),
    restore: (id) => call('recipes:restore', id),
    kinds: () => call('recipes:kinds'),
    stats: () => call('recipes:stats')
  },
  weather: {
    assess: (force) => call('weather:assess', force ?? false),
    clearCache: () => call('weather:clearCache'),
    config: () => call('weather:config'),
    saveConfig: (patch) => call('weather:saveConfig', patch ?? {}),
    testLocation: (name) => call('weather:testLocation', name)
  },

  care: {
    rules: (options) => call('care:rules', options ?? {}),
    saveRule: (input) => call('care:rule.save', input),
    removeRule: (id) => call('care:rule.delete', id),

    tasks: (query) => call('care:tasks', query ?? {}),
    createTask: (input) => call('care:task.create', input),
    updateTask: (id, patch) => call('care:task.update', id, patch),
    completeTask: (id, note, date, imageIds) =>
      call('care:task.complete', id, note ?? null, date, imageIds ?? null),
    skipTask: (id, reason) => call('care:task.skip', id, reason ?? null),
    reopenTask: (id) => call('care:task.reopen', id),
    removeTask: (id) => call('care:task.delete', id),
    purgeTasks: (input) => call('care:tasks.purge', input),

    generate: (plantId, year) => call('care:generate', plantId, year),
    generateAll: (year) => call('care:generateAll', year),
    overview: (year) => call('care:overview', year),

    plantPhase: (plantId) => call('care:plantPhase', plantId),
    setPlantPhase: (plantId, phase, note) => call('care:setPlantPhase', plantId, phase, note ?? null),

    logs: (plantId, limit) => call('care:logs', plantId, limit),
    addLog: (input) => call('care:log.add', input),
    updateLog: (id, patch) => call('care:log.update', id, patch),
    removeLog: (id) => call('care:log.delete', id)
  },
  transfer: {
    export: (kind, format) => call('transfer:export', kind, format),
    previewImport: (kind) => call('transfer:previewImport', kind),
    applyImport: (token, options) => call('transfer:applyImport', token, options ?? {}),
    discardImport: (token) => call('transfer:discardImport', token)
  }
}

contextBridge.exposeInMainWorld('api', api)
