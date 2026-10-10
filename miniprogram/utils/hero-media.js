const { getCloudEnv } = require('./cloud')

const CACHE_KEY = 'home_hero_media_v1'
const CACHE_TTL = 10 * 60 * 1000

function readCache() {
  try {
    const saved = wx.getStorageSync(CACHE_KEY)
    return saved && saved.env === getCloudEnv() ? saved.urls || {} : {}
  } catch (_) { return {} }
}

function getCachedHeroMedia(fileIds = []) {
  const saved = readCache()
  return Object.fromEntries(fileIds.map(id => {
    if (/^https?:\/\//.test(id)) return [id, id]
    const entry = saved[id]
    return [id, entry && entry.expiresAt > Date.now() ? entry.url : '']
  }).filter(([, url]) => url))
}

function resolveHeroMedia(fileIds = [], { force = false } = {}) {
  const urls = force ? getCachedHeroMedia(fileIds.filter(id => !id.startsWith('cloud://'))) : getCachedHeroMedia(fileIds)
  const missing = Array.from(new Set(fileIds)).filter(id => id.startsWith('cloud://') && !urls[id])
  if (!missing.length) return Promise.resolve(urls)
  return new Promise(resolve => {
    wx.cloud.getTempFileURL({
      fileList: missing,
      success(result) {
        const saved = readCache()
        ;(result.fileList || []).forEach(file => {
          if (file.fileID && file.tempFileURL && (!file.status || file.status === 0)) {
            urls[file.fileID] = file.tempFileURL
            saved[file.fileID] = { url: file.tempFileURL, expiresAt: Date.now() + CACHE_TTL }
          }
        })
        const active = Object.fromEntries(Object.entries(saved).filter(([, value]) => value.expiresAt > Date.now()).slice(-100))
        try { wx.setStorageSync(CACHE_KEY, { env: getCloudEnv(), urls: active }) } catch (_) {}
        resolve(urls)
      },
      fail: () => resolve(urls)
    })
  })
}

module.exports = { getCachedHeroMedia, resolveHeroMedia }
