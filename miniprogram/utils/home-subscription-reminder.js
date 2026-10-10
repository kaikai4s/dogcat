const { getCachedSystemSettings, loadSystemSettings } = require('./cloud')
const { availableSubscriptionIds } = require('./subscription-options')

function reminderState(settings, wechat, role) {
  const subscription = settings && settings.subscription || {}
  const ids = availableSubscriptionIds(settings, role)
  const setting = wechat || {}
  const allowed = ids.filter(id => setting.itemsSetting && setting.itemsSetting[id] === 'accept').length
  const description = !subscription.enabled ? '平台暂未开启通知，可进入订阅中心查看'
    : !ids.length ? '平台尚未配置可用通知模板，可进入订阅中心查看'
    : setting.mainSwitch === false ? '微信订阅消息已关闭，打开设置后才能接收提醒'
    : allowed === ids.length ? '微信已允许通知；一次订阅对应一次提醒，可继续补充'
    : `有 ${ids.length} 项通知可订阅，请授权以免错过重要提醒`
  return { description, actionText: setting.mainSwitch === false ? '去开启' : allowed && allowed === ids.length ? '管理订阅' : '去订阅' }
}

function refreshHomeSubscriptionReminder(page, role) {
  const seq = page._subscriptionReminderSeq = (page._subscriptionReminderSeq || 0) + 1
  const current = () => seq === page._subscriptionReminderSeq
  let settings = getCachedSystemSettings()
  const update = () => {
    if (current()) page.setData({ subscriptionReminder: reminderState(settings, page._subscriptionWechat, role) })
  }
  update()
  if (typeof wx.getSetting === 'function') wx.getSetting({ withSubscriptions: true, success: result => {
    if (!current()) return
    page._subscriptionWechat = result.subscriptionsSetting || {}
    update()
  } })
  return loadSystemSettings().then(fresh => {
    settings = fresh
    update()
  }).catch(() => {})
}

function invalidateHomeSubscriptionReminder(page) {
  page._subscriptionReminderSeq = (page._subscriptionReminderSeq || 0) + 1
}

module.exports = { refreshHomeSubscriptionReminder, invalidateHomeSubscriptionReminder }
