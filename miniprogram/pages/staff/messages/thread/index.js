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
    loading: false,
    hasOlder: false,
    before: null,
    after: null
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
  load(older = false) {
    if ((!this.data.id && !this.data.orderId) || this.data.loading) return
    this.setData({ loading: true })
    const after = !older && this.data.after
    return callFunction('staffMessage', 'getThreadMessages', { threadId: this.data.id, orderId: this.data.orderId,
      pageSize: 30, ...(older ? { before: this.data.before } : after ? { after } : {}) })
      .then((result) => {
        const thread = result.thread || null
        const incoming = (result.messages || []).map(withMessageText)
        const messages = Array.from(new Map((older ? [...incoming, ...this.data.messages] : [...this.data.messages, ...incoming]).map(item => [item._id, item])).values())
        this.setData({ thread, messages, loading: false, id: thread ? thread._id : this.data.id,
          before: older || !after ? result.before || this.data.before : this.data.before,
          after: older ? this.data.after : result.after || this.data.after,
          hasOlder: older || !after ? result.hasMore === true : this.data.hasOlder })
        if (after && result.hasMore) return this.load()
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
  loadOlder() { if (this.data.hasOlder) return this.load(true) },
  viewOrder() {
    const orderId = this.data.thread && this.data.thread.orderId
    if (!orderId) return
    wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + orderId })
  }
})
