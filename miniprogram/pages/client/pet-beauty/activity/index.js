const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const RANK_VIEW_STORAGE_KEY = 'petBeautyRankView'

function rankingViewData(ranking) {
  const rankColumns = [{ id: 'left', pets: [] }, { id: 'right', pets: [] }]
  ranking.forEach((pet, index) => {
    rankColumns[index % 2].pets.push({
      ...pet,
      displayRank: pet.rank || index + 1,
      coverUrl: pet.avatarFileId || (pet.beautyPhotos && pet.beautyPhotos[0] && pet.beautyPhotos[0].fileId) || ''
    })
  })
  return { ranking, rankColumns }
}

Page({
  data: {
    themeClass: 'theme-day',
    monthKey: '',
    currentMonthKey: '',
    selectedMonthIndex: 0,
    monthOptions: [],
    historyMonths: [],
    locked: false,
    currentMonthLocked: false,
    hasVotedToday: false,
    votedPetId: '',
    candidates: [],
    ranking: [],
    rankColumns: [],
    rankView: 'waterfall',
    keyword: '',
    page: 1,
    pageSize: 20,
    hasMore: false,
    loading: false,
    votingPetId: '',
    isHistory: false
  },

  onLoad() {
    try {
      const savedView = wx.getStorageSync(RANK_VIEW_STORAGE_KEY)
      if (savedView === 'list' || savedView === 'waterfall') this.setData({ rankView: savedView })
    } catch (err) {
      // Storage can be unavailable; the default view remains usable.
    }
  },

  switchRankView(e) {
    const rankView = e.currentTarget.dataset.view
    if (!['waterfall', 'list'].includes(rankView) || rankView === this.data.rankView) return
    this.setData({ rankView })
    try {
      wx.setStorageSync(RANK_VIEW_STORAGE_KEY, rankView)
    } catch (err) {
      // A storage failure must not prevent switching the current view.
    }
  },

  onShow() {
    this.applyCurrentTheme()
    this.loadHome()
    this.loadHistoryMonths()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  loadHistoryMonths() {
    callFunction('petBeauty', 'listHistoryMonths')
      .then((res) => {
        const historyMonths = res.months || []
        this.setData({ historyMonths }, () => this.updateMonthOptions())
      })
      .catch(() => {})
  },

  updateMonthOptions() {
    const current = this.data.currentMonthKey || this.data.monthKey
    if (!current) return
    const historyMonths = (this.data.historyMonths || []).filter((m) => m !== current)
    const monthOptions = [
      { label: `${current} (当月实时榜)`, value: current, isHistory: false },
      ...historyMonths.map((m) => ({ label: `${m} (往期历史榜)`, value: m, isHistory: true }))
    ]
    this.setData({ monthOptions })
  },

  loadHome() {
    if (this.data.loading) return
    this.setData({ loading: true })
    callFunction('petBeauty', 'getActivityHome')
      .then((res) => {
        const monthKey = res.monthKey || ''
        this.setData({
          monthKey,
          currentMonthKey: monthKey,
          locked: res.locked === true,
          currentMonthLocked: res.locked === true,
          hasVotedToday: res.hasVotedToday === true,
          votedPetId: res.votedPetId || '',
          candidates: res.candidates || [],
          ...rankingViewData(res.ranking || []),
          keyword: '',
          page: 1,
          hasMore: false,
          loading: false,
          isHistory: false,
          selectedMonthIndex: 0
        }, () => {
          this.updateMonthOptions()
          this.loadRanking(true)
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  onMonthChange(e) {
    if (this.data.loading) return
    const index = Number(e.detail.value)
    const opt = this.data.monthOptions[index]
    if (!opt) return
    this.setData({
      selectedMonthIndex: index,
      isHistory: opt.isHistory,
      locked: opt.isHistory || this.data.currentMonthLocked
    }, () => {
      this.loadRanking(true)
    })
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  submitSearch() {
    this.loadRanking(true)
  },

  clearSearch() {
    this.setData({ keyword: '' }, () => this.loadRanking(true))
  },

  loadRanking(reset = false) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    const opt = this.data.monthOptions[this.data.selectedMonthIndex] || {}
    const historyMonthKey = opt.isHistory ? opt.value : ''
    this.setData({ loading: true })
    callFunction('petBeauty', 'listRanking', { keyword: this.data.keyword, historyMonthKey, page, pageSize: this.data.pageSize })
      .then((res) => {
        this.setData({
          ...rankingViewData(reset ? (res.list || []) : this.data.ranking.concat(res.list || [])),
          page: res.page || page,
          hasMore: res.hasMore === true,
          loading: false,
          isHistory: res.isHistory === true,
          locked: res.isHistory === true || res.locked === true || this.data.currentMonthLocked
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  previewPet(e) {
    const petId = e.currentTarget.dataset.id
    const pet = this.data.ranking.concat(this.data.candidates).find((item) => item.petId === petId)
    const urls = pet && Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos.map((photo) => photo.fileId).filter(Boolean) : []
    if (!urls.length && pet && pet.avatarFileId) urls.push(pet.avatarFileId)
    if (urls.length) wx.previewImage({ current: urls[0], urls })
  },

  vote(e) {
    const petId = e.currentTarget.dataset.id
    if (!petId || this.data.votingPetId || this.data.hasVotedToday || this.data.locked || this.data.isHistory) return
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
          ...rankingViewData(this.data.ranking.map(updateVote))
        })
        wx.showToast({ title: '投票成功' })
        this.loadRanking(true)
      })
      .catch((err) => {
        this.setData({ votingPetId: '' })
        showError(err)
      })
  },

  onPullDownRefresh() {
    this.loadHome()
    wx.stopPullDownRefresh()
  },

  onShareAppMessage() {
    return {
      title: '晒出爱宠美照，快来为我家宝贝投上一票吧！',
      path: '/pages/client/pet-beauty/activity/index'
    }
  },

  onShareTimeline() {
    return {
      title: '最美宠物月榜大比拼，快来投票！',
      query: ''
    }
  },

  loadMore() {
    if (this.data.hasMore) this.loadRanking(false)
  }
})
