const { callFunction, showError, ensureLogin } = require('../../utils/cloud')

Page({
  data: {
    loading: true,
    empty: false,
    renderError: '',
    overview: null,
    pets: [],
    selectedPet: null,
    customModalVisible: false,
    customTab: 'ai',
    aiPhotoUrl: '',
    aiGenerating: false,
    manualModelUrl: '',
    manualScale: 1.0,
    manualUploading: false
  },

  onShow() {
    ensureLogin({ content: '登录后可进入宠物乐园。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  onHide() {
    this.destroyScene()
  },

  onUnload() {
    this.destroyScene()
  },

  load() {
    this.setData({ loading: true, empty: false, renderError: '', selectedPet: null, customModalVisible: false })
    this.destroyScene()
    callFunction('playground', 'getOverview')
      .then((overview) => {
        const pets = overview.pets || []
        this.setData({ overview, pets, empty: !pets.length, loading: false })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  initScene(overview) {
    let createPlayground3D
    try {
      createPlayground3D = require('../utils/playground3d').createPlayground3D
    } catch (error) {
      this.setData({ renderError: '3D 引擎加载失败，请重新编译小程序后再试' })
      return
    }
    createPlayground3D(this, '#playgroundCanvas', overview)
      .then((scene) => {
        this.playgroundScene = scene
      })
      .catch((error) => {
        this.setData({ renderError: error && (error.message || error.errMsg) || '当前设备暂不支持 3D 乐园' })
      })
  },

  destroyScene() {
    if (this.playgroundScene && this.playgroundScene.destroy) this.playgroundScene.destroy()
    this.playgroundScene = null
  },

  retryRender() {
    if (!this.data.overview || !this.data.pets.length) return
    this.setData({ renderError: '' })
    wx.nextTick(() => setTimeout(() => this.initScene(this.data.overview), 80))
  },

  choosePet(e) {
    const petId = e.currentTarget.dataset.id
    const selectedPet = (this.data.pets || []).find((item) => item._id === petId) || null
    this.setData({
      selectedPet,
      aiPhotoUrl: (selectedPet && (selectedPet.avatarFileId || selectedPet.customModelUrl)) || '',
      manualModelUrl: (selectedPet && selectedPet.customModelUrl) || '',
      manualScale: 1.0
    })
  },

  closePetCard() {
    this.setData({ selectedPet: null })
  },

  openCustomModal() {
    if (!this.data.selectedPet) return
    this.setData({
      customModalVisible: true,
      customTab: 'ai',
      aiPhotoUrl: this.data.selectedPet.avatarFileId || '',
      manualModelUrl: this.data.selectedPet.customModelUrl || '',
      manualScale: 1.0
    })
  },

  closeCustomModal() {
    this.setData({ customModalVisible: false, aiGenerating: false, manualUploading: false })
  },

  switchCustomTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab) this.setData({ customTab: tab })
  },

  chooseCustomPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (!tempFilePath) return
        wx.showLoading({ title: '正在上传照片...' })
        const cloudPath = `playground/photos/${this.data.selectedPet._id}_${Date.now()}.jpg`
        wx.cloud.uploadFile({
          cloudPath,
          filePath: tempFilePath,
          success: (uploadRes) => {
            wx.hideLoading()
            this.setData({ aiPhotoUrl: uploadRes.fileID })
          },
          fail: (err) => {
            wx.hideLoading()
            showError(err || '上传照片失败')
          }
        })
      }
    })
  },

  triggerAiGeneration() {
    const pet = this.data.selectedPet
    if (!pet) return
    const photoUrl = this.data.aiPhotoUrl || pet.avatarFileId
    if (!photoUrl) {
      wx.showToast({ title: '请先提供宠物照片', icon: 'none' })
      return
    }
    this.setData({ aiGenerating: true })
    callFunction('playground', 'generatePet3DModel', {
      petId: pet._id,
      imageFileId: photoUrl,
      provider: 'auto',
      scale: this.data.manualScale || 1.0
    }).then(() => {
      this.setData({ aiGenerating: false })
      wx.showToast({ title: 'AI 3D 建模成功！', icon: 'success' })
      this.closeCustomModal()
      this.load()
    }).catch((err) => {
      this.setData({ aiGenerating: false })
      showError(err || 'AI 建模失败，请稍后重试')
    })
  },

  chooseLocalGlbFile() {
    const pet = this.data.selectedPet
    if (!pet) return
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '当前环境请手动输入云存储路径', icon: 'none' })
      return
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['glb', 'gltf'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        this.setData({ manualUploading: true })
        wx.showLoading({ title: '正在上传模型...' })
        const cloudPath = `playground/custom_models/${pet._id}_${Date.now()}.glb`
        wx.cloud.uploadFile({
          cloudPath,
          filePath: file.path,
          success: (uploadRes) => {
            wx.hideLoading()
            this.setData({ manualUploading: false, manualModelUrl: uploadRes.fileID })
            wx.showToast({ title: '模型已传至云端', icon: 'success' })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ manualUploading: false })
            showError(err || '模型上传失败')
          }
        })
      },
      fail: (err) => {
        if (err && err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '选择模型文件取消或失败', icon: 'none' })
        }
      }
    })
  },

  onManualUrlInput(e) {
    this.setData({ manualModelUrl: (e.detail.value || '').trim() })
  },

  onScaleChange(e) {
    const scale = Number(e.currentTarget.dataset.scale)
    if (scale > 0) this.setData({ manualScale: scale })
  },

  saveManualModel() {
    if (this.savingManual) return
    const pet = this.data.selectedPet
    if (!pet) return
    const modelUrl = (this.data.manualModelUrl || '').trim()
    if (!modelUrl) {
      wx.showToast({ title: '请先上传或输入模型路径', icon: 'none' })
      return
    }
    this.savingManual = true
    wx.showLoading({ title: '正在绑定模型...' })
    callFunction('playground', 'bindPetCustomModel', {
      petId: pet._id,
      modelUrl,
      scale: this.data.manualScale || 1.0
    }).then(() => {
      this.savingManual = false
      wx.hideLoading()
      wx.showToast({ title: '专属模型绑定成功！', icon: 'success' })
      this.closeCustomModal()
      this.load()
    }).catch((err) => {
      this.savingManual = false
      wx.hideLoading()
      showError(err || '绑定模型失败')
    })
  },

  resetToDefaultModel() {
    if (this.resettingModel) return
    const pet = this.data.selectedPet
    if (!pet) return
    wx.showModal({
      title: '确认恢复',
      content: '是否确认撤销专属 3D 模型，恢复为系统默认基础模型？',
      success: (m) => {
        if (!m.confirm) return
        this.resettingModel = true
        wx.showLoading({ title: '正在恢复...' })
        callFunction('playground', 'bindPetCustomModel', {
          petId: pet._id,
          modelUrl: ''
        }).then(() => {
          this.resettingModel = false
          wx.hideLoading()
          wx.showToast({ title: '已恢复默认模型', icon: 'success' })
          this.closeCustomModal()
          this.load()
        }).catch((err) => {
          this.resettingModel = false
          wx.hideLoading()
          showError(err || '操作失败')
        })
      }
    })
  },

  goAddPet() {
    wx.navigateTo({ url: '/pages/client/pets/edit/index' })
  },

  goPets() {
    wx.navigateTo({ url: '/pages/client/pets/list/index' })
  },

  openWorld() {
    wx.navigateTo({ url: '/packagePlayground/pages/world' })
  },

  showComingSoon() {
    wx.showToast({ title: '下一阶段开放', icon: 'none' })
  }
})

