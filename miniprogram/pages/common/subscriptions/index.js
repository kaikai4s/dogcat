const { callFunction, setCachedSystemSettings, ensureLogin, requestSubscribeTemplates, showError } = require('../../../utils/cloud')

const catalog = {
  orderAccepted: ['接单成功通知', '宠托师接单后，及时了解服务安排'],
  serviceStart: ['服务进度通知', '接收服务开始、时间调整等重要提醒'],
  serviceFinish: ['服务完成通知', '服务完成后，及时查看服务报告'],
  orderPaid: ['支付成功通知', '订单支付成功后接收确认消息'],
  orderAssigned: ['订单派单通知', '平台为订单安排宠托师时通知你'],
  remoteUnlock: ['远程开门通知', '宠托师到达并请求开门时通知你'],
  refundResult: ['退款结果通知', '及时了解订单退款处理结果'],
  disputeUpdate: ['售后进度通知', '售后处理有新进展时通知你'],
  upcomingServiceReminder: ['即将服务提醒', '服务开始前提醒你提前做好准备'],
  withdrawResult: ['提现结果通知', '提现审核或打款后接收结果提醒']
}

Page({
  data: {
    role: 'client', loading: true, loadFailed: false, ready: false,
    enabled: false, mainSwitch: null, groups: [], busy: false,
    pendingKeys: [], pendingScope: '', feedback: '', availableCount: 0
  },
  onLoad(query = {}) {
    this.setData({ role: query.role === 'staff' ? 'staff' : 'client' })
    this._lastResults = {}
    this._wechatSettings = {}
    this.load()
  },
  onShow() {
    this.refreshWechatSettings()
  },
  load() {
    this.setData({ loading: true, loadFailed: false })
    return ensureLogin({ content: '登录后可管理订阅消息通知。' })
      .then(() => callFunction('system', 'getSettings'))
      .then((settings) => {
        this._settings = setCachedSystemSettings(settings)
        this.setData({ loading: false, ready: true, enabled: !!this._settings.subscription.enabled })
        this.updateGroups()
      }).catch((error) => {
        this.setData({ loading: false, loadFailed: true, ready: false })
        if (!error || error.code !== 'LOGIN_CANCELLED') showError(error)
      })
  },
  templateId(key) {
    const templates = this._settings && this._settings.subscription.templates || {}
    return templates[key] || (key === 'upcomingServiceReminder' ? templates.serviceStart : '') || ''
  },
  updateGroups() {
    const sections = this.data.role === 'staff'
      ? [['common', '常用消息', ['upcomingServiceReminder', 'serviceStart', 'serviceFinish']], ['other', '其他消息', ['withdrawResult', 'disputeUpdate']]]
      : [['common', '常用消息', ['orderAccepted', 'serviceStart', 'serviceFinish']], ['other', '其他消息', ['orderPaid', 'orderAssigned', 'remoteUnlock', 'refundResult', 'disputeUpdate']]]
    const setting = this._wechatSettings || {}
    const groups = sections.map(([id, title, keys]) => {
      const items = keys.map((key) => {
        const templateId = this.templateId(key)
        const status = setting.itemsSetting && setting.itemsSetting[templateId] || this._lastResults[templateId] || ''
        const available = this.data.enabled && !!templateId
        const statusText = !available ? '暂未开放' : this.data.mainSwitch === false ? '微信订阅开关已关闭'
          : status === 'accept' ? '已允许接收，可再次订阅'
          : status === 'reject' ? '暂未允许，可重新订阅'
          : status === 'ban' ? '通知已被关闭，请检查微信设置'
          : status === 'filter' ? '本次未获授权，可单独订阅' : '等待订阅授权'
        return { key, title: catalog[key][0], desc: catalog[key][1], available, statusText, accepted: available && status === 'accept' && this.data.mainSwitch !== false }
      })
      return { id, title, items, available: items.some((item) => item.available) }
    })
    this.setData({ groups, availableCount: groups.reduce((sum, group) => sum + group.items.filter((item) => item.available).length, 0) })
  },
  applyWechatSettings(result = {}) {
    this._wechatSettings = result.subscriptionsSetting || {}
    const mainSwitch = this._wechatSettings.mainSwitch
    this.setData({ mainSwitch: typeof mainSwitch === 'boolean' ? mainSwitch : null })
    this.updateGroups()
  },
  refreshWechatSettings() {
    if (typeof wx.getSetting !== 'function') return
    wx.getSetting({ withSubscriptions: true, success: (result) => this.applyWechatSettings(result) })
  },
  openSettings() {
    wx.openSetting({ withSubscriptions: true, success: (result) => this.applyWechatSettings(result), fail: showError })
  },
  subscribe(e) {
    if (!this.data.ready || this.data.busy || !this.data.enabled) return
    if (this.data.mainSwitch === false) {
      this.openSettings()
      return
    }
    const scope = e.currentTarget.dataset.scope || 'all'
    let keys
    if (this.data.pendingScope === scope && this.data.pendingKeys.length) keys = this.data.pendingKeys
    else keys = this.data.groups.filter((group) => scope === 'all' || scope === group.id || group.items.some((item) => item.key === scope))
      .flatMap((group) => group.items.filter((item) => item.available && (scope === 'all' || scope === group.id || item.key === scope)).map((item) => item.key))
    const ids = Array.from(new Set(keys.map((key) => this.templateId(key)))).slice(0, 5)
    const batch = keys.filter((key) => ids.includes(this.templateId(key)))
    if (!batch.length) return
    this.setData({ busy: true, feedback: '' })
    // This call must run synchronously within the user's tap; no login/network await here.
    return requestSubscribeTemplates(batch, `notification_center_${this.data.role}`, { settings: this._settings, waitForConsent: false })
      .then((result) => {
        if (!result.requested) {
          if (Number(result.errorCode) === 20004) this.setData({ mainSwitch: false })
          this.setData({ feedback: Number(result.errorCode) === 20004 ? '请先打开微信订阅消息开关，再回来订阅。' : '本次订阅未完成，请重试或在微信设置中检查通知权限。' })
          return
        }
        const results = result.results || {}
        this._lastResults = { ...this._lastResults, ...results }
        const itemsSetting = { ...(this._wechatSettings.itemsSetting || {}) }
        ids.forEach((id) => { if (results[id]) itemsSetting[id] = results[id] })
        this._wechatSettings.itemsSetting = itemsSetting
        const accepted = ids.filter((id) => results[id] === 'accept').length
        const pendingKeys = keys.filter((key) => !batch.includes(key))
        this.setData({
          pendingKeys, pendingScope: pendingKeys.length ? scope : '',
          feedback: `本次已同意 ${accepted} 项通知。${accepted < ids.length ? '未同意的通知可单独重新订阅。' : ''}${pendingKeys.length ? '还有其他通知，请点击继续订阅。' : ''}`
        })
      }).catch(showError).finally(() => {
        this.setData({ busy: false })
        this.updateGroups()
      })
  }
})
