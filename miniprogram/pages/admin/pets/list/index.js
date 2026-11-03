const { callFunction, showError } = require('../../../../utils/cloud')

const speciesTabs = [
  { label: '全部物种', value: '' },
  { label: '狗狗', value: 'dog' },
  { label: '猫咪', value: 'cat' },
  { label: '异宠', value: 'other' }
]

const contestTabs = [
  { label: '全部资格', value: '' },
  { label: '大赛正常', value: 'qualified' },
  { label: '已下架大赛', value: 'disqualified' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function withPetDisplay(pet) {
  const photoUrls = []
  if (pet.avatarFileId) photoUrls.push(pet.avatarFileId)
  if (Array.isArray(pet.beautyPhotos)) {
    pet.beautyPhotos.forEach(p => {
      const url = p.fileId || p.url
      if (url && !photoUrls.includes(url)) photoUrls.push(url)
    })
  }

  return {
    ...pet,
    avatarText: (pet.name || '宠').slice(0, 1),
    photoUrls,
    hasNotes: Boolean(pet.personality || pet.favoriteFood || pet.dislikes || pet.healthNotes || pet.specialNotes || (pet.careTags && pet.careTags.length) || pet.feedingNotes || pet.toiletNotes || pet.walkingNotes || pet.medicalCareNotes || pet.emergencyContactNote)
  }
}

Page({
  data: {
    pets: [],
    keyword: '',
    species: '',
    speciesTabs,
    contestStatus: '',
    contestTabs,
    page: 1,
    pageSize: 20,
    hasMore: true,
    total: 0,
    loading: false,
    expandedMap: {},
    disqualifyModal: {
      visible: false,
      petId: '',
      petName: '',
      exclusiveId: '',
      reason: ''
    }
  },

  onLoad(query = {}) {
    const update = {}
    if (query.keyword) {
      try {
        update.keyword = decodeURIComponent(query.keyword)
      } catch (_) {
        update.keyword = query.keyword
      }
    }
    if (query.species) update.species = query.species
    if (query.status || query.contestStatus) update.contestStatus = query.status || query.contestStatus
    if (Object.keys(update).length) this.setData(update)
  },

  onPullDownRefresh() {
    Promise.resolve(this.load({ reset: true })).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    this.load({ reset: true })
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('admin', 'listPets', {
      keyword: this.data.keyword,
      species: this.data.species,
      contestStatus: this.data.contestStatus,
      page,
      pageSize: this.data.pageSize
    })
      .then((result) => {
        const pageData = pageList(result)
        const pets = pageData.list.map(withPetDisplay)
        this.setData({
          pets: reset ? pets : this.data.pets.concat(pets),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.load({ reset: true })
  },

  switchSpecies(e) {
    const value = e.currentTarget.dataset.value ?? ''
    this.setData({ species: value })
    this.load({ reset: true })
  },

  switchContestStatus(e) {
    const value = e.currentTarget.dataset.value ?? ''
    this.setData({ contestStatus: value })
    this.load({ reset: true })
  },

  toggleExpand(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const current = Boolean(this.data.expandedMap[id])
    this.setData({
      [`expandedMap.${id}`]: !current
    })
  },

  copyText(e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: String(text),
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  previewPetPhotos(e) {
    const current = e.currentTarget.dataset.current
    const urls = e.currentTarget.dataset.urls || []
    if (!urls.length) return
    wx.previewImage({
      current,
      urls
    })
  },

  goToOwner(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.navigateTo({ url: `/pages/admin/users/edit/index?openid=${encodeURIComponent(openid)}` })
  },

  openDisqualifyModal(e) {
    const { petId, petName, exclusiveId } = e.currentTarget.dataset
    this.setData({
      disqualifyModal: {
        visible: true,
        petId: petId || '',
        petName: petName || '',
        exclusiveId: exclusiveId || '',
        reason: '违反大赛规则（AI生成或网图），取消参赛资格'
      }
    })
  },

  closeDisqualifyModal() {
    this.setData({
      'disqualifyModal.visible': false
    })
  },

  inputDisqualifyReason(e) {
    this.setData({
      'disqualifyModal.reason': e.detail.value
    })
  },

  noop() {},

  confirmDisqualify() {
    if (this._submittingDisqualify) return
    const { petId, reason } = this.data.disqualifyModal
    if (!petId) return
    this._submittingDisqualify = true
    const finalReason = String(reason || '').trim() || '违反大赛规则（AI生成或网图），取消参赛资格'
    wx.showLoading({ title: '处理中...', mask: true })
    callFunction('petBeauty', 'disqualifyPetBeautyCandidate', { petId, reason: finalReason })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已下架大赛资格', icon: 'success' })
        this.closeDisqualifyModal()
        this.load({ reset: true })
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
      .finally(() => {
        this._submittingDisqualify = false
      })
  },

  reinstateContest(e) {
    const { petId, petName } = e.currentTarget.dataset
    if (!petId) return
    wx.showModal({
      title: '恢复最美大赛资格',
      content: `确定要恢复宠物「${petName || '该宠物'}」参加最美大赛资格吗？`,
      confirmColor: '#2b9939',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中...', mask: true })
        callFunction('petBeauty', 'reinstatePetBeautyCandidate', { petId })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已恢复参赛资格', icon: 'success' })
            this.load({ reset: true })
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = [
      '/pages/admin/home/index',
      '/pages/admin/users/list/index',
      '/pages/admin/orders/list/index',
      '/pages/admin/staff-audit/list/index',
      '/pages/admin/pets/list/index'
    ]
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
