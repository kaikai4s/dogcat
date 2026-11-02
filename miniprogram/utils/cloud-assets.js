const { getActiveEnvId } = require('../envList')

const CLOUD_STORAGE_ROOTS = {
  'cloud1-5gnhqn4t0554c1d9': 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236',
  'production-d2g5jx277f41a81a6': 'cloud://production-d2g5jx277f41a81a6.7072-production-d2g5jx277f41a81a6-1310870236'
}

/**
 * 获取当前环境对应的云存储根路径
 */
function getCloudStorageRoot() {
  let envId = 'cloud1-5gnhqn4t0554c1d9'
  try {
    if (typeof getActiveEnvId === 'function') {
      envId = getActiveEnvId() || envId
    }
  } catch (_) {}
  return CLOUD_STORAGE_ROOTS[envId] || CLOUD_STORAGE_ROOTS['cloud1-5gnhqn4t0554c1d9']
}

/**
 * 根据当前运行环境（开发/体验/正式版），自动解析素材对应的云存储 FileID
 * @param {string} relativePath 相对路径（如 'packagePlayground/dovlin-logo-dog.png'）或包含旧环境的完整 cloud:// URL
 * @returns {string} 当前生效环境的 cloud:// FileID
 */
function getCloudAssetUrl(relativePath = '') {
  if (!relativePath || typeof relativePath !== 'string') return ''
  const trimmed = relativePath.trim()

  // 若传入的是完整的 cloud:// 路径，提取相对路径并重定向至当前生效的环境
  if (trimmed.startsWith('cloud://')) {
    for (const root of Object.values(CLOUD_STORAGE_ROOTS)) {
      if (trimmed.startsWith(root + '/')) {
        const sub = trimmed.slice(root.length + 1)
        return `${getCloudStorageRoot()}/${sub}`
      }
    }
    return trimmed
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
    return trimmed
  }

  const clean = trimmed.replace(/^\/+/, '')
  return `${getCloudStorageRoot()}/${clean}`
}

const CLOUD_ASSETS = {
  DOVLIN_LOGO_DOG: 'packagePlayground/dovlin-logo-dog.png',
  LOADING_CAT: 'packagePlayground/loading-cat.gif'
}

function getDovlinLogoUrl() {
  return getCloudAssetUrl(CLOUD_ASSETS.DOVLIN_LOGO_DOG)
}

/**
 * 品牌 Logo 本地持久化缓存：
 * 云存储 cloud:// 图片每次进入新页面都要重新换取临时链接并下载，导致导航栏 Logo 闪烁。
 * 这里在首次下载后将其保存到 USER_DATA_PATH，并在内存中缓存路径，后续页面直接使用本地文件，零网络、无闪烁。
 */
const LOGO_CACHE_KEY = 'dovlin_logo_local_cache_v1'
let logoMemoryPath = ''
let logoMemoryFileId = ''
let logoPrefetchPromise = null

function hasWx() {
  return typeof wx !== 'undefined' && wx
}

function localFileExists(filePath) {
  if (!filePath || !hasWx() || typeof wx.getFileSystemManager !== 'function') return false
  try {
    wx.getFileSystemManager().accessSync(filePath)
    return true
  } catch (_) {
    return false
  }
}

function getCachedDovlinLogoPath() {
  const fileId = getDovlinLogoUrl()
  if (logoMemoryPath && logoMemoryFileId === fileId) return logoMemoryPath
  if (!hasWx() || typeof wx.getStorageSync !== 'function') return ''
  try {
    const cached = wx.getStorageSync(LOGO_CACHE_KEY)
    if (cached && cached.fileId === fileId && localFileExists(cached.path)) {
      logoMemoryPath = cached.path
      logoMemoryFileId = fileId
      return logoMemoryPath
    }
  } catch (_) {}
  return ''
}

/**
 * 页面渲染用的 Logo 地址：优先本地持久化文件，否则回退云存储 FileID
 */
function getDovlinLogoSrc() {
  return getCachedDovlinLogoPath() || getDovlinLogoUrl()
}

/**
 * 后台预取云端 Logo 并持久化到本地（幂等，同一时刻只发起一次下载）
 * @returns {Promise<string>} 本地路径（失败时为空字符串）
 */
function prefetchDovlinLogo() {
  const existing = getCachedDovlinLogoPath()
  if (existing) return Promise.resolve(existing)
  if (logoPrefetchPromise) return logoPrefetchPromise
  if (!hasWx() || !wx.cloud || typeof wx.cloud.downloadFile !== 'function') return Promise.resolve('')

  const fileId = getDovlinLogoUrl()
  logoPrefetchPromise = new Promise((resolve) => {
    wx.cloud.downloadFile({
      fileID: fileId,
      success: (res) => {
        const tempFilePath = res && res.tempFilePath
        if (!tempFilePath || (res.statusCode && res.statusCode !== 200)) return resolve('')
        const remember = (finalPath, persist) => {
          logoMemoryPath = finalPath
          logoMemoryFileId = fileId
          if (persist) {
            try { wx.setStorageSync(LOGO_CACHE_KEY, { fileId, path: finalPath }) } catch (_) {}
          }
          resolve(finalPath)
        }
        const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null
        const userDataPath = wx.env && wx.env.USER_DATA_PATH
        if (!fs || !userDataPath) return remember(tempFilePath, false)
        const targetPath = `${userDataPath}/dovlin-logo-dog.png`
        try { fs.unlinkSync(targetPath) } catch (_) {}
        fs.saveFile({
          tempFilePath,
          filePath: targetPath,
          success: (saved) => remember((saved && saved.savedFilePath) || targetPath, true),
          // 持久化失败时本次会话仍使用临时文件，避免后续页面再次走网络
          fail: () => remember(tempFilePath, false)
        })
      },
      fail: () => resolve('')
    })
  }).then((result) => {
    logoPrefetchPromise = null
    return result
  })
  return logoPrefetchPromise
}

/**
 * 在页面 onLoad（首帧渲染前）调用，若已有本地缓存则切换为本地路径
 */
function applyDovlinLogo(page) {
  if (!page || typeof page.setData !== 'function') return
  const src = getDovlinLogoSrc()
  if (page.data && page.data.dovlinLogoDogUrl !== src) {
    page.setData({ dovlinLogoDogUrl: src })
  }
  if (!getCachedDovlinLogoPath()) prefetchDovlinLogo()
}

function getLoadingCatUrl() {
  return getCloudAssetUrl(CLOUD_ASSETS.LOADING_CAT)
}

module.exports = {
  CLOUD_STORAGE_ROOTS,
  getCloudStorageRoot,
  getCloudAssetUrl,
  getDovlinLogoUrl,
  getDovlinLogoSrc,
  prefetchDovlinLogo,
  applyDovlinLogo,
  getLoadingCatUrl,
  CLOUD_ASSETS
}
