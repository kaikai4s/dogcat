const { callFunction, ensureLogin, getCachedUser, getCloudEnv, subscribeIdentityChange } = require('../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { applyFont, getFontState } = require('../../../utils/font')
const WELCOME = '您好！我是您的 AI 宠护小助手 🐾\n无论关于宠物饮食健康、出行习惯还是上门服务的准备事宜，我都能为您解答～\n\n📌 温馨提示：AI 回答仅供日常养宠参考，不能替代专业兽医诊断。若爱宠出现紧急症状或严重不适，请务必及时送医就诊。'
const welcomeMessages = () => [{ id: 'welcome', role: 'ai', content: WELCOME }]

function mergeRecords(older, newer) {
  const records = new Map()
  for (const row of [...older, ...newer]) {
    if (row && typeof row.id === 'string' && typeof row.question === 'string' && typeof row.answer === 'string') records.set(row.id, row)
  }
  return [...records.values()].sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0) || a.id.localeCompare(b.id))
}

function failureText(error, fallback) {
  const message = error && (error.message || error.errMsg) || fallback
  if (/-504003|FUNCTIONS_TIME_LIMIT_EXCEEDED|Invoking task timed out/.test(message)) return 'AI 回复超时，请稍后重试'
  if (/DATABASE_COLLECTION_NOT_EXIST|collection.*(?:not exist|not found)|集合不存在/i.test(message)) return '问答记录服务尚未就绪，请联系管理员'
  return message
}

Page({
  data: {
    themeClass: 'theme-day',
    fontClass: 'font-system',
    inputText: '',
    messages: welcomeMessages(),
    historyLoading: false,
    historyLoaded: false,
    historyError: '',
    historyCursor: '',
    errorText: '',
    retryText: '',
    loading: false
  },

  onLoad() {
    this._identity = this.identityKey(getCachedUser())
    this._records = []
    this._unsubscribeIdentity = subscribeIdentityChange(user => {
      if (this._closed || this.identityKey(user) === this._identity) return
      this.resetIdentity(user)
      if (user && !this._hidden) this.loadHistory()
    })
    return this.loadHistory()
  },

  onShow() {
    const returning = this._hidden
    this._hidden = false
    const theme = applyTheme()
    const font = applyFont()
    this.setData({
      ...getThemeState(theme.value),
      ...getFontState(font.value)
    })
    if (this.identityKey(getCachedUser()) !== this._identity) {
      this.resetIdentity(getCachedUser())
      this.loadHistory()
    } else if (returning && !this.data.loading) {
      this.loadHistory()
    }
  },

  onHide() {
    this._hidden = true
  },

  identityKey(user) {
    return JSON.stringify([getCloudEnv(), user && (user._id || user.openid) || 'guest'])
  },

  resetIdentity(user) {
    this._identity = this.identityKey(user)
    this._request = (this._request || 0) + 1
    this._historySeq = (this._historySeq || 0) + 1
    clearTimeout(this._requestTimer)
    clearTimeout(this._historyTimer)
    this._retryRequest = null
    this._records = []
    this._pendingMessages = []
    this.setData({ messages: welcomeMessages(), inputText: '', loading: false, errorText: '', retryText: '',
      historyLoading: false, historyLoaded: false, historyError: '', historyCursor: '' })
  },

  renderMessages() {
    const messages = welcomeMessages()
    for (const row of this._records || []) {
      messages.push({ id: `${row.id}-user`, role: 'user', content: row.question, time: row.generatedAt },
        { id: `${row.id}-ai`, role: 'ai', content: row.answer })
    }
    this.setData({ messages: [...messages, ...(this._pendingMessages || [])] })
  },

  async loadHistory(older = false) {
    if (this._closed || this.data.loading || this.data.historyLoading || (older && !this.data.historyCursor)) return
    this._historyRetryOlder = older
    const seq = this._historySeq = (this._historySeq || 0) + 1
    const active = () => !this._closed && this._historySeq === seq
    let timer
    this.setData({ historyLoading: true, historyError: '' })
    try {
      const user = await ensureLogin({ content: '登录后可查看 AI 问答记录。', isActive: active })
      if (!active() || !user) return
      if (this.identityKey(user) !== this._identity) {
        this.resetIdentity(user)
        return this.loadHistory()
      }
      const timeout = new Promise((_, reject) => {
        timer = this._historyTimer = setTimeout(() => reject(new Error('历史记录加载超时，请重试')), 15000)
      })
      const result = await Promise.race([callFunction('ai', 'listAiHistory', { cursor: older ? this.data.historyCursor : '' }), timeout])
      if (!active()) return
      if (!result || !Array.isArray(result.records)) throw new Error('历史记录加载失败，请重试')
      this._records = mergeRecords(older ? this._records || [] : [], result.records)
      this.setData({ historyLoaded: true, historyCursor: result.nextCursor || '' })
      if (this._retryRequest && this._records.some(row => row.clientRequestId === this._retryRequest.id)) {
        if (this.data.inputText === this._retryRequest.question) this.setData({ inputText: '' })
        this._retryRequest = null
        this.setData({ errorText: '', retryText: '' })
      }
      this.renderMessages()
      if (!older && this._records.length) wx.pageScrollTo({ scrollTop: 99999, duration: 0 })
    } catch (error) {
      if (active() && !(error && error.code === 'LOGIN_CANCELLED')) {
        this.setData({ historyError: failureText(error, '历史记录加载失败，请重试') })
      }
    } finally {
      clearTimeout(timer)
      if (active()) this.setData({ historyLoading: false })
    }
  },

  loadOlder() {
    return this.loadHistory(true)
  },

  retryHistory() {
    return this.loadHistory(Boolean(this._historyRetryOlder))
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value })
  },

  askPreset(e) {
    const text = e.currentTarget.dataset.text
    this.setData({ inputText: text }, () => {
      this.send()
    })
  },

  onUnload() {
    this._closed = true
    this._request = (this._request || 0) + 1
    this._historySeq = (this._historySeq || 0) + 1
    clearTimeout(this._requestTimer)
    clearTimeout(this._historyTimer)
    if (this._unsubscribeIdentity) this._unsubscribeIdentity()
  },

  retry() {
    if (!this.data.retryText || this.data.loading) return
    this.setData({ inputText: this.data.retryText })
    return this.send()
  },

  async send() {
    const q = this.data.inputText.trim()
    if (!q || this.data.loading || this.data.historyLoading || this._closed) return
    if (q.length > 300) {
      this.setData({ errorText: '咨询问题不能超过 300 字' })
      return
    }
    const request = this._request = (this._request || 0) + 1
    const active = () => !this._closed && this._request === request
    let timer
    this.setData({ loading: true, errorText: '', retryText: '' })
    try {
      const user = await ensureLogin({ content: '登录后可体验 AI 智能问答助手。', isActive: active })
      if (!active() || !user) return
      if (this._identity === undefined) this._identity = this.identityKey(user)
      if (this._identity !== this.identityKey(user)) {
        this.resetIdentity(user)
        return
      }
      if (!this._retryRequest || this._retryRequest.question !== q) {
        this._retryRequest = { question: q, id: `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` }
      }
      const requestId = this._retryRequest.id
      this._pendingMessages = [{ id: `${requestId}-user`, role: 'user', content: q },
        { id: `${requestId}-ai`, role: 'ai', content: '', pending: true }]
      this.renderMessages()
      this.setData({ inputText: '' })
      // Bound both model startup and a stalled stream; late output cannot mutate this request.
      const timeout = new Promise((_, reject) => {
        timer = this._requestTimer = setTimeout(() => reject(new Error('AI 回复超时，请稍后重试')), 45000)
      })
      const result = await Promise.race([callFunction('ai', 'aiPetAssistant', { question: q, clientRequestId: requestId }), timeout])
      if (!active()) return
      if (!result || typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('AI 暂未返回内容，请重试')
      this._records = mergeRecords(this._records || [], [{ id: result.id || requestId, question: q, answer: result.answer,
        generatedAt: result.generatedAt || '', createdAtMs: result.createdAtMs || Date.now() }])
      this._pendingMessages = []
      this._retryRequest = null
      this.renderMessages()
      wx.pageScrollTo({ scrollTop: 99999, duration: 80 })
    } catch (error) {
      if (!active() || error && error.code === 'LOGIN_CANCELLED') return
      const errorText = failureText(error, 'AI 服务暂不可用，请稍后重试')
      this._pendingMessages = []
      this.renderMessages()
      this.setData({ inputText: q, errorText, retryText: q })
    } finally {
      clearTimeout(timer)
      if (active()) {
        this._request += 1
        this.setData({ loading: false })
      }
    }
  }
})
