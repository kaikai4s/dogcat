const { callFunction, setCachedSystemSettings, ensureLogin, requestSubscribeTemplates, showError } = require('../../../utils/cloud')
const { subscriptionSections, subscriptionTemplateIssue } = require('../../../utils/subscription-options')

const catalog = {
  staffDirectOrder: ['指定单通知', '客户指定预约或平台派单后，及时查看服务安排'],
  orderAccepted: ['接单成功通知', '宠托师接单后，及时了解服务安排'],
  staffDeparture: ['宠托师出发通知', '宠托师出发时，接收预约时间、出发时间和姓名'],
  serviceStart: ['服务开始通知', '宠托师正式开始服务后，及时接收提醒'],
  serviceProgress: ['服务进度通知', '接收提前开始申请、即将到达及超时等提醒'],
  serviceFinish: ['服务完成通知', '服务完成后，及时查看服务报告'],
  orderPaid: ['支付成功通知', '订单支付成功后接收确认消息'],
  orderAssigned: ['订单派单通知', '平台为订单安排宠托师时通知你'],
  remoteUnlock: ['远程开门通知', '宠托师到达并请求开门时通知你'],
  refundResult: ['退款结果通知', '服务及商城订单退款成功或失败后，接收本次金额和处理结果'],
  disputeUpdate: ['售后进度通知', '暂未开放，请在订单售后详情查看处理进度'],
  upcomingServiceReminder: ['服务订单提醒', '服务前提醒时间段、地点和宠物信息'],
  withdrawResult: ['提现结果通知', '提现审核或打款后接收结果提醒']
}

Page({
  data: {
    role: 'client', loading: true, loadFailed: false, ready: false,
    enabled: false, mainSwitch: null, groups: [], busy: false,
    pendingKeys: [], pendingScope: '', feedback: '', availableCount: 0,
    singleMode: false, batchTotal: 0, batchAccepted: 0, batchRemaining: 0, invalidCount: 0
  },
  onLoad(query = {}) {
    this.setData({ role: query.role === 'staff' ? 'staff' : 'client' })
    this._lastResults = {}
    this._invalidTemplateIds = new Set()
    this._wechatSettings = {}
    this.load()
  },
  onShow() {
    if (!this.data.busy) {
      this.refreshWechatSettings()
      this.load()
    }
  },
  load() {
    if (this._loadingSettings) return this._loadingSettings
    this.setData({ loading: true, loadFailed: false, ready: false })
    this._loadingSettings = ensureLogin({ content: '登录后可管理订阅消息通知。' })
      .then(() => callFunction('system', 'getSettings'))
      .then((settings) => {
        const previous = JSON.stringify(this._settings && this._settings.subscription)
        this._settings = setCachedSystemSettings(settings)
        const changed = previous !== JSON.stringify(this._settings.subscription)
        if (changed) this._batchAcceptedIds = new Set()
        this.setData({ loading: false, ready: true, enabled: !!this._settings.subscription.enabled,
          ...(changed ? { pendingKeys: [], pendingScope: '', feedback: '', singleMode: false, batchTotal: 0, batchAccepted: 0, batchRemaining: 0 } : {}) })
        this.updateGroups()
      }).catch((error) => {
        this.setData({ loading: false, loadFailed: true, ready: false })
        if (!error || error.code !== 'LOGIN_CANCELLED') showError(error)
      }).finally(() => { this._loadingSettings = null })
    return this._loadingSettings
  },
  templateId(key) {
    const templates = this._settings && this._settings.subscription.templates || {}
    return String(templates[key] || '').trim()
  },
  reloadConfiguration() {
    if (this.data.busy) return
    this._invalidTemplateIds = new Set()
    this._lastResults = {}
    this._batchAcceptedIds = new Set()
    this.setData({ pendingKeys: [], pendingScope: '', singleMode: false, batchTotal: 0, batchAccepted: 0, batchRemaining: 0, feedback: '' })
    return this.load()
  },
  updateGroups() {
    const sections = subscriptionSections(this.data.role)
    const setting = this._wechatSettings || {}
    const groups = sections.map(([id, title, keys]) => {
      const items = keys.map((key) => {
        const templateId = this.templateId(key)
        const status = this._lastResults[templateId] || setting.itemsSetting && setting.itemsSetting[templateId] || ''
        const issue = subscriptionTemplateIssue(templateId)
        const invalid = !!templateId && (!!issue || this._invalidTemplateIds.has(templateId))
        // This legacy key is configurable but has no business sender yet.
        const available = key !== 'disputeUpdate' && this.data.enabled && !issue && !invalid
        const statusText = key === 'disputeUpdate' ? '暂未开放'
          : invalid ? '模板不可用，请联系平台核对配置'
          : issue ? issue : !this.data.enabled ? '平台暂未开启订阅通知' : this.data.mainSwitch === false ? '微信订阅开关已关闭'
          : status === 'accept' ? '已允许接收，可再次订阅'
          : status === 'reject' ? '暂未允许，可重新订阅'
          : status === 'ban' ? '通知已被关闭，请检查微信设置'
          : status === 'invalid' ? '模板不可用，请联系平台核对配置'
          : status === 'filter' ? '本次未获授权，可单独订阅' : '等待订阅授权'
        return { key, title: catalog[key][0], desc: catalog[key][1], available, invalid, statusText, accepted: available && status === 'accept' && this.data.mainSwitch !== false }
      })
      return { id, title, items, available: items.some((item) => item.available) }
    })
    this.setData({ groups, availableCount: groups.reduce((sum, group) => sum + group.items.filter((item) => item.available).length, 0),
      invalidCount: groups.reduce((sum, group) => sum + group.items.filter(item => item.key !== 'disputeUpdate' && item.invalid).length, 0) })
  },
  applyWechatSettings(result = {}) {
    this._wechatSettings = result.subscriptionsSetting || {}
    const mainSwitch = this._wechatSettings.mainSwitch
    this.setData({ mainSwitch: typeof mainSwitch === 'boolean' ? mainSwitch : null })
    this.updateGroups()
  },
  refreshWechatSettings() {
    if (typeof wx.getSetting !== 'function') return
    const seq = this._wechatReadSeq = (this._wechatReadSeq || 0) + 1
    wx.getSetting({ withSubscriptions: true, success: (result) => {
      if (seq === this._wechatReadSeq) this.applyWechatSettings(result)
    } })
  },
  openSettings() {
    wx.openSetting({ withSubscriptions: true, success: (result) => {
      this._lastResults = {}
      this.applyWechatSettings(result)
      this.setData({ feedback: '返回后请点击订阅按钮申请通知；开启总开关不会自动完成订阅。' })
    }, fail: showError })
  },
  subscribe(e) {
    if (this.data.busy) return
    if (!this.data.ready || !this.data.enabled) {
      this.setData({ feedback: this.data.ready ? '平台暂未开启订阅通知，请联系平台确认后台配置。' : '通知配置正在加载，请稍后点击订阅。' })
      return
    }
    if (this.data.mainSwitch === false) {
      this.openSettings()
      return
    }
    const scope = e.currentTarget.dataset.scope || 'all'
    let keys
    if (this.data.pendingScope === scope && this.data.pendingKeys.length) keys = this.data.pendingKeys.filter(key => !this._invalidTemplateIds.has(this.templateId(key)))
    else {
      keys = this.data.groups.filter((group) => scope === 'all' || scope === group.id || group.items.some((item) => item.key === scope))
        .flatMap((group) => group.items.filter((item) => item.available && (scope === 'all' || scope === group.id || item.key === scope)).map((item) => item.key))
      this._batchAcceptedIds = new Set()
      this.setData({ singleMode: false, batchTotal: new Set(keys.map(key => this.templateId(key))).size, batchAccepted: 0, batchRemaining: 0 })
    }
    const ids = Array.from(new Set(keys.map((key) => this.templateId(key)))).slice(0, this.data.singleMode ? 1 : 3)
    const batch = keys.filter((key) => ids.includes(this.templateId(key)))
    if (!batch.length) {
      this.setData({ feedback: '暂无可订阅的通知，请联系平台配置模板。' })
      return
    }
    this._wechatReadSeq = (this._wechatReadSeq || 0) + 1
    this.setData({ busy: true, feedback: '' })
    // This call must run synchronously within the user's tap; no login/network await here.
    return requestSubscribeTemplates(batch, `notification_center_${this.data.role}`, { settings: this._settings, waitForConsent: false })
      .then((result) => {
        if (!result.requested) {
          const code = Number(result.errorCode)
          if (code === 20004) this.setData({ mainSwitch: false })
          // Invalid/mixed templates can make WeChat reject the entire request before
          // showing a dialog. Retry individually on the NEXT tap, never automatically.
          const invalidBatch = [20001, 20002, 20003].includes(code)
          const pendingKeys = invalidBatch && ids.length === 1 ? keys.filter(key => !batch.includes(key)) : keys
          const feedback = code === 20004 ? '微信订阅消息总开关已关闭，请先打开微信通知设置，再回来点击订阅。'
            : invalidBatch ? (ids.length > 1 ? '微信未弹出授权窗口：本批模板配置异常，点击继续订阅将逐项申请。'
              : `${batch.map(key => catalog[key][0]).join('、')}的模板不可用，请平台核对模板 ID 是否属于当前小程序。${pendingKeys.length ? '可继续订阅其他通知。' : ''}`)
            : result.reason === 'request_api_unavailable' ? '当前微信版本不支持订阅消息，请更新微信后重试。'
            : result.reason === 'request_in_progress' ? '另一个订阅申请正在处理中，请稍后重试。'
            : '微信未完成授权，请再次点击重试；若已记住拒绝选择，请在微信通知设置中调整。'
          this.setData({ pendingKeys, pendingScope: pendingKeys.length ? scope : '', singleMode: invalidBatch || this.data.singleMode,
            batchRemaining: new Set(pendingKeys.map(key => this.templateId(key))).size,
            feedback: `${feedback}${Number.isFinite(code) ? `（微信错误码 ${code}）` : ''}` })
          if (code === 20001 && ids.length === 1) ids.forEach(id => {
            this._lastResults[id] = 'invalid'
            this._invalidTemplateIds.add(id)
          })
          return
        }
        const results = result.results || {}
        this._lastResults = { ...this._lastResults, ...results }
        const itemsSetting = { ...(this._wechatSettings.itemsSetting || {}) }
        ids.forEach((id) => {
          this._lastResults[id] = itemsSetting[id] = results[id] || 'unknown'
          if (results[id] === 'accept') this._batchAcceptedIds.add(id)
        })
        this._wechatSettings.itemsSetting = itemsSetting
        const accepted = ids.filter((id) => results[id] === 'accept').length
        const pendingKeys = keys.filter((key) => !batch.includes(key))
        this.setData({
          pendingKeys, pendingScope: pendingKeys.length ? scope : '',
          batchAccepted: this._batchAcceptedIds.size, batchRemaining: new Set(pendingKeys.map(key => this.templateId(key))).size,
          feedback: `本次已同意 ${accepted} 项通知。${accepted < ids.length ? '未同意的通知可单独重新订阅，或打开微信通知设置调整拒绝选择。' : ''}${pendingKeys.length ? '还有其他通知，请点击继续订阅。' : this._batchAcceptedIds.size === this.data.batchTotal ? '本轮所选通知已全部订阅。' : '本轮尚有未授权通知，请查看下方状态。'}`
        })
      }).catch(showError).finally(() => {
        this.setData({ busy: false })
        this.updateGroups()
      })
  }
})
