const { callFunction, showError, ensureLogin } = require('../../utils/cloud')

Page({
  data: {
    loading: true,
    empty: false,
    renderError: '',
    overview: null,
    pets: [],
    selectedPet: null,
    generatingTip: 'AI 3D 形象、衣物间和抽奖活动将在下一阶段开放'
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
    this.setData({ loading: true, empty: false, renderError: '', selectedPet: null })
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
    this.setData({ selectedPet })
  },

  closePetCard() {
    this.setData({ selectedPet: null })
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
