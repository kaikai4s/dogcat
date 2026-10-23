const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { profile: null, keyword: '', communities: [], selected: null, confirmed: false, busy: false, loading: false, error: '' },
  onShow() { this.load() },
  onUnload() { this._closed = true },
  async load() {
    try {
      const profile = await callFunction('staff', 'getStaffProfile')
      if (this._closed) return
      this.setData({ profile }); this.search()
    } catch (error) { showError(error) }
  },
  input(e) { this.setData({ keyword: e.detail.value }) },
  async search() {
    const seq = this._seq = (this._seq || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('communityMap', 'catalog', { city: this.data.profile?.serviceCity || '', keyword: this.data.keyword })
      if (this._closed || seq !== this._seq) return
      this.setData({ communities: result.list, hasMore: result.hasMore, loading: false })
    } catch (error) { if (!this._closed && seq === this._seq) this.setData({ loading: false, error: error.message }) }
  },
  select(e) { const selected = this.data.communities.find(row => row._id === e.currentTarget.dataset.id); this.setData({ selected, confirmed: false }) },
  confirm() { this.setData({ confirmed: !this.data.confirmed }) },
  async save() {
    if (!this.data.selected || !this.data.confirmed || this.data.busy) return
    this.setData({ busy: true })
    try {
      await callFunction('communityMap', 'setVisibility', { enabled: true, communityId: this.data.selected._id, confirmPublic: true,
        radiusKm: Number(this.data.profile.serviceRadiusKm || 5), communityRevision: this.data.selected.revision })
      if (!this._closed) { wx.showToast({ title: '公开小区已更新' }); this.setData({ confirmed: false }); await this.load() }
    } catch (error) { showError(error) } finally { if (!this._closed) this.setData({ busy: false }) }
  },
  async disable() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try { await callFunction('communityMap', 'setVisibility', { enabled: false }); if (!this._closed) { wx.showToast({ title: '已停止地图展示' }); await this.load() } }
    catch (error) { showError(error) } finally { if (!this._closed) this.setData({ busy: false }) }
  }
})
