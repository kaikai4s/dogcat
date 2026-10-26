const { callFunction } = require('../../../utils/cloud')
Component({
  data: { visible: false, loading: false, busy: false, busyId: '', list: [], equippedTitle: null, error: '', updateError: '' },
  lifetimes: { detached() { this._version = (this._version || 0) + 1 } },
  methods: {
    async open() {
      if (this.data.busy) return
      const version = this._version = (this._version || 0) + 1
      this.setData({ visible: true, loading: true, error: '', updateError: '', list: [], equippedTitle: null })
      try {
        const result = await callFunction('playground', 'listUserTitles')
        if (version === this._version) { this.setData({ list: result.list || [], equippedTitle: result.equippedTitle || null, loading: false }); this.emitDisplay(result) }
      } catch (error) { if (version === this._version) this.setData({ loading: false, error: error.message || '头衔加载失败' }) }
    },
    close() { if (!this.data.busy) { this._version = (this._version || 0) + 1; this.setData({ visible: false }) } },
    noop() {},
    emitDisplay(result) { this.triggerEvent('change', { publicTitle: result.publicTitle || null, sceneId: result.sceneId || '', session: result.session || '', version: result.version || null }) },
    async equip(e) {
      if (this.data.busy || this.data.loading || !this.data.visible) return
      const titleId = e.currentTarget.dataset.id || ''
      if (titleId && !this.data.list.some(item => item.id === titleId)) return
      if ((this.data.equippedTitle?.id || '') === titleId) return
      const version = this._version
      this.setData({ busy: true, busyId: titleId || '_none', updateError: '' })
      try {
        const result = await callFunction('playground', 'equipUserTitle', { titleId })
        if (version !== this._version) return
        this.setData({ list: result.list, equippedTitle: result.equippedTitle })
        this.emitDisplay(result)
        wx.showToast({ title: titleId ? '已佩戴头衔' : '已摘下头衔', icon: 'success' })
      } catch (error) {
        // The write may have succeeded before the connection failed; re-read confirmed state.
        try {
          const result = await callFunction('playground', 'listUserTitles')
          if (version !== this._version) return
          this.setData({ list: result.list || [], equippedTitle: result.equippedTitle || null })
          this.emitDisplay(result)
          if ((result.equippedTitle?.id || '') === titleId) wx.showToast({ title: '佩戴状态已同步', icon: 'success' })
          else this.setData({ updateError: error.message || '头衔更新失败，请重试' })
        } catch (_) { if (version === this._version) this.setData({ updateError: '暂时无法确认佩戴状态，请重新打开面板后重试' }) }
      } finally { if (version === this._version) this.setData({ busy: false, busyId: '' }) }
    }
  }
})
