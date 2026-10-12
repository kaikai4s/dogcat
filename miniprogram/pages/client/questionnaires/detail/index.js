const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')

const RATING_DESC = {
  1: '非常不满意',
  2: '不满意',
  3: '一般',
  4: '满意',
  5: '非常满意'
}

function initialAnswers(questions) {
  return (questions || []).map(q => ({
    questionId: q.id,
    type: q.type,
    value: q.type === 'multiple' ? [] : ''
  }))
}

Page({
  data: {
    id: '',
    detail: null,
    answers: [],
    submitting: false,
    answeredCount: 0,
    progressPercent: 0,
    errorQuestionIndex: -1,
    ratingDescMap: RATING_DESC
  },

  onLoad(query) {
    this.setData({ id: query.id || '' })
    ensureLogin({ content: '登录后可填写问卷。' }).then(() => this.load()).catch(() => {})
  },

  load() {
    wx.showLoading({ title: '加载问卷中...' })
    callFunction('questionnaire', 'detail', { id: this.data.id, role: 'client' })
      .then(detail => {
        const questions = (detail.questions || []).map(q => ({
          ...q,
          scores: Array.from({ length: Number(q.max || 5) }, (_, index) => index + 1)
        }))
        const answers = initialAnswers(questions)
        this.setData({
          detail: { ...detail, questions },
          answers
        }, () => this.updateProgress())
      })
      .catch(showError)
      .finally(() => wx.hideLoading())
  },

  updateProgress() {
    const { detail, answers } = this.data
    const questions = (detail && detail.questions) || []
    let answered = 0
    questions.forEach((q, idx) => {
      const a = answers[idx]
      if (!a) return
      if (q.type === 'multiple') {
        if (Array.isArray(a.value) && a.value.length > 0) answered++
      } else if (q.type === 'rating') {
        if (Number(a.value) > 0) answered++
      } else {
        if (a.value && String(a.value).trim()) answered++
      }
    })
    const progressPercent = questions.length ? Math.round((answered / questions.length) * 100) : 0
    this.setData({ answeredCount: answered, progressPercent })
  },

  // 单选
  selectSingle(e) {
    if (this.data.detail && this.data.detail.answered) return
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const option = e.currentTarget.dataset.option
    this.setData({
      [`answers[${qIndex}].value`]: option,
      errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
    }, () => this.updateProgress())
  },

  // 多选
  toggleMultiple(e) {
    if (this.data.detail && this.data.detail.answered) return
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const option = e.currentTarget.dataset.option
    const currentList = this.data.answers[qIndex].value || []
    let newList = []
    if (currentList.includes(option)) {
      newList = currentList.filter(item => item !== option)
    } else {
      newList = currentList.concat(option)
    }
    this.setData({
      [`answers[${qIndex}].value`]: newList,
      errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
    }, () => this.updateProgress())
  },

  // 评分
  setRating(e) {
    if (this.data.detail && this.data.detail.answered) return
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const score = Number(e.currentTarget.dataset.score)
    this.setData({
      [`answers[${qIndex}].value`]: score,
      errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
    }, () => this.updateProgress())
  },

  // 文本输入
  onTextInput(e) {
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const value = e.detail.value
    this.setData({
      [`answers[${qIndex}].value`]: value,
      errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
    }, () => this.updateProgress())
  },

  validateAnswers() {
    const questions = (this.data.detail && this.data.detail.questions) || []
    const answers = this.data.answers || []
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const a = answers[i]
      if (q.required) {
        let isMissing = false
        if (q.type === 'multiple') {
          if (!Array.isArray(a.value) || !a.value.length) isMissing = true
        } else if (q.type === 'rating') {
          if (!a.value || Number(a.value) <= 0) isMissing = true
        } else {
          if (!a.value || !String(a.value).trim()) isMissing = true
        }

        if (isMissing) {
          this.setData({ errorQuestionIndex: i })
          wx.showToast({ title: `请完成第 ${i + 1} 题（必填项）`, icon: 'none' })
          wx.pageScrollTo({ selector: `#question-${i}`, duration: 300 })
          return false
        }
      }
    }
    return true
  },

  submit() {
    if (this.data.submitting || (this.data.detail && this.data.detail.answered)) return
    if (!this.validateAnswers()) return
    this.setData({ submitting: true })
    callFunction('questionnaire', 'submit', { id: this.data.id, role: 'client', answers: this.data.answers })
      .then(() => {
        wx.showModal({
          title: '🎉 感谢您的反馈！',
          content: '问卷已成功提交，奖励邮件已发放至您的奖励邮箱，立即前往领取吧～',
          confirmText: '去领奖励',
          cancelText: '完成'
        }).then(res => {
          if (res.confirm) {
            wx.redirectTo({ url: '/pages/client/reward-mails/index' })
          } else {
            wx.navigateBack()
          }
        })
      })
      .catch(showError)
      .finally(() => this.setData({ submitting: false }))
  },

  goToRewardMails() {
    wx.navigateTo({ url: '/pages/client/reward-mails/index' })
  },

  goBack() {
    wx.navigateBack()
  }
})
