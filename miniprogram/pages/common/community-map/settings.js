const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { profile: null, keyword: '', communities: [], selected: null, confirmed: false, busy: false,
    loading: false, loadingProfile: false, hasMore: false, error: '' },
  onShow() { if (!this.data.busy) return this.load() },
  onUnload() { this._closed = true; this._seq = (this._seq || 0) + 1; this._profileSeq = (this._profileSeq || 0) + 1 },
  async load() {
    if (this._closed || this.data.busy) return
    return this.loadProfile()
  },
  async loadProfile() {
    if (this._closed) return
    const seq = this._profileSeq = (this._profileSeq || 0) + 1
    this._seq = (this._seq || 0) + 1
    this._failedSearch = null
    this.setData({ loadingProfile: true, loading: false, selected: null, confirmed: false, error: '' })
    try {
      const profile = await callFunction('staff', 'getStaffProfile')
      if (this._closed || seq !== this._profileSeq) return
      this.setData({ profile, loadingProfile: false }); await this.search(false, true)
    } catch (error) { if (!this._closed && seq === this._profileSeq) this.setData({ loadingProfile: false, error: error.message || '资料加载失败，请重试' }) }
  },
  input(e) { if (!this.data.busy) this.setData({ keyword: e.detail.value }) },
  async search(append = false, afterSave = false, retryKeyword) {
    append = append === true
    if (this._closed || (this.data.busy && afterSave !== true) || this.data.loadingProfile || (append && (this.data.loading || !this.data.hasMore))) return
    if (!this.data.profile) return
    if (!append) this._catalogKeyword = String(retryKeyword ?? this.data.keyword ?? '').trim()
    const seq = this._seq = (this._seq || 0) + 1
    const offset = append ? this._nextOffset || this.data.communities.length : 0
    this._failedSearch = null
    this.setData({ loading: true, error: '', ...(!append ? { communities: [], selected: null, confirmed: false, hasMore: false } : {}) })
    try {
      const result = await callFunction('communityMap', 'catalog', { recommended: true, keyword: this._catalogKeyword || '', offset })
      if (this._closed || seq !== this._seq) return
      this._nextOffset = offset + result.list.length
      const rows = append ? [...this.data.communities, ...result.list] : result.list
      this.setData({ communities: [...new Map(rows.map(row => [row._id, row])).values()], hasMore: result.hasMore })
    } catch (error) {
      if (!this._closed && seq === this._seq) { this._failedSearch = { append, keyword: this._catalogKeyword }; this.setData({ error: error.message || '小区加载失败，请重试' }) }
    }
    finally { if (!this._closed && seq === this._seq) this.setData({ loading: false }) }
  },
  more() { if (!this.data.busy) return this.search(true) },
  retry() {
    if (this._failedSearch) return this.search(this._failedSearch.append, false, this._failedSearch.keyword)
    return this.load()
  },
  select(e) {
    if (this.data.busy || this.data.loading || this.data.loadingProfile) return
    const selected = this.data.communities.find(row => row._id === e.currentTarget.dataset.id)
    if (selected) this.setData({ selected, confirmed: false })
  },
  confirm() { if (this.data.selected && !this.data.busy) this.setData({ confirmed: !this.data.confirmed }) },
  async save() {
    if (!this.data.profile || !this.data.selected || !this.data.confirmed || this.data.busy || this.data.loadingProfile || this.data.loading) return
    const selected = this.data.selected
    this.setData({ busy: true })
    try {
      await callFunction('communityMap', 'setVisibility', { enabled: true, communityId: selected._id, confirmPublic: true,
        radiusKm: Number(this.data.profile.serviceRadiusKm || 5), communityRevision: selected.revision })
      if (!this._closed) {
        wx.showToast({ title: '公开小区已更新' })
        this.setData({ 'profile.publicMapEnabled': true, 'profile.publicServiceCommunityName': selected.name, confirmed: false })
        await this.loadProfile()
      }
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  async disable() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await callFunction('communityMap', 'setVisibility', { enabled: false })
      if (!this._closed) {
        wx.showToast({ title: '已停止地图展示' }); this.setData({ 'profile.publicMapEnabled': false }); await this.loadProfile()
      }
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  }
})
