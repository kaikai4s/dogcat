const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function withMessageText(message) {
  if (!message) return message
  return { ...message, createdAtText: formatDateTime(message.createdAt) }
}

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    thread: null,
    messages: [],
    loading: false
  },
  onLoad(q) {
    this.setData({ id: q.id || '' })
  },
  onShow() {
    this.applyCurrentTheme()
    this.load()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    if (!this.data.id || this.data.loading) return
    this.setData({ loading: true })
    callFunction('staffMessage', 'getThreadMessages', { threadId: this.data.id })
      .then((result) => {
        const thread = result.thread || null
        const messages = (result.messages || []).map(withMessageText)
        this.setData({ thread, messages, loading: false })
        return callFunction('staffMessage', 'markThreadRead', { threadId: this.data.id }).catch(() => {})
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },
  viewOrder() {
    const orderId = this.data.thread && this.data.thread.orderId
    if (!orderId) return
    wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + orderId })
  }
})
