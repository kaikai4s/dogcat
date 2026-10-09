const cloud = require('wx-server-sdk')
const { performance } = require('node:perf_hooks')
const initializedAt = performance.now()
const createContext = require('./services/context')
const createRegistry = require('./handlers')

const context = createContext(require('./config/database')(cloud))
const getHandler = createRegistry(context)
let scheduled
let paymentCallback
const initializationMs = Math.round((performance.now() - initializedAt) * 100) / 100
let firstInvocation = true

function isTimerTriggerEvent(event) {
  if (!event || typeof event !== 'object') return false
  return event.Type === 'Timer' ||
    event.Type === 'timer' ||
    event.type === 'timer' ||
    Boolean(event.TriggerName) ||
    Boolean(event.triggerName)
}

function isWechatPayHttpCallback(event) {
  return !event.module && !event.name && !event.action &&
    Boolean(event.httpMethod || event.requestContext) &&
    Boolean(event.body || event.rawBody)
}

exports.main = async (event = {}) => {
  const started = performance.now()
  const coldStart = firstInvocation
  firstInvocation = false
  let route = 'unknown'
  let success = false
  try {
    const { OPENID } = cloud.getWXContext()
    if (isTimerTriggerEvent(event)) {
      route = 'timer'
      if (OPENID) throw new Error('客户端不可触发定时任务')
      if (!scheduled) scheduled = require('./scheduled')(context)
      const result = context.ok(await scheduled())
      success = true
      return result
    }
    if (isWechatPayHttpCallback(event)) {
      route = 'paymentCallback'
      if (OPENID) throw new Error('客户端不可触发支付回调')
      if (!paymentCallback) paymentCallback = require('./services/paymentCallback')(context)
      const result = await paymentCallback({
        headers: event.headers || event.header || {},
        rawBody: event.rawBody,
        body: event.body,
        isBase64Encoded: event.isBase64Encoded === true
      })
      success = Number(result.statusCode || 200) < 400
      return result
    }
    const moduleName = event.module || event.name
    const handler = getHandler(moduleName)
    if (!handler) throw new Error(`未知模块：${moduleName}`)
    route = moduleName
    const result = context.ok(await context.runAdminRequest(moduleName, event.action, event.data || {},
      () => handler(OPENID, event.action, event.data || {})))
    success = true
    return result
  } catch (error) {
    return context.fail(error.message, error.code)
  } finally {
    console.info('[api-performance]', { route, success, coldStart,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...(coldStart ? { initializationMs } : {}) })
  }
}
