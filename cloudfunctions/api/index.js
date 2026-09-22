const cloud = require('wx-server-sdk')
const createContext = require('./services/context')
const createRegistry = require('./handlers')

const context = createContext(require('./config/database')(cloud))
const getHandler = createRegistry(context)
let scheduled
let paymentCallback

function isWechatPayHttpCallback(event) {
  return !event.module && !event.name && !event.action &&
    Boolean(event.httpMethod || event.requestContext) &&
    Boolean(event.body || event.rawBody)
}

exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext()
    if (event.Type === 'Timer') {
      if (OPENID) throw new Error('客户端不可触发定时任务')
      if (!scheduled) scheduled = require('./scheduled')(context)
      return context.ok(await scheduled())
    }
    if (isWechatPayHttpCallback(event)) {
      if (OPENID) throw new Error('客户端不可触发支付回调')
      if (!paymentCallback) paymentCallback = require('./services/paymentCallback')(context)
      return await paymentCallback({
        headers: event.headers || event.header || {},
        rawBody: event.rawBody,
        body: event.body,
        isBase64Encoded: event.isBase64Encoded === true
      })
    }
    const moduleName = event.module || event.name
    const handler = getHandler(moduleName)
    if (!handler) throw new Error(`未知模块：${moduleName}`)
    return context.ok(await context.runAdminRequest(moduleName, event.action, event.data || {},
      () => handler(OPENID, event.action, event.data || {})))
  } catch (error) {
    return context.fail(error.message, error.code)
  }
}
