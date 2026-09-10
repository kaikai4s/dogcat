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
    loading: false
  },

  onShow() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
    this.load()
  },

  load() {
    this.setData({ loading: true })
    callFunction('staff', 'getTrainingStatus')
      .then((res) => {
        const profile = withStaffWorkflowText(res.profile)
        const videos = (res.videos || []).map((item) => ({ ...item, watchedAtText: formatDateTime(item.watchedAt) }))
        this.setData({
          profile,
          quiz: res.quiz,
          videos,
          steps: buildSteps(profile, videos),
          videoAuditGuide: res.videoAuditGuide,
          canRequestVideoAudit: res.canRequestVideoAudit,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
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

  markVideo(e) {
    const videoKey = e.currentTarget.dataset.key
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
