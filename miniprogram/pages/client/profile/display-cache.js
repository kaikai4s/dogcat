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
function getAvatar(scope, source) {
  pruneAvatars()
  const item = avatars.get(avatarKey(scope, source))
  return item ? item.path : ''
}
function invalidateAvatar(scope, source, path) {
  const key = avatarKey(scope, source)
  if (!path || (avatars.get(key) || {}).path === path) avatars.delete(key)
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
    }))
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
