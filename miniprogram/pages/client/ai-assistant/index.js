const { callFunction, ensureLogin } = require('../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { applyFont, getFontState } = require('../../../utils/font')


Page({
  data: {
    themeClass: 'theme-day',
    fontClass: 'font-system',
    inputText: '',
    messages: [
      {
        role: 'ai',
        content: '您好！我是您的 AI 宠护小助手 🐾\n无论关于宠物饮食健康、出行习惯还是上门服务的准备事宜，我都能为您解答～\n\n📌 温馨提示：AI 回答仅供日常养宠参考，不能替代专业兽医诊断。若爱宠出现紧急症状或严重不适，请务必及时送医就诊。'
      }
    ],
    errorText: '',
    retryText: '',
    loading: false
  },

  onLoad() {
    ensureLogin({ content: '登录后可体验 AI 智能问答助手。' }).catch(() => {})
  },

  onShow() {
    const theme = applyTheme()
    const font = applyFont()
    this.setData({
      ...getThemeState(theme.value),
      ...getFontState(font.value)
    })
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
    clearTimeout(this._requestTimer)
  },

  retry() {
    if (!this.data.retryText || this.data.loading) return
    this.setData({ inputText: this.data.retryText })
    return this.send()
  },

  async send() {
    const q = this.data.inputText.trim()
    if (!q || this.data.loading || this._closed) return
    if (q.length > 300) {
      this.setData({ errorText: '咨询问题不能超过 300 字' })
      return
    }
    const request = this._request = (this._request || 0) + 1
    const active = () => !this._closed && this._request === request
    let aiIndex = -1
    this.setData({ loading: true, errorText: '', retryText: '' })
    try {
      const user = await ensureLogin({ content: '登录后可体验 AI 智能问答助手。', isActive: active })
      if (!active() || !user) return
      aiIndex = this.data.messages.length + 1
      this.setData({ messages: [...this.data.messages, { role: 'user', content: q }, { role: 'ai', content: '' }], inputText: '' })
      // Bound both model startup and a stalled stream; late output cannot mutate this request.
      const timeout = new Promise((_, reject) => {
        this._requestTimer = setTimeout(() => reject(new Error('AI 回复超时，请稍后重试')), 45000)
      })
      const result = await Promise.race([callFunction('ai', 'aiPetAssistant', { question: q }), timeout])
      if (!active()) return
      if (!result || typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('AI 暂未返回内容，请重试')
      const messages = [...this.data.messages]
      messages[aiIndex] = { role: 'ai', content: result.answer }
      this.setData({ messages })
      wx.pageScrollTo({ scrollTop: 99999, duration: 80 })
    } catch (error) {
      if (!active() || error && error.code === 'LOGIN_CANCELLED') return
      const errorText = error && error.message || 'AI 服务暂不可用，请稍后重试'
      const messages = [...this.data.messages]
      if (aiIndex >= 0 && messages[aiIndex] && !messages[aiIndex].content) messages.splice(aiIndex, 1)
      this.setData({ messages, inputText: q, errorText, retryText: q })
    } finally {
      clearTimeout(this._requestTimer)
      if (active()) {
        this._request += 1
        this.setData({ loading: false })
      }
    }
  }
})
