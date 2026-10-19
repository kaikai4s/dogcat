const cloud = require('./cloud')
const { formatDateTime } = require('./format')
const { createClientRequestId, enqueueOfflineTask, getOfflineTaskCount, isOfflineOwner } = require('./offlineQueue')
const { flushServiceOfflineTasks } = require('./serviceOfflineSync')
const { MAX_GAP_MS, pointTime, distanceM, isGoodTrackPoint, isPlausibleStep } = require('./trackQuality')

const listeners = new Set()
const endedSessions = new Set()
let context = null
let identity = ''
let identityGeneration = 0
let revision = 0
let hidden = false
let nativeChain = Promise.resolve()
let pendingStop = null
let reconcileRequest = null
const idle = { orderId: '', autoTracking: false, backgroundTracking: false, trackingState: 'idle',
  trackingErrorText: '', trackingWarningText: '', trackStatusText: '轨迹记录已停止', latestTrackText: '', pointCount: 0, offlineTaskCount: 0 }
let snapshot = { ...idle }

function ownerOf(user) { return user && (user._id || user.openid) || '' }
function staff(user) { return Boolean(user && Array.isArray(user.roles) && user.roles.includes('staff')) }
function orderIdOf(order) { return order && (order._id || order.id || order.orderId) || '' }
function sessionKey(order, owner = identity) {
  return JSON.stringify([owner, orderIdOf(order), Number(order.activeSessionIndex || 1), String(order.currentSessionStartedAt || order.startedAt || '')])
}
function current(ctx) { return context === ctx && !ctx.cancelled && identity === ctx.owner && ownerOf(cloud.getCachedUser()) === ctx.owner }
function publish(updates) {
  snapshot = { ...snapshot, ...updates }
  listeners.forEach(listener => { try { listener({ ...snapshot }) } catch (_) {} })
}
function update(ctx, updates) { if (current(ctx)) publish(updates) }
function native(method, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof wx[method] !== 'function') return reject(new Error(`当前微信版本不支持 ${method}`))
    try { wx[method]({ ...options, success: resolve, fail: reject }) } catch (error) { reject(error) }
  })
}
function serial(operation) {
  const result = nativeChain.then(operation)
  nativeChain = result.catch(() => null)
  return result
}
function errorText(error) {
  const raw = error && (error.errMsg || error.message) || '定位失败'
  const hints = []
  try {
    if (typeof wx.getSystemSetting === 'function' && wx.getSystemSetting().locationEnabled === false) hints.push('手机系统定位服务已关闭，请在系统设置开启')
    if (typeof wx.getAppAuthorizeSetting === 'function' && wx.getAppAuthorizeSetting().locationAuthorized === 'denied') hints.push('微信未获系统定位权限，请在手机设置中允许微信访问位置')
    if (typeof wx.getDeviceInfo === 'function' && wx.getDeviceInfo().platform === 'devtools') hints.push('请用微信真机验证后台定位')
  } catch (_) {}
  if (/auth|deny|denied|permission|authorize|权限/i.test(raw)) hints.push('请在定位授权设置中允许使用小程序时和离开后获取位置')
  if (/not declared|requiredPrivateInfos|config|api scope|无权限|未开通/i.test(raw)) hints.push('请核对AppID接口权限、隐私声明及后台定位配置')
  return [raw, ...hints].join('；')
}
async function permission(scope, settings, interactive) {
  if (settings[scope] === true) return
  if (!interactive || settings[scope] === false) throw new Error(`未获得${scope === 'scope.userLocationBackground' ? '后台' : ''}定位授权，请打开定位授权设置`)
  await native('authorize', { scope })
}
function detach(ctx) {
  if (ctx.listener && typeof wx.offLocationChange === 'function') wx.offLocationChange(ctx.listener)
  ctx.listener = null
  if (ctx.timer) clearInterval(ctx.timer)
  ctx.timer = null
  ctx.running = false
}
async function stopNative() { await native('stopLocationUpdate').catch(() => null) }
function pause(ctx) {
  detach(ctx)
  ctx.generation += 1
  return serial(stopNative)
}
function start(ctx, interactive) {
  if (ctx.startPromise) return ctx.startPromise
  if (!current(ctx) || ctx.frozen || ctx.finishing || ctx.running) return Promise.resolve(getSnapshot())
  const generation = ++ctx.generation
  const valid = () => current(ctx) && generation === ctx.generation && !ctx.frozen && !ctx.finishing
  update(ctx, { autoTracking: false, backgroundTracking: false, trackingState: 'starting', trackingErrorText: '', trackStatusText: '正在开启服务轨迹记录' })
  const request = serial(async () => {
    if (!valid()) return
    try {
      if (interactive && !hidden) await cloud.requirePrivacyAuthorize()
      else if (typeof wx.getPrivacySetting === 'function') {
        const privacy = await native('getPrivacySetting')
        if (privacy.needAuthorization) throw new Error('请返回服务页面确认隐私授权后重试定位')
      }
      if (!valid()) return
      const { authSetting = {} } = await native('getSetting')
      if (!valid()) return
      await permission('scope.userLocation', authSetting, interactive && !hidden)
      if (!valid()) return
      let mode = 'background', backgroundError = ''
      try {
        await permission('scope.userLocationBackground', authSetting, interactive && !hidden)
        if (!valid()) return
        await native('startLocationUpdateBackground', { type: 'gcj02' })
      } catch (error) {
        backgroundError = errorText(error)
        if (!valid()) return
        if (hidden) throw error
        await native('startLocationUpdate', { type: 'gcj02' })
        mode = 'foreground'
      }
      if (!valid()) { await stopNative(); return }
      if (mode === 'foreground' && hidden) { await stopNative(); update(ctx, { trackingState: 'paused', trackStatusText: '返回小程序后恢复前台定位' }); return }
      if (typeof wx.onLocationChange !== 'function') throw new Error('当前微信版本不支持连续定位监听')
      ctx.segment = createClientRequestId('segment')
      ctx.last = null
      ctx.warmup = null
      ctx.running = true
      ctx.mode = mode
      ctx.listener = location => {
        if (valid() && ctx.running && !ctx.finishing) {
          record(ctx, location, false).then(() => current(ctx) ? flushOfflineTasks() : null).catch(() => null)
        }
      }
      wx.onLocationChange(ctx.listener)
      ctx.timer = setInterval(() => { if (!hidden) captureNow().catch(() => null) }, 5000)
      update(ctx, { autoTracking: true, backgroundTracking: mode === 'background', trackingState: mode,
        trackingErrorText: backgroundError,
        trackingWarningText: mode === 'background' ? '可切换页面、返回微信或桌面；请保持微信运行及系统定位开启。进程被终止后可能中断。' : '仅前台定位：小程序内切页不受影响，返回微信或桌面将暂停，请开启后台定位。',
        trackStatusText: mode === 'background' ? '后台轨迹记录中' : '前台轨迹记录中' })
      if (!hidden) captureNow().catch(() => null)
    } catch (error) {
      await stopNative()
      if (valid()) {
        detach(ctx)
        update(ctx, { autoTracking: false, backgroundTracking: false, trackingState: 'error', trackingErrorText: errorText(error),
          trackingWarningText: '自动轨迹未开启，请检查微信与系统定位权限后重试。', trackStatusText: '自动轨迹未开启' })
      }
    }
  }).then(() => getSnapshot()).finally(() => { if (ctx.startPromise === request) ctx.startPromise = null })
  ctx.startPromise = request
  return request
}
function toPoint(location) {
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude)) ||
      Math.abs(Number(location.latitude)) <= 0.000001 || Math.abs(Number(location.longitude)) <= 0.000001) return null
  const raw = location.recordedAt || location.timestamp
  const n = Number(raw)
  return { latitude: Number(location.latitude), longitude: Number(location.longitude),
    accuracy: Number(location.accuracy || location.horizontalAccuracy || 0), speed: Number(location.speed || 0),
    recordedAt: n > 0 && Number.isFinite(n) ? (n < 100000000000 ? n * 1000 : n) : (raw || Date.now()),
    coordinateType: 'gcj02', locationSource: 'gps' }
}
function shouldRecord(ctx, point, force) {
  if (!isGoodTrackPoint(point) || Math.abs(Date.now() - pointTime(point.recordedAt)) > 15000) return false
  const previous = ctx.last
  if (!previous || pointTime(point.recordedAt) - pointTime(previous.recordedAt) > MAX_GAP_MS) {
    const warmup = ctx.warmup
    ctx.warmup = point
    if (!warmup || pointTime(point.recordedAt) - pointTime(warmup.recordedAt) > 60000 || !isPlausibleStep(warmup, point)) return false
  } else if (!isPlausibleStep(previous, point)) return false
  if (force || !previous) return true
  const elapsed = Date.now() - ctx.lastAcceptedAt
  if (elapsed < 2000) return false
  return elapsed >= 5000 || distanceM(previous, point) >= Math.max(3, Math.min(6, (point.accuracy + previous.accuracy) / 3))
}
function record(ctx, location, force) {
  if (!current(ctx) || ctx.frozen) return Promise.resolve(null)
  const point = toPoint(location)
  if (!point || !shouldRecord(ctx, point, force)) {
    update(ctx, { trackStatusText: '等待稳定定位，低精度或跳跃位置不会记录' })
    return Promise.resolve(null)
  }
  point.segmentId = ctx.segment
  point.clientPointId = createClientRequestId('track')
  ctx.last = point
  ctx.warmup = null
  ctx.lastAcceptedAt = Date.now()
  ctx.queue.push(point)
  return drain(ctx)
}
function drain(ctx) {
  if (ctx.drain) return ctx.drain
  if (!ctx.queue.length) return Promise.resolve(null)
  const request = (async () => {
    let result = null
    while (ctx.queue.length) {
      const points = ctx.queue.splice(0, 20)
      // Owner/order/session belong to this capture, not to the latest global state.
      if (identityGeneration !== ctx.identityGeneration || !isOfflineOwner(ctx.owner) || identity !== ctx.owner) continue
      try {
        result = await cloud.callFunction('track', 'batchUploadTrack', {
          orderId: ctx.orderId, batchId: createClientRequestId('batch'), points
        })
        if (!current(ctx)) continue
        const count = Number(result && result.count || 0)
        const sameSegment = points[0].segmentId === ctx.segment
        if (sameSegment && !count && result && result.rejectedCount) { ctx.last = null; ctx.warmup = null; ctx.lastAcceptedAt = 0 }
        update(ctx, { pointCount: snapshot.pointCount + count, offlineTaskCount: getOfflineTaskCount(ctx.orderId),
          latestTrackText: count ? `最近记录：${formatDateTime(points[points.length - 1].recordedAt).slice(6)}，精度${Math.round(points[points.length - 1].accuracy)}m` : snapshot.latestTrackText,
          trackStatusText: count ? '位置已记录' : (result && result.rejectedCount ? '定位质量不足，已忽略本次位置' : '位置已记录') })
      } catch (error) {
        const message = error && (error.message || error.errMsg) || ''
        if (current(ctx) && /仅订单员工可上传轨迹|仅服务中或结束后的补传窗口内可上传轨迹/.test(message)) {
          ctx.queue.length = 0
          stop({ orderId: ctx.orderId, reason: 'inactive' })
        }
        if (identityGeneration === ctx.identityGeneration && identity === ctx.owner && isOfflineOwner(ctx.owner) && /network|timeout|fail/i.test(message)) {
          points.forEach(point => enqueueOfflineTask('track', { orderId: ctx.orderId, point: { ...point, isBackfilled: true }, clientPointId: point.clientPointId }))
        }
        update(ctx, { offlineTaskCount: getOfflineTaskCount(ctx.orderId), trackingErrorText: errorText(error) })
        result = null
      }
    }
    return result
  })().finally(() => { if (ctx.drain === request) ctx.drain = null })
  ctx.drain = request
  return request
}
function sample(ctx, force, final = false) {
  if (!current(ctx) || ctx.frozen || (!final && ctx.finishing) || hidden || (!ctx.running && (!force || final))) return Promise.resolve(null)
  if (ctx.capture) return ctx.capture
  const generation = ctx.generation
  // A user-requested manual point is still useful when continuous tracking is
  // unavailable. Automatic sampling/finish must never open a privacy prompt.
  const privacy = force && !final ? cloud.requirePrivacyAuthorize() : Promise.resolve()
  const request = Promise.resolve(privacy)
    .then(() => current(ctx) && generation === ctx.generation
      ? native('getLocation', { type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 6000 }) : null)
    .then(location => current(ctx) && generation === ctx.generation && (!ctx.finishing || final) ? record(ctx, location, force) : null)
    .finally(() => { if (ctx.capture === request) ctx.capture = null })
  ctx.capture = request
  return request
}
function captureNow({ force = false } = {}) {
  const ctx = context
  if (!ctx) return Promise.resolve(null)
  return sample(ctx, force).then(result => current(ctx)
    ? flushOfflineTasks().then(() => current(ctx) ? result : null)
    : null)
}
function getSnapshot() { return { ...snapshot } }
function subscribe(listener) {
  listeners.add(listener)
  try { listener(getSnapshot()) } catch (_) {}
  return () => listeners.delete(listener)
}
function ensureTracking(order, { interactive = false } = {}) {
  handleIdentityChange(cloud.getCachedUser())
  if (!identity || !staff(cloud.getCachedUser()) || !orderIdOf(order)) return Promise.resolve(getSnapshot())
  const key = sessionKey(order)
  if (order.status !== 'in_service') {
    return context && context.key === key ? stop({ orderId: context.orderId, reason: 'inactive' }) : Promise.resolve(getSnapshot())
  }
  if (endedSessions.has(key)) return Promise.resolve(getSnapshot())
  if (context && context.key === key) {
    context.order = { ...context.order, ...order }
    update(context, { pointCount: Math.max(snapshot.pointCount, Number(order.trackCount || 0)) })
    return start(context, interactive)
  }
  if (context) stop({ orderId: context.orderId, reason: 'replaced' })
  revision += 1
  const ctx = { key, owner: identity, identityGeneration, orderId: orderIdOf(order), order: { ...order }, queue: [], generation: 0,
    running: false, frozen: false, finishing: false, segment: createClientRequestId('segment') }
  context = ctx
  publish({ ...idle, orderId: ctx.orderId, pointCount: Number(order.trackCount || 0), offlineTaskCount: getOfflineTaskCount(ctx.orderId) })
  return start(ctx, interactive)
}
function stop({ orderId, reason = 'stopped' } = {}) {
  const ctx = context
  if (!ctx) return pendingStop && (!orderId || pendingStop.orderId === orderId) ? pendingStop.promise : Promise.resolve(getSnapshot())
  if (orderId && ctx.orderId !== orderId) return Promise.resolve(getSnapshot())
  revision += 1
  if (reason !== 'identity_change') endedSessions.add(ctx.key)
  ctx.cancelled = true
  ctx.generation += 1
  detach(ctx)
  context = null
  publish({ ...idle, trackStatusText: reason === 'identity_change' ? '身份已变更，轨迹记录已停止' : idle.trackStatusText })
  const stopped = serial(stopNative)
  const promise = Promise.all([stopped, drain(ctx)]).then(() => getSnapshot()).finally(() => {
    if (pendingStop && pendingStop.promise === promise) pendingStop = null
  })
  pendingStop = { orderId: ctx.orderId, promise }
  return promise
}
function retryBackgroundTracking() {
  const ctx = context
  if (!ctx || ctx.finishing || ctx.frozen) return Promise.resolve(getSnapshot())
  if (ctx.startPromise) return ctx.startPromise
  return pause(ctx).then(() => current(ctx) ? start(ctx, true) : getSnapshot())
}
function prepareFinish(orderId) {
  const ctx = context
  if (!ctx || ctx.orderId !== orderId) return Promise.resolve(null)
  if (ctx.finishPromise) return ctx.finishPromise
  revision += 1
  endedSessions.add(ctx.key)
  ctx.finishing = true
  ctx.finishPromise = (async () => {
    await Promise.resolve(ctx.capture).catch(() => null)
    await sample(ctx, true, true).catch(() => null)
    if (!current(ctx)) return null
    ctx.frozen = true
    await pause(ctx)
    update(ctx, { autoTracking: false, backgroundTracking: false, trackingState: 'finishing', trackStatusText: '轨迹已冻结，正在完成服务' })
    await drain(ctx)
    return current(ctx) ? flushOfflineTasks() : null
  })()
  return ctx.finishPromise
}
async function resumeAfterFinishFailure(order) {
  const ctx = context
  const key = sessionKey(order)
  if (!ctx || ctx.key !== key || !current(ctx)) {
    await reconcileActiveService()
    return getSnapshot()
  }
  await ctx.finishPromise
  if (!current(ctx)) return getSnapshot()
  ctx.frozen = false
  ctx.finishing = false
  ctx.finishPromise = null
  endedSessions.delete(key)
  return ensureTracking(order, { interactive: false })
}
function handleIdentityChange(user) {
  const next = ownerOf(user)
  if (identity === next) {
    if (context && !staff(user)) stop({ orderId: context.orderId, reason: 'identity_change' })
    return
  }
  identity = next
  identityGeneration += 1
  revision += 1
  reconcileRequest = null
  if (context) stop({ orderId: context.orderId, reason: 'identity_change' })
}
function reconcileActiveService() {
  if (reconcileRequest) return reconcileRequest
  const expectedRevision = revision
  const expectedOwner = identity
  const request = (async () => {
    const user = await cloud.getCurrentUser({ silent: true, sessionOnly: true })
    if (expectedRevision !== revision || expectedOwner !== identity) {
      // Initial silent identity discovery can notify us before this await resumes.
      if (expectedOwner || context || !user || identity !== ownerOf(user)) return null
    }
    handleIdentityChange(user)
    if (!staff(user)) {
      if (context) await stop({ orderId: context.orderId, reason: 'inactive' })
      return null
    }
    const owner = ownerOf(user), queryRevision = revision
    const active = await cloud.callFunction('order', 'getActiveService')
    if (owner !== identity || owner !== ownerOf(cloud.getCachedUser()) || queryRevision !== revision) return null
    if (!active) { if (context) await stop({ orderId: context.orderId, reason: 'inactive' }); return null }
    await ensureTracking({ ...active, status: 'in_service' }, { interactive: false })
    return active
  })().catch(() => null).finally(() => { if (reconcileRequest === request) reconcileRequest = null })
  reconcileRequest = request
  return request
}
function onAppShow() {
  hidden = false
  handleIdentityChange(cloud.getCachedUser())
  const ctx = context
  if (ctx && current(ctx) && !ctx.finishing && !ctx.frozen && !ctx.startPromise && !ctx.recovery) {
    // Revalidate native tracking after returning from system settings or an OS
    // suspension. The existing confirmed session can resume even while offline.
    ctx.recovery = pause(ctx).then(() => current(ctx) && !hidden ? start(ctx, false) : null)
      .finally(() => { ctx.recovery = null })
  }
  return Promise.all([ctx && ctx.recovery, reconcileActiveService()]).then(([, active]) => active)
}
function onAppHide() {
  hidden = true
  const ctx = context
  if (!ctx || !ctx.running || ctx.mode === 'background') return Promise.resolve(getSnapshot())
  const result = pause(ctx)
  update(ctx, { autoTracking: false, backgroundTracking: false, trackingState: 'paused', trackStatusText: '返回小程序后恢复前台定位' })
  return result.then(() => getSnapshot())
}
function flushOfflineTasks() {
  const ctx = context
  if (!ctx || !current(ctx)) return Promise.resolve(null)
  return flushServiceOfflineTasks(ctx.orderId).then(result => {
    update(ctx, { offlineTaskCount: result.offlineTaskCount })
    return result
  })
}
if (typeof cloud.subscribeIdentityChange === 'function') cloud.subscribeIdentityChange(handleIdentityChange)

module.exports = { ensureTracking, getSnapshot, subscribe, stop, retryBackgroundTracking, captureNow,
  prepareFinish, resumeAfterFinishFailure, onAppShow, onAppHide, handleIdentityChange, reconcileActiveService, flushOfflineTasks }
