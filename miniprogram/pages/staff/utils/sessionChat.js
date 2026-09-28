// 分包内使用；与 pages/client/orders/utils/sessionChat.js 保持一致。
function sessionChatMethods(callFunction) {
  return {
    openSessionChat() {
      this._chatAtBottom = true
      this._chatScrollTop = 0
      this._chatForceScroll = true
      this.setData({ showChatModal: true, sessionUnreadCount: 0 })
      this.startSessionChatRefresh()
    },
    closeSessionChat() {
      this.stopSessionChatRefresh()
      this.setData({ showChatModal: false })
    },
    startSessionChatRefresh() {
      this.stopSessionChatRefresh()
      if (!this.data.showChatModal || !this.data.id) return
      this._sessionChatActive = true
      this.loadSessionMessages()
    },
    stopSessionChatRefresh() {
      this._sessionChatActive = false
      this._sessionChatEpoch = (this._sessionChatEpoch || 0) + 1
      clearTimeout(this._sessionChatTimer)
      if (this._sessionChatRequest) this._sessionChatRequest.cancel()
      this._sessionChatRequest = null
      this._sessionChatRefreshQueued = false
    },
    loadSessionMessages() {
      if (!this._sessionChatActive || !this.data.showChatModal || !this.data.id) return Promise.resolve()
      if (this._sessionChatRequest) {
        // 发送完成时如有旧查询在途，结束后立即再查一次，避免漏掉刚发出的消息。
        this._sessionChatRefreshQueued = true
        return this._sessionChatRequest.promise
      }
      clearTimeout(this._sessionChatTimer)
      const epoch = this._sessionChatEpoch
      const orderId = this.data.id
      const isCurrent = () => this._sessionChatActive && epoch === this._sessionChatEpoch && orderId === this.data.id
      let timeout
      let cancel
      const bounded = new Promise((resolve, reject) => {
        cancel = () => { clearTimeout(timeout); resolve(null) }
        timeout = setTimeout(() => reject(new Error('消息刷新超时')), 12000)
        Promise.resolve().then(() => callFunction('order', 'listOrderSessionMessages', { orderId }))
          .then(resolve, reject)
      })
      const request = { cancel }
      this._sessionChatRequest = request
      request.promise = bounded.then((list) => {
        if (!isCurrent()) return
        const previous = this.data.sessionMessages || []
        const merged = new Map(previous.map((message) => [message._id, message]))
        let added = 0
        ;(list || []).forEach((message) => {
          if (!merged.has(message._id)) added += 1
          merged.set(message._id, message)
        })
        const messages = Array.from(merged.values())
        const changed = JSON.stringify(messages) !== JSON.stringify(previous)
        const updates = { sessionChatError: '' }
        if (changed) updates.sessionMessages = messages
        if (added && this._chatAtBottom === false) updates.sessionUnreadCount = (this.data.sessionUnreadCount || 0) + added
        this.setData(updates, () => {
          if ((changed && this._chatAtBottom !== false) || this._chatForceScroll) {
            this._chatForceScroll = false
            this.scrollSessionChatToBottom()
          }
        })
      }).catch(() => {
        if (isCurrent()) this.setData({ sessionChatError: '连接暂时中断，正在自动重试…' })
      }).finally(() => {
        clearTimeout(timeout)
        if (!isCurrent()) return
        this._sessionChatRequest = null
        const delay = this._sessionChatRefreshQueued ? 0 : 2000
        this._sessionChatRefreshQueued = false
        this._sessionChatTimer = setTimeout(() => this.loadSessionMessages(), delay)
      })
      return request.promise
    },
    onSessionChatScroll(e) {
      const top = Number(e.detail.scrollTop || 0)
      if (top < (this._chatScrollTop || 0) - 5) this._chatAtBottom = false
      this._chatScrollTop = top
    },
    onSessionChatBottom() {
      this._chatAtBottom = true
      this.setData({ sessionUnreadCount: 0 })
    },
    scrollSessionChatToBottom() {
      this._chatAtBottom = true
      const last = (this.data.sessionMessages || []).length - 1
      if (last < 0) return
      this.setData({ sessionScrollTarget: '', sessionUnreadCount: 0 }, () => {
        this.setData({ sessionScrollTarget: `session-message-${last}` })
      })
    }
  }
}

module.exports = { sessionChatMethods }
