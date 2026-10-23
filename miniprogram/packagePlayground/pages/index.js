const { callFunction, showError, ensureLogin } = require('../../utils/cloud')

Page({
  data: {
    loading: true,
    empty: false,
    overview: null,
    pets: [],
    selectedPet: null,
    userCommunity: null,
    hasCommunity: false,
    showCommunityModal: false,
    savingCommunity: false
  },

  onShow() {
    ensureLogin({ content: '登录后可进入宠物乐园。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  load() {
    this.setData({ loading: true, empty: false, selectedPet: null, showCommunityModal: false })
    callFunction('playground', 'getOverview')
      .then((overview) => {
        const pets = overview.pets || []
        this.setData({
          overview,
          pets,
          empty: !pets.length,
          loading: false,
          userCommunity: overview.userCommunity || null,
          hasCommunity: Boolean(overview.hasCommunity)
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
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

  customize() {
    wx.navigateTo({url:'/packagePlayground/pages/customize'})
  },

  customizePet() {
    const pet=this.data.selectedPet
    if(pet)wx.navigateTo({url:'/packagePlayground/pages/customize?petId='+encodeURIComponent(pet._id)})
  },

  openWorld() {
    if (!this.data.hasCommunity) {
      this.setData({ showCommunityModal: true })
      return
    }
    wx.navigateTo({ url: '/packagePlayground/pages/world' })
  },

  openChooseCommunity() {
    this.selectComponent('#communityChooser').open()
      .then((loc) => this.saveCommunity(loc, false))
      .catch((error) => {
        if (error && error.errMsg && error.errMsg.includes('cancel')) return
        showError(error)
      })
  },

  selectCommunityAndEnter() {
    this.selectComponent('#communityChooser').open()
      .then((loc) => this.saveCommunity(loc, true))
      .catch((error) => {
        this.setData({ savingCommunity: false })
        if (error && error.errMsg && error.errMsg.includes('cancel')) return
        showError(error)
      })
  },

  saveCommunity(loc, enterAfterSave) {
    if (!loc || !loc.name) throw new Error('未选择有效小区')
    const community = {
      name: loc.name,
      city: loc.city || '', district: loc.district || '',
      address: loc.address || '',
      latitude: loc.latitude,
      longitude: loc.longitude
    }
    if (enterAfterSave) this.setData({ savingCommunity: true })
    wx.showLoading({ title: '正在保存小区…' })
    return callFunction('playground', 'saveCommunity', { community })
      .then((result) => {
        wx.hideLoading()
        this.setData({
          savingCommunity: false,
          showCommunityModal: false,
          userCommunity: result.residentialCommunity,
          hasCommunity: Boolean(result.residentialCommunity && result.residentialCommunity.name)
        })
        wx.showToast({ title: '居住小区已更新', icon: 'success' })
        if (enterAfterSave) {
          setTimeout(() => wx.navigateTo({ url: '/packagePlayground/pages/world' }), 400)
        }
        return result
      })
      .catch((error) => {
        wx.hideLoading()
        this.setData({ savingCommunity: false })
        throw error
      })
  },

  enterSoloManor() {
    this.setData({ showCommunityModal: false })
    wx.navigateTo({ url: '/packagePlayground/pages/world' })
  },

  closeCommunityModal() {
    this.setData({ showCommunityModal: false })
  },

  stopBubble() {}
})
