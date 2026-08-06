const { callFunction, showError, setCachedSystemSettings } = require('../../../utils/cloud')

function createEmptyItem() {
  return {
    id: `hero_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'image',
    fileId: '',
    posterFileId: '',
    title: '',
    subtitle: '',
    enabled: true,
    sort: 10,
    tempUrl: '',
    posterTempUrl: ''
  }
}

function normalizeCarouselConfig(carousel = {}) {
  const source = carousel || {}
  const rotateIntervalMs = Number(source.rotateIntervalMs || 5000)
  const rotateIntervalSec = Math.max(Math.round(rotateIntervalMs / 1000), 1)
  const items = Array.isArray(source.items) ? source.items : []
  const normalizedItems = items.map((item, index) => ({
    id: item.id || `hero_${Date.now()}_${index}`,
    type: item.type === 'video' ? 'video' : 'image',
    fileId: item.fileId || '',
    posterFileId: item.posterFileId || '',
    title: item.title || '',
    subtitle: item.subtitle || '',
    enabled: item.enabled !== false,
    sort: Number(item.sort) || (index + 1) * 10,
    tempUrl: '',
    posterTempUrl: ''
  })).sort((a, b) => a.sort - b.sort)

  return {
    enabled: source.enabled === true,
    autoRotate: source.autoRotate !== false,
    rotateIntervalMs: rotateIntervalSec * 1000,
    rotateIntervalSec,
    items: normalizedItems
  }
}

Page({
  data: {
    settings: {
      enableTestAddressMode: false,
      homeHeroCarousel: normalizeCarouselConfig()
    },
    editingIndex: -1,
    editingItem: createEmptyItem(),
    uploadingMedia: false,
    uploadingPoster: false,
    saving: false
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'getSystemSettings')
      .then((settings) => {
        const normalized = {
          enableTestAddressMode: settings.enableTestAddressMode === true,
          homeHeroCarousel: normalizeCarouselConfig(settings.homeHeroCarousel)
        }
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized }, () => {
          this.resolveMediaUrls(normalized.homeHeroCarousel.items)
        })
      })
      .catch(showError)
  },

  resolveMediaUrls(items = []) {
    const fileIds = []
    items.forEach((item) => {
      if (item.fileId) fileIds.push(item.fileId)
      if (item.posterFileId) fileIds.push(item.posterFileId)
    })
    const uniqueIds = Array.from(new Set(fileIds))
    if (!uniqueIds.length) return

    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        const urlMap = {}
        ;(res.fileList || []).forEach((f) => {
          if (f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        })
        const updatedItems = items.map((item) => ({
          ...item,
          tempUrl: urlMap[item.fileId] || item.tempUrl || '',
          posterTempUrl: urlMap[item.posterFileId] || item.posterTempUrl || ''
        }))
        this.setData({ ['settings.homeHeroCarousel.items']: updatedItems })
      }
    })
  },

  toggleTestAddressMode(e) {
    this.setData({ ['settings.enableTestAddressMode']: e.detail.value })
  },

  toggleCarouselEnabled(e) {
    this.setData({ ['settings.homeHeroCarousel.enabled']: e.detail.value })
  },

  toggleCarouselAutoRotate(e) {
    this.setData({ ['settings.homeHeroCarousel.autoRotate']: e.detail.value })
  },

  inputIntervalSec(e) {
    const sec = Math.max(Number(e.detail.value || 5), 1)
    this.setData({
      ['settings.homeHeroCarousel.rotateIntervalSec']: sec,
      ['settings.homeHeroCarousel.rotateIntervalMs']: sec * 1000
    })
  },

  startAddItem() {
    const items = this.data.settings.homeHeroCarousel.items || []
    if (items.length >= 5) {
      wx.showToast({ title: '最多支持添加 5 个轮播素材', icon: 'none' })
      return
    }
    const nextSort = (items.length + 1) * 10
    const newItem = createEmptyItem()
    newItem.sort = nextSort
    this.setData({
      editingIndex: -1,
      editingItem: newItem
    })
  },

  startEditItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = this.data.settings.homeHeroCarousel.items || []
    if (items[index]) {
      this.setData({
        editingIndex: index,
        editingItem: { ...items[index] }
      })
    }
  },

  cancelEditItem() {
    this.setData({
      editingIndex: -1,
      editingItem: createEmptyItem()
    })
  },

  typeChange(e) {
    const type = e.detail.value === 'video' ? 'video' : 'image'
    this.setData({
      ['editingItem.type']: type,
      ['editingItem.fileId']: '',
      ['editingItem.tempUrl']: ''
    })
  },

  editingInput(e) {
    const field = e.currentTarget.dataset.field
    let value = e.detail.value
    if (field === 'sort') value = Number(value) || 0
    this.setData({ [`editingItem.${field}`]: value })
  },

  toggleEditingEnabled(e) {
    this.setData({ ['editingItem.enabled']: e.detail.value })
  },

  chooseMediaFile() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image', 'video'],
      maxDuration: 60,
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return

        // 自动识别文件类型
        const isVideo = file.fileType === 'video' || file.tempFilePath.endsWith('.mp4') || file.tempFilePath.endsWith('.mov')
        const detectedType = isVideo ? 'video' : 'image'

        // 50MB 大小检查
        if (file.size && file.size > 50 * 1024 * 1024) {
          wx.showToast({ title: '文件大小不能超过 50MB', icon: 'none' })
          return
        }

        const filePath = file.tempFilePath
        const ext = isVideo ? '.mp4' : (filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg')
        const cloudPath = `hero_banners/${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`

        this.setData({
          uploadingMedia: true,
          ['editingItem.type']: detectedType
        })
        wx.showLoading({ title: '上传中...' })

        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              success: (tempRes) => {
                wx.hideLoading()
                const url = tempRes.fileList && tempRes.fileList[0] ? tempRes.fileList[0].tempFileURL : file.tempFilePath
                this.setData({
                  ['editingItem.fileId']: fileId,
                  ['editingItem.tempUrl']: url,
                  uploadingMedia: false
                })
                wx.showToast({ title: '素材上传成功' })
              },
              fail: () => {
                wx.hideLoading()
                this.setData({
                  ['editingItem.fileId']: fileId,
                  ['editingItem.tempUrl']: file.tempFilePath,
                  uploadingMedia: false
                })
                wx.showToast({ title: '素材上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingMedia: false })
            showError(err)
          }
        })
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        showError(err)
      }
    })
  },

  choosePosterFile() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        const filePath = file.tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
        const cloudPath = `hero_banners/poster_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`

        this.setData({ uploadingPoster: true })
        wx.showLoading({ title: '上传封面...' })
        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              success: (tempRes) => {
                wx.hideLoading()
                const url = tempRes.fileList && tempRes.fileList[0] ? tempRes.fileList[0].tempFileURL : ''
                this.setData({
                  ['editingItem.posterFileId']: fileId,
                  ['editingItem.posterTempUrl']: url,
                  uploadingPoster: false
                })
                wx.showToast({ title: '封面上传成功' })
              },
              fail: () => {
                wx.hideLoading()
                this.setData({ ['editingItem.posterFileId']: fileId, uploadingPoster: false })
                wx.showToast({ title: '封面上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingPoster: false })
            showError(err)
          }
        })
      }
    })
  },

  saveEditingItem() {
    const item = this.data.editingItem
    if (!item.fileId) {
      wx.showToast({ title: '请先上传图片或视频', icon: 'none' })
      return
    }
    if (item.type === 'video' && !item.posterFileId) {
      wx.showToast({ title: '视频素材请传一张封面图', icon: 'none' })
      return
    }

    const items = [...(this.data.settings.homeHeroCarousel.items || [])]
    if (this.data.editingIndex >= 0) {
      items[this.data.editingIndex] = item
    } else {
      items.push(item)
    }
    items.sort((a, b) => a.sort - b.sort)

    this.setData({
      ['settings.homeHeroCarousel.items']: items,
      editingIndex: -1,
      editingItem: createEmptyItem()
    })
    wx.showToast({ title: '素材已提交到当前列表，请点击底部“保存设置”' })
  },

  deleteItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = [...(this.data.settings.homeHeroCarousel.items || [])]
    items.splice(index, 1)
    this.setData({
      ['settings.homeHeroCarousel.items']: items,
      editingIndex: -1,
      editingItem: createEmptyItem()
    })
  },

  toggleItemEnabled(e) {
    const index = Number(e.currentTarget.dataset.index)
    const key = `settings.homeHeroCarousel.items[${index}].enabled`
    this.setData({ [key]: e.detail.value })
  },

  save() {
    if (this.data.saving) return
    this.setData({ saving: true })

    const carousel = this.data.settings.homeHeroCarousel || {}
    const itemsToSave = (carousel.items || []).map((item) => ({
      id: item.id,
      type: item.type,
      fileId: item.fileId,
      posterFileId: item.posterFileId || '',
      title: item.title || '',
      subtitle: item.subtitle || '',
      enabled: item.enabled !== false,
      sort: Number(item.sort) || 10
    }))

    const payload = {
      enableTestAddressMode: this.data.settings.enableTestAddressMode === true,
      homeHeroCarousel: {
        enabled: carousel.enabled === true,
        autoRotate: carousel.autoRotate !== false,
        rotateIntervalMs: Math.max(Number(carousel.rotateIntervalSec || 5), 1) * 1000,
        items: itemsToSave
      }
    }

    callFunction('admin', 'saveSystemSettings', payload)
      .then((settings) => {
        const normalized = {
          enableTestAddressMode: settings.enableTestAddressMode === true,
          homeHeroCarousel: normalizeCarouselConfig(settings.homeHeroCarousel)
        }
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized, saving: false })
        this.resolveMediaUrls(normalized.homeHeroCarousel.items)
        wx.showToast({ title: '设置已保存' })
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
