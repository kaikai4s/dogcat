const { callFunction } = require('../../utils/cloud')
const { deadline } = require('../scene/recovery-time')
const { plotNumber } = require('../scene/plot-number')
Page({
  data: { rows: [], loading: false, error: '', more: false, busy: '', restored: null, loaded: false, errorId: '' },
  onLoad() { this._alive = true; this._requests = {} },
  onShow() { this.load() },
  onHide() { this._confirmVersion = (this._confirmVersion || 0) + 1; this._loadVersion = (this._loadVersion || 0) + 1; this.setData({ loading: false }) },
  onUnload() { this._alive = false; this._loadVersion = (this._loadVersion || 0) + 1 },
  async load(e) {
    if (this.data.loading || this.data.busy) return
    const more = !!(e && e.currentTarget && e.currentTarget.dataset.more)
    const version = this._loadVersion = (this._loadVersion || 0) + 1
    const current = () => this._alive && version === this._loadVersion
    this.setData({ loading: true, error: '', errorId: '' })
    try {
      const result = await callFunction('memorial', 'listRecycle', { cursor: more ? this.cursor : '' })
      if (!current()) return
      this.cursor = result.cursor
      this.setData({ rows: (more ? this.data.rows : []).concat(result.list.map(row => ({ ...row, deadline: deadline(row.recoverUntil), plotNumber: plotNumber(row.plotId) }))), more: result.hasMore })
    } catch (error) { if (current()) this.setData({ error: error.message || '回收站读取失败，请重试' }) }
    finally { if (current()) this.setData({ loading: false, loaded: true }) }
  },
  chooseLocation(e) {
    if (this.data.busy || this.data.loading) return
    const row = this.data.rows.find(r => r.id === e.currentTarget.dataset.id)
    if (row) this.navigate('/packageMemorial/pages/entrance?moveId=' + encodeURIComponent(row.id) + '&restore=1')
  },
  async restoreOriginal(e) {
    if (this.data.busy || this.data.loading) return
    const row = this.data.rows.find(r => r.id === e.currentTarget.dataset.id)
    if (!row) return
    const version = this._confirmVersion || 0
    this.setData({ busy: row.id, error: '', errorId: '' })
    try {
      const answer = await new Promise((resolve, reject) => wx.showModal({ title: '恢复时光小筑？', content: '将“' + row.petName + '”恢复至' + row.gardenName + '的原位置，并保留全部内容。', confirmText: '确认恢复', success: resolve, fail: reject }))
      if (!answer.confirm || !this._alive || version !== (this._confirmVersion || 0)) return
      const key = row.id + ':' + row.locationRevision
      const requestId = this._requests[key] || (this._requests[key] = 'restore_' + Date.now() + '_' + Math.random().toString(36).slice(2))
      const result = await callFunction('memorial', 'restore', { id: row.id, locationRevision: row.locationRevision, requestId, original: true })
      if (!this._alive) return
      this.setData({ rows: this.data.rows.filter(r => r.id !== row.id), restored: result })
      wx.showToast({ title: '小筑已恢复', icon: 'none' })
    } catch (error) { if (this._alive) this.setData({ error: error.message || '恢复失败，请重试', errorId: row.id }) }
    finally { if (this._alive) this.setData({ busy: '' }) }
  },
  navigate(url) {
    if (this._navigating) return
    this._navigating = true
    wx.navigateTo({ url, complete: () => { this._navigating = false }, fail: () => { if (this._alive) this.setData({ error: '页面未能打开，请重试', errorId: '' }) } })
  },
  visitRestored() {
    const row = this.data.restored
    if (row) this.navigate('/packageMemorial/pages/garden?gardenId=' + encodeURIComponent(row.gardenId) + '&plotId=' + encodeURIComponent(row.plotId))
  }
})
