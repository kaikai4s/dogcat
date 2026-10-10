const { getCachedSystemSettings, loadSystemSettings, showError } = require('../../utils/cloud')
const { safeNavigateTo } = require('../../utils/nav')
const { availableSubscriptionIds } = require('../../utils/subscription-options')

Component({
  properties: { role: { type: String, value: 'client' }, themeClass: { type: String, value: 'theme-day' } },
  data: { description: '及时接收订单和服务提醒，点击查看订阅状态', actionText: '去订阅' },
  lifetimes: {
    attached() { this._active = true; this.refresh() },
    detached() { this._active = false; this._refreshSeq = (this._refreshSeq || 0) + 1 }
  },
  pageLifetimes: {
    show() { this._active = true; this.refresh() },
    hide() { this._active = false; this._refreshSeq = (this._refreshSeq || 0) + 1 }
  },
  methods: {
    refresh() {
      this._settings = getCachedSystemSettings()
      this.updateReminder()
      const seq = this._refreshSeq = (this._refreshSeq || 0) + 1
      const current = () => this._active && seq === this._refreshSeq
      if (typeof wx.getSetting === 'function') wx.getSetting({ withSubscriptions: true, success: result => {
        if (!current()) return
        this._wechat = result.subscriptionsSetting || {}
        this.updateReminder()
      } })
      return loadSystemSettings().then(settings => {
        if (!current()) return
        this._settings = settings
        this.updateReminder()
      }).catch(() => {})
    },
    updateReminder() {
      const subscription = this._settings && this._settings.subscription || {}
      const ids = availableSubscriptionIds(this._settings, this.properties.role)
      const setting = this._wechat || {}
      const allowed = ids.filter(id => setting.itemsSetting && setting.itemsSetting[id] === 'accept').length
      const description = !subscription.enabled ? '平台暂未开启通知，可进入订阅中心查看'
        : !ids.length ? '平台尚未配置通知模板，可进入订阅中心查看'
        : setting.mainSwitch === false ? '微信订阅消息已关闭，打开设置后才能接收提醒'
        : allowed === ids.length ? '微信已允许通知；一次订阅对应一次提醒，可继续补充'
        : `有 ${ids.length} 项通知可订阅，请授权以免错过重要提醒`
      this.setData({ description, actionText: setting.mainSwitch === false ? '去开启' : allowed && allowed === ids.length ? '管理订阅' : '去订阅' })
    },
    openCenter() {
      safeNavigateTo({ url: `/pages/common/subscriptions/index?role=${this.properties.role === 'staff' ? 'staff' : 'client'}`, fail: showError })
    }
  }
})
