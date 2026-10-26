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
    this._visible = true
    const generation = this._pageGeneration = (this._pageGeneration || 0) + 1
    ensureLogin({ content: '登录后可进入宠物乐园。' })
      .then(() => { if (this._visible && generation === this._pageGeneration) return this.load() })
      .catch(() => { if (this._visible && generation === this._pageGeneration) wx.redirectTo({ url: '/pages/client/home/index' }) })
  },

  onHide() {
    this._visible = false
    this._pageGeneration = (this._pageGeneration || 0) + 1
    this._loadRequest = (this._loadRequest || 0) + 1
    if (this.data.savingCommunity) wx.hideLoading()
    this.setData({ savingCommunity: false })
  },

  onUnload() { this.onHide() },

  load() {
    if (this._visible === false || this.data.savingCommunity) return Promise.resolve()
    const generation = this._pageGeneration, request = this._loadRequest = (this._loadRequest || 0) + 1
    const current = () => this._visible !== false && generation === this._pageGeneration && request === this._loadRequest
    this.setData({ loading: true, empty: false, selectedPet: null, showCommunityModal: false })
    return callFunction('playground', 'getOverview')
      .then((overview) => {
        if (!current()) return
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
        if (!current()) return
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
    if (this.data.savingCommunity) return
    if (!this.data.hasCommunity) {
      this.setData({ showCommunityModal: true })
      return
    }
    wx.navigateTo({ url: '/packagePlayground/pages/world' })
  },

  openChooseCommunity() {
    if (this.data.savingCommunity) return
    this.selectComponent('#communityChooser').open()
      .then((loc) => this.saveCommunity(loc, false))
      .catch((error) => {
        if (error && error.errMsg && error.errMsg.includes('cancel')) return
        showError(error)
      })
  },

  selectCommunityAndEnter() {
    if (this.data.savingCommunity) return
    this.selectComponent('#communityChooser').open()
      .then((loc) => this.saveCommunity(loc, true))
      .catch((error) => {
        if (error && error.errMsg && error.errMsg.includes('cancel')) return
        showError(error)
      })
  },

  saveCommunity(loc, enterAfterSave) {
    if (this._visible === false || this.data.savingCommunity) return Promise.resolve(null)
    if (!loc || !loc.name) throw new Error('未选择有效小区')
    const generation = this._pageGeneration
    const current = () => this._visible !== false && generation === this._pageGeneration
    // A pending overview was captured before this save and must not revert it.
    this._loadRequest = (this._loadRequest || 0) + 1
    const community = {
      name: loc.name,
      ...(loc.serviceCommunityId ? { serviceCommunityId: loc.serviceCommunityId } : {}),
      city: loc.city || '', district: loc.district || '',
      address: loc.address || '',
      latitude: loc.latitude,
      longitude: loc.longitude
    }
    this.setData({ savingCommunity: true })
    wx.showLoading({ title: '正在保存小区…' })
    return callFunction('playground', 'saveCommunity', { community })
      .then((result) => {
        if (!current()) return result
        wx.hideLoading()
        this.setData({
          savingCommunity: false,
          loading: false,
          showCommunityModal: false,
          userCommunity: result.residentialCommunity,
          hasCommunity: Boolean(result.residentialCommunity && result.residentialCommunity.name)
        })
        wx.showToast({ title: '居住小区已更新', icon: 'success' })
        if (enterAfterSave) {
          wx.navigateTo({ url: '/packagePlayground/pages/world' })
        }
        return result
      })
      .catch((error) => {
        if (!current()) return
        wx.hideLoading()
        this.setData({ savingCommunity: false, loading: false })
        throw error
      })
  },

  enterSoloManor() {
    if (this.data.savingCommunity) return
    this.setData({ showCommunityModal: false })
    wx.navigateTo({ url: '/packagePlayground/pages/world' })
  },

  closeCommunityModal() {
    this.setData({ showCommunityModal: false })
  },

  openUserTitles() { this.selectComponent('#userTitles').open() },

  stopBubble() {}
})
