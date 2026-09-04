const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    monthKey: '',
    locked: false,
    hasVotedToday: false,
    votedPetId: '',
    candidates: [],
    ranking: [],
    keyword: '',
    page: 1,
    pageSize: 20,
    hasMore: false,
    loading: false,
    votingPetId: ''
  },

  onShow() {
    this.applyCurrentTheme()
    this.loadHome()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  loadHome() {
    if (this.data.loading) return
    this.setData({ loading: true })
    callFunction('petBeauty', 'getActivityHome')
      .then((res) => {
        this.setData({
          monthKey: res.monthKey || '',
          locked: res.locked === true,
          hasVotedToday: res.hasVotedToday === true,
          votedPetId: res.votedPetId || '',
          candidates: res.candidates || [],
          ranking: res.ranking || [],
          page: 1,
          hasMore: false,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  submitSearch() {
    this.loadRanking(true)
  },

  clearSearch() {
    this.setData({ keyword: '' }, () => this.loadHome())
  },

  loadRanking(reset = false) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true })
    callFunction('petBeauty', 'listRanking', { keyword: this.data.keyword, page, pageSize: this.data.pageSize })
      .then((res) => {
        this.setData({
          ranking: reset ? (res.list || []) : this.data.ranking.concat(res.list || []),
          page: res.page || page,
          hasMore: res.hasMore === true,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  previewPet(e) {
    const petId = e.currentTarget.dataset.id
    const pet = this.data.candidates.concat(this.data.ranking).find((item) => item.petId === petId)
    const urls = pet && Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos.map((photo) => photo.fileId).filter(Boolean) : []
    if (urls.length) wx.previewImage({ current: urls[0], urls })
  },

  vote(e) {
    const petId = e.currentTarget.dataset.id
    if (!petId || this.data.votingPetId || this.data.hasVotedToday || this.data.locked) return
    ensureLogin({ content: '登录后可为喜欢的宠物投票。' })
      .then(() => {
        this.setData({ votingPetId: petId })
        return callFunction('petBeauty', 'vote', { petId })
      })
      .then((res) => {
        const updateVote = (item) => item.petId === petId ? { ...item, voteCount: res.voteCount } : item
        this.setData({
          hasVotedToday: true,
          votedPetId: petId,
          votingPetId: '',
          candidates: this.data.candidates.map(updateVote),
          ranking: this.data.ranking.map(updateVote).sort((a, b) => Number(b.voteCount || 0) - Number(a.voteCount || 0))
        })
        wx.showToast({ title: '投票成功' })
      })
      .catch((err) => {
        this.setData({ votingPetId: '' })
        showError(err)
      })
  },

  loadMore() {
    if (this.data.hasMore) this.loadRanking(false)
  }
})
