const { callFunction, showError, setCachedSystemSettings } = require('../../../utils/cloud')

Page({
  data: {
    settings: {
      enableTestAddressMode: false
    },
    saving: false
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'getSystemSettings')
      .then((settings) => {
        const normalized = {
          enableTestAddressMode: settings.enableTestAddressMode === true
        }
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized })
      })
      .catch(showError)
  },

  toggleTestAddressMode(e) {
    this.setData({ ['settings.enableTestAddressMode']: e.detail.value })
  },

  save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    callFunction('admin', 'saveSystemSettings', this.data.settings)
      .then((settings) => {
        const normalized = {
          enableTestAddressMode: settings.enableTestAddressMode === true
        }
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized, saving: false })
        wx.showToast({ title: '已保存' })
      })
      .catch((err) => {
        this.setData({ saving: false })
        showError(err)
      })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  }
})
