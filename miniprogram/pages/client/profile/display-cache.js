// Display hints only: never use these records to authorize an operation.
const STORAGE_KEY = 'vip_pet_profile_display_v1'
const DISPLAY_TTL = 24 * 60 * 60 * 1000
const AVATAR_TTL = 30 * 60 * 1000
const MAX_RECORDS = 8
const MAX_AVATARS = 24
const avatars = new Map()
const pendingAvatars = new Map()
const summaryFields = ['points', 'memberLevelName', 'badgeTag', 'badgeStyle', 'nameColor', 'nameEffect', 'pointMultiplier', 'retroCardCount', 'levelDescription']

function scopeKey(env, user) {
  const id = user && (user._id || user.openid || user._openid)
  return env && id ? JSON.stringify([String(env), String(id)]) : ''
}
function pickSummary(value = {}) {
  const result = {}
  summaryFields.forEach(key => {
    const item = value[key]
    if (['points', 'pointMultiplier', 'retroCardCount'].includes(key)) {
      result[key] = item !== null && item !== '' && item !== undefined && Number.isFinite(Number(item)) ? Number(item) : null
    } else result[key] = typeof item === 'string' ? item : ''
  })
  return result
}
function readRecords() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY)
    return Array.isArray(value) ? value.filter(item => item && item.version === 1 && typeof item.scope === 'string').slice(0, MAX_RECORDS) : []
  } catch (_) { return [] }
}
function fresh(at) { return typeof at === 'number' && at <= Date.now() && Date.now() - at < DISPLAY_TTL }
function readDisplay(scope) {
  if (!scope) return {}
  const item = readRecords().find(record => record.scope === scope)
  if (!item) return {}
  return {
    summary: fresh(item.summaryAt) && item.summary ? pickSummary(item.summary) : null,
    staff: fresh(item.staffAt) && item.staff ? pickStaff(item.staff) : null
  }
}
function pickStaff(profile) {
  return { auditStatus: String(profile && profile.auditStatus || 'none'), auditRemark: String(profile && profile.auditRemark || '') }
}
function writeDisplay(scope, kind, value) {
  if (!scope) return
  const records = readRecords().filter(item => fresh(item.summaryAt) || fresh(item.staffAt))
  const old = records.find(item => item.scope === scope) || {}
  // Re-sanitize retained fields as storage is not a trusted source.
  const record = { version: 1, scope }
  if (fresh(old.summaryAt) && old.summary) Object.assign(record, { summary: pickSummary(old.summary), summaryAt: old.summaryAt })
  if (fresh(old.staffAt) && old.staff) Object.assign(record, { staff: pickStaff(old.staff), staffAt: old.staffAt })
  record[kind] = kind === 'summary' ? pickSummary(value) : pickStaff(value)
  record[kind + 'At'] = Date.now()
  try { wx.setStorageSync(STORAGE_KEY, [record, ...records.filter(item => item.scope !== scope)].slice(0, MAX_RECORDS)) } catch (_) {}
}
function avatarKey(scope, source) { return scope && source ? JSON.stringify([scope, source]) : '' }
function pruneAvatars() {
  for (const [key, item] of avatars) if (Date.now() - item.at >= AVATAR_TTL) avatars.delete(key)
  while (avatars.size > MAX_AVATARS) avatars.delete(avatars.keys().next().value)
}
// Persistent avatar files: survive page re-creation and app restarts so the avatar renders from a local file on first paint.
const AVATAR_FILES_KEY = 'vip_pet_profile_avatar_files_v1'
const MAX_AVATAR_FILES = 4
function fileSystem() {
  try { return typeof wx !== 'undefined' && typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null } catch (_) { return null }
}
function userDataPath() {
  return typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : ''
}
function readAvatarFiles() {
  try {
    const value = wx.getStorageSync(AVATAR_FILES_KEY)
    return Array.isArray(value) ? value.filter(item => item && typeof item.key === 'string' && typeof item.path === 'string') : []
  } catch (_) { return [] }
}
function writeAvatarFiles(list) {
  try { wx.setStorageSync(AVATAR_FILES_KEY, list.slice(0, MAX_AVATAR_FILES)) } catch (_) {}
}
function removeFile(path) {
  const fs = fileSystem()
  const root = userDataPath()
  if (!fs || !root || !path || !path.startsWith(root)) return
  try { fs.unlinkSync(path) } catch (_) {}
}
function fileExists(path) {
  const fs = fileSystem()
  if (!fs || !path) return false
  try { fs.accessSync(path); return true } catch (_) { return false }
}
function getPersistedAvatar(key) {
  if (!key) return ''
  const list = readAvatarFiles()
  const item = list.find(record => record.key === key)
  if (!item) return ''
  if (fileExists(item.path)) return item.path
  writeAvatarFiles(list.filter(record => record.key !== key))
  return ''
}
function hashKey(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}
function persistAvatar(key, tempPath) {
  const fs = fileSystem()
  const root = userDataPath()
  if (!fs || !root || !tempPath || typeof fs.saveFile !== 'function') return Promise.resolve(tempPath)
  if (tempPath.startsWith(root)) return Promise.resolve(tempPath)
  const extMatch = /\.(png|jpe?g|gif|webp)(?:$|\?)/i.exec(tempPath)
  const target = `${root}/profile-avatar-${hashKey(key)}.${extMatch ? extMatch[1].toLowerCase() : 'jpg'}`
  try { fs.unlinkSync(target) } catch (_) {}
  return new Promise(resolve => {
    fs.saveFile({
      tempFilePath: tempPath,
      filePath: target,
      success: res => {
        const saved = (res && res.savedFilePath) || target
        const list = readAvatarFiles()
        const sameScope = (() => { try { return JSON.parse(key)[0] } catch (_) { return null } })()
        const kept = []
        list.forEach(record => {
          if (record.key === key) return
          let recordScope = null
          try { recordScope = JSON.parse(record.key)[0] } catch (_) {}
          // An account keeps only its latest avatar file.
          if (sameScope && recordScope === sameScope) { if (record.path !== saved) removeFile(record.path); return }
          kept.push(record)
        })
        const next = [{ key, path: saved, at: Date.now() }, ...kept]
        next.slice(MAX_AVATAR_FILES).forEach(record => { if (record.path !== saved) removeFile(record.path) })
        writeAvatarFiles(next)
        resolve(saved)
      },
      fail: () => resolve(tempPath)
    })
  })
}
function getAvatar(scope, source) {
  pruneAvatars()
  const key = avatarKey(scope, source)
  const item = avatars.get(key)
  if (item) return item.path
  const persisted = getPersistedAvatar(key)
  if (persisted) {
    avatars.set(key, { path: persisted, at: Date.now() })
    pruneAvatars()
  }
  return persisted
}
function invalidateAvatar(scope, source, path) {
  const key = avatarKey(scope, source)
  if (!path || (avatars.get(key) || {}).path === path) avatars.delete(key)
  const list = readAvatarFiles()
  const record = list.find(item => item.key === key)
  if (record && (!path || record.path === path)) {
    removeFile(record.path)
    writeAvatarFiles(list.filter(item => item.key !== key))
  }
}
function resolveAvatar(scope, source, isActive = () => true) {
  const key = avatarKey(scope, source)
  if (!key) return Promise.reject(new Error('Missing avatar identity'))
  const cached = getAvatar(scope, source)
  if (cached) return Promise.resolve(cached)
  let request = pendingAvatars.get(key)
  if (!request) {
    if (pendingAvatars.size >= MAX_AVATARS) return Promise.reject(new Error('Too many avatar requests'))
    const url = source.startsWith('cloud://') ? new Promise((resolve, reject) => {
      wx.cloud.getTempFileURL({ fileList: [source], success: res => {
        const item = res.fileList && res.fileList[0]
        if (item && item.tempFileURL) resolve(item.tempFileURL)
        else reject(new Error('Avatar URL unavailable'))
      }, fail: reject })
    }) : Promise.resolve(source)
    request = url.then(src => new Promise((resolve, reject) => {
      wx.getImageInfo({ src, success: res => res.path ? resolve(res.path) : reject(new Error('Avatar path unavailable')), fail: reject })
    })).then(path => persistAvatar(key, path))
    // Bound even native requests that never invoke their callbacks.
    request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Avatar request timed out')), 15000)
      request.then(resolve, reject).finally(() => clearTimeout(timer))
    }).finally(() => { if (pendingAvatars.get(key) === request) pendingAvatars.delete(key) })
    pendingAvatars.set(key, request)
  }
  return request.then(path => {
    if (isActive()) {
      avatars.set(key, { path, at: Date.now() })
      pruneAvatars()
    }
    return path
  })
}
module.exports = { scopeKey, pickSummary, readDisplay, writeDisplay, getAvatar, resolveAvatar, invalidateAvatar }
