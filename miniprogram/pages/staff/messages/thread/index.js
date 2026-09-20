const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { refreshUnread } = require('../../../../utils/client-nav')

function withMessageText(message) {
  if (!message) return message
  return { ...message, createdAtText: formatDateTime(message.createdAt) }
}

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    orderId: '',
    thread: null,
    messages: [],
    loading: false
  },
  onLoad(q) {
    this.setData({ id: q.id || '', orderId: q.orderId || '' })
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
    if ((!this.data.id && !this.data.orderId) || this.data.loading) return
    this.setData({ loading: true })
    callFunction('staffMessage', 'getThreadMessages', { threadId: this.data.id, orderId: this.data.orderId })
      .then((result) => {
        const thread = result.thread || null
        const messages = (result.messages || []).map(withMessageText)
        this.setData({ thread, messages, loading: false, id: thread ? thread._id : this.data.id })
        const targetThreadId = thread ? thread._id : this.data.id
        if (targetThreadId) {
          return callFunction('staffMessage', 'markThreadRead', { threadId: targetThreadId })
            .then(() => refreshUnread('staff'))
            .catch(() => {})
        }
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
