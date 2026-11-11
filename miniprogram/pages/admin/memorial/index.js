const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { status: 'pending', rows: [], loading: false, busy: false, hasMore: false, error: '', reviewForm: null },
  onShow() { this._closed = false; this.setData({ busy: false, reviewForm: null }); return this.load() },
  onHide() { this._closed = true; this._reviewRequest = (this._reviewRequest || 0) + 1; this._request = (this._request || 0) + 1 },
  onUnload() { this.onHide() },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()) },
  async load(e) {
    const more = e && e.currentTarget && e.currentTarget.dataset.more
    const request = this._request = (this._request || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('memorial', 'listAdmin', { status: this.data.status, cursor: more ? this._cursor : '' })
      if (this._closed || request !== this._request) return
      this._cursor = result.cursor
      this.setData({ rows: (more ? this.data.rows : []).concat(result.list), hasMore: result.hasMore })
    } catch (error) { if (!this._closed && request === this._request) this.setData({ error: error.message || '加载失败，请重试' }) }
    finally { if (!this._closed && request === this._request) this.setData({ loading: false }) }
  },
  changeStatus(e) { if (!this.data.busy) { this.setData({ status: e.currentTarget.dataset.status, rows: [], hasMore: false }); this.load() } },
  review(e) {
    if (this.data.busy || !(this.data.adminSuper || (this.data.adminPermissions || {}).memorial_review)) return
    const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    if (row && row.status === 'pending') this.setData({ reviewForm: { id: row._id, petName: row.petName, status: e.currentTarget.dataset.status, reason: '' } })
  },
  reason(e) { if (!this.data.busy) this.setData({ 'reviewForm.reason': e.detail.value }) },
  close() { if (!this.data.busy) this.setData({ reviewForm: null }) },
  async confirm() {
    if (this.data.busy || !this.data.reviewForm) return
    const form = this.data.reviewForm
    if (form.status === 'rejected' && !form.reason.trim()) { showError(new Error('请填写驳回原因')); return }
    const version = this._reviewRequest = (this._reviewRequest || 0) + 1
    this.setData({ busy: true })
    try {
      await callFunction('memorial', 'review', form)
      if (this._closed || version !== this._reviewRequest) return
      this.setData({ reviewForm: null })
      wx.showToast({ title: form.status === 'approved' ? '已通过并建立纪念碑' : '已驳回并通知申请人', icon: 'none' })
      await this.load()
    } catch (error) { if (!this._closed && version === this._reviewRequest) showError(error) }
    finally { if (!this._closed && version === this._reviewRequest) this.setData({ busy: false }) }
  }
})
