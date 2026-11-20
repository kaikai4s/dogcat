const { hasManorAssets } = require('../../envList')
const { CLOUD_STORAGE_ROOTS } = require('../../utils/cloud-assets')

const MANOR_ASSET_VERSION = 'manor-v1'
const INTERIOR_CACHE_VERSION = 'interior-v2'
const MANOR_ASSET_FILES = Object.freeze({
  layout: 'layout.json',
  manor: 'manor.glb',
  villa: 'manor-villa.glb',
  courtyardVilla: 'courtyard-villa.glb',
  interiorModel: 'model.json',
  interior: 'manor-villa-interior.glb',
  boy: 'boy-animated.glb',
  girl: 'girl-animated.glb',
  car: 'copper-gt-fitted.glb'
})

const isInteriorAsset = key => key === 'interior' || key === 'interiorModel'

function getManorAssetFileId(envId, key) {
  if (!hasManorAssets(envId) || !Object.prototype.hasOwnProperty.call(MANOR_ASSET_FILES, key)) return ''
  const root = CLOUD_STORAGE_ROOTS[envId]
  return root ? root + '/packagePlayground/3d/assets/' + MANOR_ASSET_VERSION + '/' + MANOR_ASSET_FILES[key] : ''
}

// wx.downloadFile can handle 200 MB, and readFile permits 100 MB per file.
// The current largest GLB is 56.14 MiB, so read it directly as a binary buffer.
const DOWNLOAD_TIMEOUT = 120000
const FILE_TIMEOUT = 20000
const ASSET_BYTES = {
  layout: 22363,
  manor: 58869484,
  villa: 12576788,
  courtyardVilla: 11513240,
  interiorModel: 900,
  interior: 1817160,
  boy: 5665896,
  girl: 3902180,
  car: 2127176
}

function manorError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function validInteriorAnchor(anchor) {
  return anchor && Array.isArray(anchor.position) && anchor.position.length >= 3 &&
    anchor.position.slice(0, 3).every(Number.isFinite)
}

function validInteriorMetadata(metadata) {
  return metadata && typeof metadata.model === 'string' && metadata.model.length > 0 &&
    validInteriorAnchor(metadata.anchors?.FrontDoor) && validInteriorAnchor(metadata.anchors?.InteriorSpawn) &&
    (!metadata.frontDoorOpening?.enterDirection ||
      Array.isArray(metadata.frontDoorOpening.enterDirection) &&
      metadata.frontDoorOpening.enterDirection.length >= 3 &&
      metadata.frontDoorOpening.enterDirection.slice(0, 3).every(Number.isFinite))
}

function cancelled() {
  return manorError('MANOR_LOAD_CANCELLED', '已取消加载 3D 庄园')
}

function downloadedPath(result) {
  return result && typeof result.tempFilePath === 'string' ? result.tempFilePath : ''
}

// Cloud calls can return a Promise or use callbacks depending on the base library.
// Native download tasks also expose progress and abort when available.
function invoke(owner, method, options, operation, settings = {}) {
  return new Promise((resolve, reject) => {
    if (operation.cancelled) return reject(cancelled())
    let settled = false
    let failed = false
    let task
    const finish = (error, result) => {
      if (settled) {
        if (failed && result && settings.discard) settings.discard(result)
        return
      }
      settled = true
      failed = Boolean(error)
      clearTimeout(timer)
      operation.stop = null
      if (error) reject(error)
      else resolve(result)
    }
    const stop = error => {
      finish(error)
      if (task && typeof task.abort === 'function') {
        try { task.abort() } catch (_) {}
      }
    }
    const timer = setTimeout(() => stop(manorError('MANOR_ASSET_TIMEOUT', '3D 庄园资源加载超时，请重试')), settings.timeout || FILE_TIMEOUT)
    operation.stop = () => stop(cancelled())
    try {
      task = owner[method]({ ...options, success: result => finish(null, result), fail: error => finish(error || new Error(method + ' failed')) })
      if (task && typeof task.then === 'function') task.then(result => finish(null, result), error => finish(error || new Error(method + ' failed')))
      if (!settled && task && typeof task.onProgressUpdate === 'function' && settings.onProgress) {
        try { task.onProgressUpdate(progress => { if (!settled) settings.onProgress(progress) }) } catch (_) {}
      }
    } catch (error) {
      finish(error || new Error(method + ' failed'))
    }
  })
}

function validateAsset(key, data) {
  if ((key === 'layout' || key === 'interiorModel') && typeof data === 'string') {
    const text = data.replace(/^﻿/, '')
    try {
      const layout = JSON.parse(text)
      if (layout && typeof layout === 'object' && !Array.isArray(layout) &&
          (key === 'layout' || validInteriorMetadata(layout))) return text
    } catch (_) {}
  } else if (key !== 'layout' && Object.prototype.toString.call(data) === '[object ArrayBuffer]' && data.byteLength >= 20) {
    const header = new DataView(data)
    const jsonLength = header.getUint32(12, true)
    if (header.getUint32(0, true) === 0x46546c67 && header.getUint32(4, true) === 2 &&
        header.getUint32(8, true) === data.byteLength && header.getUint32(16, true) === 0x4e4f534a &&
        jsonLength >= 4 && jsonLength % 4 === 0 && jsonLength <= data.byteLength - 20) return data
  }
  throw manorError('MANOR_ASSET_INVALID', '3D 庄园资源不完整：' + MANOR_ASSET_FILES[key])
}

function createCloudAssets({ wx: api, envId } = {}) {
  const pending = new Map()
  let closed = false
  let fs
  if (hasManorAssets(envId) && api && typeof api.getFileSystemManager === 'function') {
    try { fs = api.getFileSystemManager() } catch (_) {}
  }
  const userData = api && api.env && api.env.USER_DATA_PATH
  // The cloud folder is versioned. Persist only validated files from this environment.
  const cachePrefix = fs && userData && typeof fs.saveFile === 'function' && typeof fs.unlinkSync === 'function'
    ? userData + '/dogcat-' + MANOR_ASSET_VERSION + '-' + envId + '-' : ''
  const cachePath = key => cachePrefix
    ? cachePrefix + (isInteriorAsset(key) ? INTERIOR_CACHE_VERSION + '-' : key === 'courtyardVilla' ? 'courtyard-v2-' : '') + MANOR_ASSET_FILES[key] : ''

  function remove(path) {
    if (fs && path && typeof fs.unlinkSync === 'function') {
      try { fs.unlinkSync(path) } catch (_) {}
    }
  }

  function stop(operation) {
    operation.cancelled = true
    if (operation.stop) operation.stop()
  }

  async function readPath(key, filePath, operation) {
    const text = key === 'layout' || key === 'interiorModel'
    const result = await invoke(fs, 'readFile', text ? { filePath, encoding: 'utf8' } : { filePath }, operation)
    return validateAsset(key, result && result.data)
  }

  function dataSize(key, data) {
    if (key === 'layout' || key === 'interiorModel') return typeof data === 'string' ? data.length : 0
    return data?.byteLength || 0
  }

  async function download(fileID, key, operation, report) {
    const cloud = api.cloud
    const config = { env: envId }
    const settings = { timeout: DOWNLOAD_TIMEOUT, onProgress: report, discard: result => remove(downloadedPath(result)) }
    const accept = result => {
      const path = downloadedPath(result)
      if (path && (result.statusCode == null || Number(result.statusCode) === 200)) return path
      remove(path)
      throw new Error('下载返回了无效文件')
    }
    let error
    if (cloud && typeof cloud.downloadFile === 'function') {
      try { return accept(await invoke(cloud, 'downloadFile', { fileID, config }, operation, settings)) }
      catch (reason) { error = reason }
    }
    if (operation.cancelled) throw cancelled()
    if (cloud && typeof cloud.getTempFileURL === 'function' && typeof api.downloadFile === 'function') {
      try {
        const urls = await invoke(cloud, 'getTempFileURL', { fileList: [fileID], config }, operation)
        const file = urls && Array.isArray(urls.fileList) && urls.fileList[0]
        const url = file && (file.fileID == null || file.fileID === fileID) && (file.status == null || Number(file.status) === 0) && file.tempFileURL
        if (typeof url !== 'string' || !url.toLowerCase().startsWith('https://')) throw new Error('云资源没有可用的下载地址')
        report({ progress: 0, totalBytesWritten: 0 })
        return accept(await invoke(api, 'downloadFile', { url, timeout: DOWNLOAD_TIMEOUT }, operation, settings))
      } catch (reason) { error = reason }
    }
    if (operation.cancelled) throw cancelled()
    if (error && error.code === 'MANOR_ASSET_TIMEOUT') throw error
    throw manorError('MANOR_ASSET_DOWNLOAD', '下载 3D 庄园资源失败：' + MANOR_ASSET_FILES[key] + '，请检查网络后重试', error)
  }

  async function load(key, fileID, operation, report) {
    const target = cachePath(key)
    if (target) {
      try {
        const data = await readPath(key, target, operation)
        report({ progress: 100, totalBytesWritten: dataSize(key, data) || ASSET_BYTES[key] })
        return data
      } catch (error) {
        if (operation.cancelled) throw cancelled()
        remove(target)
      }
    }
    const filePath = await download(fileID, key, operation, report)
    try {
      const data = await readPath(key, filePath, operation)
      if (target) {
        // A full disk must not prevent a successful load from temporary storage.
        try { await invoke(fs, 'saveFile', { tempFilePath: filePath, filePath: target }, operation) } catch (_) {}
      }
      if (operation.cancelled) throw cancelled()
      const size = dataSize(key, data) || ASSET_BYTES[key]
      report({ progress: 100, totalBytesWritten: size, totalBytesExpectedToWrite: size })
      return data
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code.startsWith('MANOR_')) throw error
      throw manorError('MANOR_ASSET_READ', '读取 3D 庄园资源失败：' + MANOR_ASSET_FILES[key] + '，请重试', error)
    } finally {
      remove(filePath)
    }
  }

  function read(key, { onProgress } = {}) {
    if (closed) return Promise.reject(cancelled())
    if (!hasManorAssets(envId)) return Promise.reject(manorError('MANOR_ASSETS_UNAVAILABLE', '当前环境暂未开放 3D 庄园'))
    const fileID = getManorAssetFileId(envId, key)
    if (!fileID) return Promise.reject(manorError('MANOR_ASSET_INVALID', '无效的 3D 庄园资源'))
    if (!fs || typeof fs.readFile !== 'function') return Promise.reject(manorError('MANOR_ASSET_READ', '当前微信版本无法读取 3D 庄园资源'))
    const active = pending.get(key)
    if (active) {
      if (typeof onProgress === 'function') active.listeners.add(onProgress)
      return active.promise
    }
    const operation = { cancelled: false, stop: null, listeners: new Set() }
    if (typeof onProgress === 'function') operation.listeners.add(onProgress)
    const report = (event = {}) => {
      if (operation.cancelled) return
      event = event || {}
      const update = {
        progress: Math.min(100, Math.max(0, Number(event.progress) || 0)),
        totalBytesWritten: Math.max(0, Number(event.totalBytesWritten) || 0),
        totalBytesExpectedToWrite: Math.max(0, Number(event.totalBytesExpectedToWrite) || 0) || ASSET_BYTES[key]
      }
      operation.listeners.forEach(listener => {
        if (!operation.cancelled) { try { listener(update) } catch (_) {} }
      })
    }
    operation.promise = Promise.resolve().then(() => load(key, fileID, operation, report)).then(data => {
      if (operation.cancelled) throw cancelled()
      return data
    }).finally(() => {
      if (pending.get(key) === operation) pending.delete(key)
      operation.listeners.clear()
    })
    pending.set(key, operation)
    return operation.promise
  }

  function invalidate(key) {
    if (!getManorAssetFileId(envId, key)) return
    const inFlight = pending.get(key)
    if (inFlight) stop(inFlight)
    pending.delete(key)
    remove(cachePath(key))
  }

  function cancel() {
    closed = true
    pending.forEach(stop)
    pending.clear()
  }

  return { read, cancel, invalidate }
}

module.exports = { createCloudAssets, hasManorAssets, getManorAssetFileId }
