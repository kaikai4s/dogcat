const { callFunction } = require('../../utils/cloud')
Page({
  data: { gardens: [], loading: false, error: '', more: false, moving: false, restoring: false },
  onLoad(options = {}) { this._alive = true; this.moveId = options.moveId || ''; this.restoring = options.restore === '1'; this.setData({ moving: !!this.moveId, restoring: this.restoring }); this.load() },
  onUnload() { this._alive = false },
  async load(e) {
    if (this.data.loading) return
    const more = !!(e && e.currentTarget && e.currentTarget.dataset.more)
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('memorial', 'listGardens', { cursor: more ? this.cursor : '' })
      if (!this._alive) return
      this.cursor = result.cursor
      this.setData({ gardens: (more ? this.data.gardens : []).concat(result.list), more: result.hasMore })
    } catch (error) { if (this._alive) this.setData({ error: error.message || '园区加载失败，请重试' }) }
    finally { if (this._alive) this.setData({ loading: false }) }
  },
  openRecycle() { wx.navigateTo({ url: '/packageMemorial/pages/recycle' }) },
  enter(e) {
    if (this._entering) return
    const garden = this.data.gardens.find(g => g.id === e.currentTarget.dataset.id)
    if (!garden || this.moveId && !garden.accepting) return
    this._entering = true
    wx.redirectTo({ url: '/packageMemorial/pages/garden?gardenId=' + encodeURIComponent(garden.id) + (this.moveId ? '&moveId=' + encodeURIComponent(this.moveId) + (this.restoring ? '&restore=1' : '') : ''),
      complete: () => { this._entering = false }, fail: () => wx.showToast({ title: '未能进入园区，请重试', icon: 'none' }) })
  }
})
