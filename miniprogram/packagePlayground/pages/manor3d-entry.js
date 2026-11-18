const STORAGE_PREFIX = 'manor3d:entry:'
const TARGET_URL = '/packageManor3d/pages/index?entryKey='

function createEntryKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function copyCommunity(community) {
  if (!community || typeof community !== 'object' || !String(community.name || '').trim()) {
    throw new Error('请选择有效的小区')
  }
  return { ...community, name: String(community.name).trim() }
}

Page({
  data: { opening: false, error: '' },

  onLoad() { this._alive = true },

  onHide() {
    if (this._navigating) return
    this._openingGeneration = (this._openingGeneration || 0) + 1
    this.selectComponent('#communityChooser')?.close()
    if (this._alive && this.data.opening) this.setData({ opening: false })
  },

  onUnload() {
    this._alive = false
    this._openingGeneration = (this._openingGeneration || 0) + 1
  },

  async chooseCommunity() {
    if (!this._alive || this.data.opening) return
    const generation = this._openingGeneration = (this._openingGeneration || 0) + 1
    this.setData({ opening: true, error: '' })
    try {
      const community = await this.selectComponent('#communityChooser').open()
      if (!this._alive || generation !== this._openingGeneration) return
      this.openManor(copyCommunity(community))
    } catch (error) {
      if (!this._alive || generation !== this._openingGeneration) return
      if (!String(error?.errMsg || '').includes('cancel')) {
        this.setData({ error: error?.message || '小区选择失败，请重试' })
      }
    } finally {
      if (this._alive && generation === this._openingGeneration && !this._navigating) {
        this.setData({ opening: false })
      }
    }
  },

  enterSolo() {
    if (!this._alive || this.data.opening) return
    this.setData({ opening: true, error: '' })
    this.openManor(null)
  },

  openManor(community) {
    const entryKey = createEntryKey()
    const storageKey = STORAGE_PREFIX + entryKey
    try {
      wx.setStorageSync(storageKey, { community, createdAt: Date.now() })
    } catch (error) {
      if (this._alive) this.setData({ opening: false, error: '暂时无法准备庄园入口，请重试' })
      return
    }
    this._navigating = true
    try {
      wx.navigateTo({
        url: TARGET_URL + encodeURIComponent(entryKey),
        fail: () => {
          try { wx.removeStorageSync(storageKey) } catch (_) {}
          this._navigating = false
          if (this._alive) this.setData({ opening: false, error: '暂时无法打开3D庄园，请重试' })
        }
      })
    } catch (error) {
      try { wx.removeStorageSync(storageKey) } catch (_) {}
      this._navigating = false
      if (this._alive) this.setData({ opening: false, error: '暂时无法打开3D庄园，请重试' })
    }
  },

  goBack() { wx.navigateBack() }
})
