const { callFunction, showError } = require('../../../utils/cloud')
const { withStaffWorkflowText, formatDateTime } = require('../../../utils/format')
const { applyTheme, getThemeState } = require('../../../utils/theme')

function buildSteps(profile = {}, videos = []) {
  return [
    { title: '资料审核', desc: profile.auditStatus === 'approved' ? '已通过' : '待通过', done: profile.auditStatus === 'approved' },
    { title: '培训答题', desc: profile.quizPassedAt ? '已通过' : '待完成', done: Boolean(profile.quizPassedAt) },
    { title: '培训视频', desc: videos.every((item) => item.watched) ? '已完成' : '待观看', done: videos.every((item) => item.watched) },
    { title: '线上视频审核', desc: profile.videoAuditStatusText || '未申请', done: profile.videoAuditStatus === 'approved' },
    { title: '实习宠托师', desc: profile.staffLevel === 'intern' || profile.staffLevel === 'certified' ? '已达成' : '待达成', done: profile.staffLevel === 'intern' || profile.staffLevel === 'certified' }
  ]
}

Page({
  data: {
    themeClass: 'theme-day',
    profile: null,
    quiz: null,
    answers: {},
    videos: [],
    steps: [],
    videoAuditGuide: null,
    canRequestVideoAudit: false,
    loading: false,
    depositState: null,
    depositLoading: false,
    depositError: false,
    depositBusy: false,
    depositAgreed: false,
    refundReason: ''
  },

  onShow() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
    this.load()
    if (!this.data.depositBusy) this.loadDeposit()
  },

  async loadDeposit() {
    this.setData({ depositLoading: true, depositError: false, depositAgreed: false })
    try {
      const depositState = await callFunction('staff', 'getDepositStatus')
      this.setData({ depositState })
    } catch (error) {
      this.setData({ depositState: null, depositError: true })
      showError(error)
    } finally {
      this.setData({ depositLoading: false })
    }
  },

  agreeDeposit(e) {
    this.setData({ depositAgreed: e.detail.value.includes('agreed') })
  },

  inputRefundReason(e) {
    this.setData({ refundReason: e.detail.value })
  },

  async payDeposit() {
    const state = this.data.depositState
    if (this.data.depositBusy || this.data.depositLoading || !state || !state.canPay) return
    if (!this.data.depositAgreed) {
      wx.showToast({ title: '请先阅读并同意规则', icon: 'none' })
      return
    }
    this.setData({ depositBusy: true })
    wx.showLoading({ title: '创建支付...', mask: true })
    try {
      const result = await callFunction('staff', 'createDepositPayment', { agreed: true })
      wx.hideLoading()
      if (!result.paid) {
        if (!result.payParams) throw new Error('支付暂不可用，请稍后重试或联系平台')
        await new Promise((resolve, reject) => wx.requestPayment({ ...result.payParams, success: resolve, fail: reject }))
      }
      wx.showToast({ title: '正在核实服务端支付状态', icon: 'none' })
    } catch (error) {
      showError(error)
    } finally {
      wx.hideLoading()
      await this.loadDeposit()
      this.load()
      this.setData({ depositBusy: false })
    }
  },

  requestRefund() {
    const state = this.data.depositState
    if (this.data.depositBusy || this.data.depositLoading || !state || !state.canRequestRefund) return
    const reason = this.data.refundReason.trim()
    if (!reason) {
      wx.showToast({ title: '请填写退出退款原因', icon: 'none' })
      return
    }
    wx.showModal({
      title: '申请退出并退还保证金',
      content: '自愿退出全额退还保证金，存在有效管理员没收决定的部分除外。物资报销是独立的平台出资商家转账，不属于保证金退款。是否提交？',
      success: async (res) => {
        if (!res.confirm || this.data.depositBusy) return
        this.setData({ depositBusy: true })
        wx.showLoading({ title: '提交申请...', mask: true })
        try {
          await callFunction('staff', 'requestDepositRefund', { reason })
          wx.showToast({ title: '已提交，以服务端状态为准', icon: 'none' })
        } catch (error) {
          showError(error)
        } finally {
          wx.hideLoading()
          await this.loadDeposit()
          this.load()
          this.setData({ depositBusy: false })
        }
      }
    })
  },

  goReimbursement() {
    wx.navigateTo({ url: '/pages/staff/supplies/reimbursement/index' })
  },

  load() {
    this.setData({ loading: true })
    callFunction('staff', 'getTrainingStatus')
      .then((res) => {
        const profile = withStaffWorkflowText(res.profile)
        const videos = (res.videos || []).map((item) => ({ ...item, watchedAtText: formatDateTime(item.watchedAt), tempUrl: '', posterTempUrl: '' }))
        this.setData({
          profile,
          quiz: res.quiz,
          videos,
          steps: buildSteps(profile, videos),
          videoAuditGuide: res.videoAuditGuide,
          canRequestVideoAudit: res.canRequestVideoAudit,
          loading: false
        }, () => this.resolveVideoUrls(videos))
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  copyAuditWechat() {
    const wechatId = this.data.videoAuditGuide && this.data.videoAuditGuide.wechatId
    if (!wechatId) return
    wx.setClipboardData({
      data: wechatId,
      success: () => {
        wx.showToast({ title: '审核微信号已复制', icon: 'success' })
      }
    })
  },

  selectAnswer(e) {
    const { questionId, value } = e.currentTarget.dataset
    this.setData({ [`answers.${questionId}`]: value })
  },

  submitQuiz() {
    const questions = (this.data.quiz && this.data.quiz.questions) || []
    const missing = questions.some((item) => !this.data.answers[item.id])
    if (missing) {
      wx.showToast({ title: '请完成全部题目', icon: 'none' })
      return
    }
    callFunction('staff', 'submitTrainingQuiz', { answers: this.data.answers })
      .then((res) => {
        wx.showToast({ title: res.passed ? '答题通过' : `得分${res.score}，请重试`, icon: 'none' })
        this.load()
      })
      .catch(showError)
  },

  resolveVideoUrls(videos = []) {
    const fileIds = []
    videos.forEach((item) => {
      if (item.fileId) fileIds.push(item.fileId)
      if (item.posterFileId) fileIds.push(item.posterFileId)
    })
    const uniqueIds = Array.from(new Set(fileIds))
    if (!uniqueIds.length) return
    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        const urlMap = {}
        ;(res.fileList || []).forEach((file) => {
          if (file.fileID && file.tempFileURL) urlMap[file.fileID] = file.tempFileURL
        })
        const updated = this.data.videos.map((item) => ({
          ...item,
          tempUrl: urlMap[item.fileId] || item.tempUrl || '',
          posterTempUrl: urlMap[item.posterFileId] || item.posterTempUrl || ''
        }))
        this.setData({ videos: updated })
      }
    })
  },

  markVideo(e) {
    const videoKey = e.currentTarget.dataset.key
    this.markVideoWatched(videoKey)
  },

  videoEnded(e) {
    const videoKey = e.currentTarget.dataset.key
    this.markVideoWatched(videoKey)
  },

  markVideoWatched(videoKey) {
    const target = this.data.videos.find((item) => item.key === videoKey)
    if (!videoKey || (target && target.watched)) return
    callFunction('staff', 'markTrainingVideoWatched', { videoKey })
      .then(() => {
        wx.showToast({ title: '已记录观看', icon: 'none' })
        this.load()
      })
      .catch(showError)
  },

  requestVideoAudit() {
    callFunction('staff', 'submitVideoAuditRequest')
      .then(() => {
        wx.showToast({ title: '已提交审核申请', icon: 'none' })
        this.load()
      })
      .catch(showError)
  },

  goPromotion() {
    wx.navigateTo({ url: '/pages/staff/promotion/index' })
  }
})
