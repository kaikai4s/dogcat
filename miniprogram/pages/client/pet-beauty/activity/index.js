const { toBeijingDate } = require('../../../../utils/format')
const cloud = require('../../../../utils/cloud') || {}
const { callFunction, showError, ensureLogin, savePendingInvite, getCachedUser } = cloud
const showLoading = (opts) => {
  if (typeof cloud.showLoading === 'function') return cloud.showLoading(opts)
  if (typeof wx !== 'undefined' && typeof wx.showLoading === 'function') return wx.showLoading(opts)
}
const hideLoading = () => {
  if (typeof cloud.hideLoading === 'function') return cloud.hideLoading()
  if (typeof wx !== 'undefined' && typeof wx.hideLoading === 'function') {
    try { wx.hideLoading() } catch (_) {}
  }
}
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const RANK_VIEW_STORAGE_KEY = 'petBeautyRankView'

function formatContestTitle(monthKey) {
  if (monthKey && typeof monthKey === 'string') {
    const match = monthKey.match(/(?:^\d{4}-)?0?(\d{1,2})$/)
    if (match) {
      return `${parseInt(match[1], 10)}月宠物最美大赛`
    }
  }
  const currentMonth = toBeijingDate(new Date()).getUTCMonth() + 1
  return `${currentMonth}月宠物最美大赛`
}

function getPetPhotos(pet) {
  const list = []
  if (Array.isArray(pet && pet.beautyPhotos) && pet.beautyPhotos.length > 0) {
    pet.beautyPhotos.forEach((photo) => {
      const url = photo && (photo.fileId || photo.url || (typeof photo === 'string' ? photo : ''))
      if (url && typeof url === 'string' && !list.includes(url)) list.push(url)
    })
  }
  const avatar = pet && (pet.avatarFileId || pet.avatarUrl || pet.avatar || '')
  if (!list.length && avatar && typeof avatar === 'string') {
    list.push(avatar)
  }
  return list
}

function decoratePetCard(pet, index, activeIndices = {}) {
  const photos = getPetPhotos(pet)
  const photoCount = photos.length
  const activeIndex = photoCount > 0 ? (activeIndices[pet.petId] || 0) % photoCount : 0
  const topPhotoUrl = photos[activeIndex] || (pet && (pet.avatarFileId || pet.avatarUrl)) || ''
  const nextPhotoUrl = photoCount > 1 ? photos[(activeIndex + 1) % photoCount] : ''
  const bottomPhotoUrl = photoCount > 2 ? photos[(activeIndex + 2) % photoCount] : ''

  const stackCards = photos.map((photoUrl, photoIndex) => {
    const offset = (photoIndex - activeIndex + photoCount) % photoCount
    let role = 'hidden'
    let zIndex = 1
    if (offset === 0) {
      role = 'top'
      zIndex = 10
    } else if (offset === 1) {
      role = 'next'
      zIndex = 5
    } else if (offset === 2 && photoCount > 2) {
      role = 'bottom'
      zIndex = 2
    }
    return {
      photoUrl,
      photoIndex,
      offset,
      role,
      zIndex
    }
  })

  const dots = []
  for (let d = 0; d < photoCount; d++) {
    dots.push({ index: d, active: d === activeIndex })
  }

  return {
    ...pet,
    displayRank: pet.rank || index + 1,
    coverUrl: topPhotoUrl,
    photos,
    photoCount,
    activePhotoIndex: activeIndex,
    displayPhotoIndex: activeIndex + 1,
    topPhotoUrl,
    nextPhotoUrl,
    bottomPhotoUrl,
    hasMultiplePhotos: photoCount > 1,
    stackCards,
    dots
  }
}

function rankingViewData(ranking, activeIndices = {}) {
  const rankColumns = [{ id: 'left', pets: [] }, { id: 'right', pets: [] }]
  const decoratedRanking = ranking.map((pet, index) => {
    const decorated = decoratePetCard(pet, index, activeIndices)
    rankColumns[index % 2].pets.push(decorated)
    return decorated
  })
  return { ranking: decoratedRanking, rankColumns }
}

Page({
  data: {
    themeClass: 'theme-day',
    rankingMaintenance: false,
    maintenanceLoading: true,
    activityReady: false,
    activityLoadError: false,
    monthKey: '',
    currentMonthKey: '',
    selectedMonthIndex: 0,
    monthOptions: [],
    historyMonths: [],
    locked: false,
    currentMonthLocked: false,
    hasVotedToday: false,
    remainingVotesToday: 1,
    todayBonusVotes: 0,
    totalVotesToday: 1,
    votedPetId: '',
    animatingPetId: '',
    candidates: [],
    ranking: [],
    rankColumns: [],
    rankView: 'waterfall',
    keyword: '',
    page: 1,
    pageSize: 100,
    hasMore: false,
    loading: false,
    votingPetId: '',
    isHistory: false,
    showPreviewModal: false,
    previewModalPet: null,
    previewModalPhotoIndex: 0,
    contestConfig: {
      enabled: true,
      enableFrontendDisqualify: true,
      firstPrizeAmount: 0,
      rewardAmount: 0,
      posterUrl: '',
      posterFileId: '',
      bannerTitle: '最美爱宠月度大赛',
      bannerSubtitle: '晒出爱宠萌照 · 争夺月度冠军现金大奖与全服专属头衔',
      rulesSummary: '每月评选 · 每日免费投1票 · 榜首专享现金奖与全服荣誉',
      detailedRules: ''
    },
    inviteCode: '',
    userOpenid: '',
    pageTitle: formatContestTitle(''),
    posterLoaded: false,
    photoLoadedMap: {},
    showRulesModal: false,
    isAdmin: false
  },

  updateContestTitle(monthKey) {
    const selectedOpt = Array.isArray(this.data.monthOptions) && this.data.monthOptions[this.data.selectedMonthIndex]
    const effectiveKey = monthKey || (selectedOpt && selectedOpt.value) || this.data.monthKey || this.data.currentMonthKey
    const title = formatContestTitle(effectiveKey)
    this.setData({ pageTitle: title })
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      try { wx.setNavigationBarTitle({ title }) } catch (_) {}
    }
    return title
  },

  onLoad(options = {}) {
    const inviteCode = String((options && options.inviteCode) || '').trim().toUpperCase()
    const inviterOpenid = String((options && options.inviterOpenid) || '').trim()
    if (inviteCode || inviterOpenid) {
      if (typeof savePendingInvite === 'function') {
        savePendingInvite({ inviteCode, inviterOpenid })
      }
      this._pendingInvite = { inviteCode, inviterOpenid }
    }
    this.updateContestTitle((options && options.monthKey) || '')
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
    if (this._skipNextOnShow) {
      this._skipNextOnShow = false
      return
    }
    this.updateContestTitle()
    this.applyCurrentTheme()
    try {
      const user = typeof getCachedUser === 'function' ? getCachedUser() : null
      const isAdmin = Boolean(user && ((Array.isArray(user.roles) && user.roles.includes('admin')) || user.role === 'admin' || user.adminSuper))
      this.setData({ isAdmin })
    } catch (_) {}
    if (typeof cloud.loadSystemSettings !== 'function') {
      this.setData({ maintenanceLoading: false })
      this.loadHistoryMonths()
      return this.loadHome()
    }
    this.setData({ maintenanceLoading: true })
    return cloud.loadSystemSettings().then((settings) => {
      const paused = settings.maintenance?.petRanking === true
      this.setData({ rankingMaintenance: paused, maintenanceLoading: false })
      if (paused) return
      this.loadHistoryMonths()
      return this.loadHome()
    }).catch((error) => {
      this.setData({ maintenanceLoading: false, activityLoadError: !this.data.activityReady })
      showError(error)
    })
  },

  backFromMaintenance() {
    wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/client/home/index' }) })
  },

  retryActivity() {
    return this.onShow()
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
    this.setData({ loading: true, activityLoadError: false })
    const pendingInvite = this._pendingInvite || {}
    return callFunction('petBeauty', 'getActivityHome', { ...pendingInvite })
      .then((res) => {
        const monthKey = res.monthKey || ''
        const contestConfig = res.contestConfig || this.data.contestConfig
        const remainingVotesToday = Number(res.remainingVotesToday ?? (res.hasVotedToday ? 0 : 1))
        this.updateContestTitle(monthKey)
        this.setData({
          monthKey,
          currentMonthKey: monthKey,
          locked: res.locked === true,
          currentMonthLocked: res.locked === true,
          hasVotedToday: res.hasVotedToday === true,
          remainingVotesToday,
          todayBonusVotes: Number(res.todayBonusVotes || 0),
          totalVotesToday: Number(res.totalVotesToday || 1),
          votedPetId: res.votedPetId || '',
          inviteCode: res.inviteCode || this.data.inviteCode || '',
          userOpenid: res.userOpenid || this.data.userOpenid || '',
          contestConfig,
          activityReady: true,
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
        this.setData({ loading: false, activityLoadError: !this.data.activityReady })
        showError(err)
      })
  },

  openRulesModal() {
    this.setData({ showRulesModal: true })
  },

  closeRulesModal() {
    this.setData({ showRulesModal: false })
  },

  previewPoster() {
    const poster = this.data.contestConfig && (this.data.contestConfig.posterUrl || this.data.contestConfig.posterFileId)
    if (poster && typeof wx !== 'undefined' && typeof wx.previewImage === 'function') {
      this._skipNextOnShow = true
      wx.previewImage({
        current: poster,
        urls: [poster],
        fail: () => {
          this._skipNextOnShow = false
        }
      })
    }
  },

  onPosterLoaded() {
    this.setData({ posterLoaded: true })
  },

  onPosterImgError() {
    this.setData({ posterLoaded: true })
  },

  onPetPhotoLoaded(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key
    if (!key || (this.data.photoLoadedMap && this.data.photoLoadedMap[key])) return
    this.setData({
      [`photoLoadedMap.${key}`]: true
    })
  },

  onPetPhotoError(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key
    if (!key || (this.data.photoLoadedMap && this.data.photoLoadedMap[key])) return
    this.setData({
      [`photoLoadedMap.${key}`]: true
    })
  },

  onMonthChange(e) {
    if (this.data.loading) return
    const index = Number(e.detail.value)
    const opt = this.data.monthOptions[index]
    if (!opt) return
    this.updateContestTitle(opt.value)
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

  submitSearch(e) {
    const rawVal = e && e.detail && typeof e.detail.value === 'string' ? e.detail.value : this.data.keyword
    const val = String(rawVal || '').trim()
    if (val !== this.data.keyword) {
      this.setData({ keyword: val }, () => this.loadRanking(true))
    } else {
      this.loadRanking(true)
    }
  },

  clearSearch() {
    this.setData({ keyword: '' }, () => this.loadRanking(true))
  },

  loadRanking(reset = false, options = {}) {
    if (this.data.loading) return
    const isVoteRefresh = options.isVoteRefresh === true
    const currentPage = this.data.page || 1
    const pageSize = this.data.pageSize || 10
    const queryPage = (isVoteRefresh && currentPage > 1) ? 1 : (reset ? 1 : currentPage + 1)
    const queryPageSize = (isVoteRefresh && currentPage > 1) ? Math.min(currentPage * pageSize, 100) : pageSize
    const opt = this.data.monthOptions[this.data.selectedMonthIndex] || {}
    const historyMonthKey = opt.isHistory ? opt.value : ''
    this.setData({ loading: true })
    callFunction('petBeauty', 'listRanking', { keyword: this.data.keyword, historyMonthKey, page: queryPage, pageSize: queryPageSize })
      .then((res) => {
        const nextList = (reset || (isVoteRefresh && currentPage > 1))
          ? (res.list || [])
          : this.data.ranking.concat(res.list || [])
        this.setData({
          ...rankingViewData(nextList, this._petActivePhotoIndices || {}),
          page: isVoteRefresh ? currentPage : (res.page || queryPage),
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
    if (!e || !e.isProgrammatic) {
      if (this._justSwipedTime && Date.now() - this._justSwipedTime < 350) return
    }
    const petId = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || (e && e.petId)
    const pet = this.data.ranking.concat(this.data.candidates).find((item) => item.petId === petId)
    let urls = pet && Array.isArray(pet.photos) && pet.photos.length ? pet.photos.slice() : []
    if (!urls.length && pet) {
      urls = getPetPhotos(pet)
    }
    if (urls.length && typeof wx !== 'undefined' && typeof wx.previewImage === 'function') {
      const activeIdx = (this._petActivePhotoIndices && this._petActivePhotoIndices[petId]) || (pet && pet.activePhotoIndex) || 0
      const currentUrl = urls[activeIdx] || urls[0]
      this._skipNextOnShow = true
      wx.previewImage({
        current: currentUrl,
        urls,
        fail: () => {
          this._skipNextOnShow = false
        }
      })
    }
  },

  previewPetById(data) {
    const petId = data && data.petId
    if (!petId) return
    const pet = this.data.ranking.concat(this.data.candidates).find((item) => item.petId === petId)
    if (pet) {
      this.setData({
        previewModalPet: pet,
        previewModalPhotoIndex: pet.activePhotoIndex || 0,
        showPreviewModal: true
      })
    }
    this.previewPet({ isProgrammatic: true, currentTarget: { dataset: { id: petId } } })
  },

  onCardSwipeOut(data) {
    const petId = data && data.petId
    if (!petId) return
    this._justSwipedTime = Date.now()
    if (!this._petActivePhotoIndices) this._petActivePhotoIndices = {}
    const pet = this.data.ranking.concat(this.data.candidates).find((item) => item.petId === petId)
    const photoCount = pet && pet.photoCount ? pet.photoCount : (pet && pet.photos ? pet.photos.length : (pet && Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos.length : 1))
    if (photoCount <= 1) return
    const current = this._petActivePhotoIndices[petId] || 0
    const nextIndex = (current + 1) % photoCount
    this._petActivePhotoIndices[petId] = nextIndex

    const applyUpdate = () => {
      const currentRanking = this.data.ranking || []
      const newViewData = rankingViewData(currentRanking, this._petActivePhotoIndices)
      const updatedPet = (newViewData.ranking || []).find((item) => item.petId === petId)
      const updatePayload = { ...newViewData }
      if (this.data.previewModalPet && this.data.previewModalPet.petId === petId && updatedPet) {
        updatePayload.previewModalPet = updatedPet
        updatePayload.previewModalPhotoIndex = nextIndex
      }
      this.setData(updatePayload)
    }

    const isTestEnv = typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function'
    if (isTestEnv || (data && data.immediate)) {
      applyUpdate()
    } else {
      setTimeout(applyUpdate, 260)
    }
  },

  closePreviewModal() {
    this.setData({ showPreviewModal: false, previewModalPet: null })
  },

  handleAdminDisqualify(e) {
    const petId = (e && e.currentTarget && e.currentTarget.dataset && (e.currentTarget.dataset.id || e.currentTarget.dataset.petid)) || (this.data.previewModalPet && this.data.previewModalPet.petId)
    const petName = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.name) || (this.data.previewModalPet && this.data.previewModalPet.name) || '该宠物'
    if (!petId) return
    const reasons = [
      'AI 生成图片，非真实自养宠物',
      '网络盗图，非真实自养宠物',
      '涉及违规刷票，取消参赛资格',
      '其他违反大赛规则行为'
    ]
    if (typeof wx !== 'undefined' && typeof wx.showActionSheet === 'function') {
      wx.showActionSheet({
        itemList: reasons,
        success: (res) => {
          const reason = reasons[res.tapIndex]
          wx.showModal({
            title: '管理员违规下架确认',
            content: `确定取消“${petName}”参赛资格并从大赛榜单下架吗？\n下架理由：${reason}`,
            confirmText: '确认下架',
            confirmColor: '#e54d42',
            success: (confirmRes) => {
              if (confirmRes.confirm) {
                showLoading({ title: '正在下架...' })
                callFunction('petBeauty', 'disqualifyPetBeautyCandidate', { petId, reason })
                  .then(() => {
                    hideLoading()
                    wx.showToast({ title: '已取消参赛资格', icon: 'success' })
                    this.closePreviewModal()
                    this.loadHome()
                  })
                  .catch((err) => {
                    hideLoading()
                    showError(err)
                  })
              }
            }
          })
        }
      })
    }
  },

  onPetCardLongPress(e) {
    if (!this.data.isAdmin || this.data.contestConfig?.enableFrontendDisqualify === false) return
    this.handleAdminDisqualify(e)
  },

  nextModalPhoto() {
    const pet = this.data.previewModalPet
    if (!pet || !pet.photos || pet.photos.length <= 1) return
    const nextIndex = (this.data.previewModalPhotoIndex + 1) % pet.photos.length
    this.setData({ previewModalPhotoIndex: nextIndex })
  },

  prevModalPhoto() {
    const pet = this.data.previewModalPet
    if (!pet || !pet.photos || pet.photos.length <= 1) return
    const prevIndex = (this.data.previewModalPhotoIndex - 1 + pet.photos.length) % pet.photos.length
    this.setData({ previewModalPhotoIndex: prevIndex })
  },

  noop() {},

  vote(e) {
    const petId = e.currentTarget.dataset.id
    if (!petId || this._votingLock || this.data.votingPetId || this.data.hasVotedToday || this.data.locked || this.data.isHistory) return
    this._votingLock = true
    // 立即激活“按钮变透明玻璃爱心 -> 向左飞留心电图变红 -> 水滴融入 -> 票数滚动”动画
    this.setData({ animatingPetId: petId, votingPetId: petId })
    if (typeof wx !== 'undefined' && typeof wx.vibrateShort === 'function') {
      try { wx.vibrateShort({ type: 'light' }) } catch (_) {}
    }

    ensureLogin({ content: '登录后可为喜欢的宠物投票。' })
      .then(() => callFunction('petBeauty', 'vote', { petId }))
      .then((res) => {
        const isTestEnv = typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function'
        const applyVoteUpdate = () => {
          this._votingLock = false
          const nextRemaining = Number(res.remainingVotesToday ?? 0)
          const updateVote = (item) => item.petId === petId ? { ...item, voteCount: res.voteCount } : item
          const payload = {
            hasVotedToday: nextRemaining === 0,
            remainingVotesToday: nextRemaining,
            todayBonusVotes: Number(res.todayBonusVotes ?? this.data.todayBonusVotes ?? 0),
            totalVotesToday: Number(res.totalVotesToday ?? this.data.totalVotesToday ?? 1),
            votedPetId: petId,
            candidates: this.data.candidates.map(updateVote),
            ...rankingViewData(this.data.ranking.map(updateVote))
          }
          if (this.data.previewModalPet && this.data.previewModalPet.petId === petId) {
            payload.previewModalPet = { ...this.data.previewModalPet, voteCount: res.voteCount }
          }
          this.setData(payload)

          if (isTestEnv) {
            this.setData({ animatingPetId: '', votingPetId: '' })
            this.loadRanking(true, { isVoteRefresh: true })
          } else {
            // 动效完整演进（约 1100ms）后清理动画标识，展示已投/剩余票状态
            setTimeout(() => {
              this.setData({ animatingPetId: '', votingPetId: '' })
              this.loadRanking(true, { isVoteRefresh: true })
            }, 350)
          }
        }

        if (isTestEnv) {
          applyVoteUpdate()
        } else {
          // 在真实小程序端，动画进行到水滴汇合融入左侧爱心（约 750ms）时，将真实票数推入滚动动画中
          setTimeout(applyVoteUpdate, 750)
        }
      })
      .catch((err) => {
        this._votingLock = false
        this.setData({ animatingPetId: '', votingPetId: '', loading: false })
        if (err.code === 'MODULE_MAINTENANCE' || String(err.message || '').includes('正在维护中')) {
          this.setData({ rankingMaintenance: true })
        } else showError(err)
      })
  },

  onPullDownRefresh() {
    this._skipNextOnShow = false
    return Promise.resolve(this.onShow()).finally(() => {
      if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh()
      }
    })
  },

  onShareAppMessage() {
    this._skipNextOnShow = true
    if (this.data.rankingMaintenance) return { title: '宠物排行榜维护中', path: '/pages/client/home/index' }
    const inviteCode = this.data.inviteCode || ''
    const inviterOpenid = this.data.userOpenid || ''
    const title = this.data.pageTitle ? `${this.data.pageTitle}火热进行中，快来为我家宝贝投上一票吧！` : '晒出爱宠萌照，快来为我家宝贝投上一票吧！'
    const queryParts = []
    if (inviteCode) queryParts.push(`inviteCode=${encodeURIComponent(inviteCode)}`)
    if (inviterOpenid) queryParts.push(`inviterOpenid=${encodeURIComponent(inviterOpenid)}`)
    const queryString = queryParts.length ? `?${queryParts.join('&')}` : ''
    return {
      title,
      path: `/pages/client/pet-beauty/activity/index${queryString}`
    }
  },

  onShareTimeline() {
    this._skipNextOnShow = true
    const inviteCode = this.data.inviteCode || ''
    const inviterOpenid = this.data.userOpenid || ''
    const title = this.data.pageTitle ? `${this.data.pageTitle}大比拼，快来投票！` : '最美宠物月榜大比拼，快来投票！'
    const queryParts = []
    if (inviteCode) queryParts.push(`inviteCode=${encodeURIComponent(inviteCode)}`)
    if (inviterOpenid) queryParts.push(`inviterOpenid=${encodeURIComponent(inviterOpenid)}`)
    return {
      title,
      query: queryParts.join('&')
    }
  },

  loadMore() {
    if (this.data.hasMore) this.loadRanking(false)
  }
})
