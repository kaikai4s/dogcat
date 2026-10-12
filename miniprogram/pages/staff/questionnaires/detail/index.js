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
    value: q.type === 'multiple' ? [] : '',
    otherText: ''
  }))
}

function isOtherOption(opt) {
  if (!opt) return false
  const s = String(opt).trim()
  return s === '其他' || s === '其它' || s.startsWith('其他') || s.startsWith('其它')
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
    callFunction('questionnaire', 'detail', { id: this.data.id, role: 'staff' })
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

  noop() {},

  // 单选
  selectSingle(e) {
    if (this.data.detail && this.data.detail.answered) return
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const option = e.currentTarget.dataset.option
    const prevAnswer = this.data.answers[qIndex] || {}
    const isOther = isOtherOption(option)

    let nextValue = option
    const otherText = prevAnswer.otherText || ''
    if (isOther && otherText) {
      nextValue = `${option}:${otherText}`
    }

    this.setData({
      [`answers[${qIndex}].value`]: nextValue,
      errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
    }, () => this.updateProgress())
  },

  // 多选
  toggleMultiple(e) {
    if (this.data.detail && this.data.detail.answered) return
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const option = e.currentTarget.dataset.option
    const currentList = this.data.answers[qIndex].value || []
    const isOther = isOtherOption(option)
    const isAlreadySelected = currentList.some(item => item === option || item.startsWith(`${option}:`))

    let newList = []
    if (isAlreadySelected) {
      newList = currentList.filter(item => item !== option && !item.startsWith(`${option}:`))
    } else {
      const otherText = this.data.answers[qIndex].otherText || ''
      const valToAdd = (isOther && otherText) ? `${option}:${otherText}` : option
      newList = currentList.concat(valToAdd)
    }

    this.setData({
      [`answers[${qIndex}].value`]: newList,
      errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
    }, () => this.updateProgress())
  },

  // “其他”输入框输入事件
  onOtherInput(e) {
    const qIndex = Number(e.currentTarget.dataset.qindex)
    const opt = e.currentTarget.dataset.option || '其他'
    const otherText = (e.detail.value || '').trim()
    const q = this.data.detail.questions[qIndex]
    const fullValue = otherText ? `${opt}:${otherText}` : opt

    if (q.type === 'single') {
      this.setData({
        [`answers[${qIndex}].value`]: fullValue,
        [`answers[${qIndex}].otherText`]: e.detail.value || '',
        errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
      }, () => this.updateProgress())
    } else if (q.type === 'multiple') {
      const currentList = this.data.answers[qIndex].value || []
      const filtered = currentList.filter(item => item !== opt && !item.startsWith(`${opt}:`))
      filtered.push(fullValue)
      this.setData({
        [`answers[${qIndex}].value`]: filtered,
        [`answers[${qIndex}].otherText`]: e.detail.value || '',
        errorQuestionIndex: this.data.errorQuestionIndex === qIndex ? -1 : this.data.errorQuestionIndex
      }, () => this.updateProgress())
    }
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

      // 无论是否必填，只要选了“其他”，必须填写具体内容
      if (q.type === 'single') {
        const val = String(a.value || '')
        const isOther = isOtherOption(val) || (q.options || []).some(opt => isOtherOption(opt) && (val === opt || val.startsWith(opt + ':')))
        if (isOther) {
          const colonIdx = val.indexOf(':')
          const textAfterColon = colonIdx >= 0 ? val.slice(colonIdx + 1).trim() : (a.otherText || '').trim()
          if (!textAfterColon) {
            this.setData({ errorQuestionIndex: i })
            wx.showToast({ title: `请在第 ${i + 1} 题补充【其他】的具体内容`, icon: 'none' })
            wx.pageScrollTo({ selector: `#question-${i}`, duration: 300 })
            return false
          }
        }
      } else if (q.type === 'multiple') {
        const list = Array.isArray(a.value) ? a.value : []
        const otherItem = list.find(item => isOtherOption(item))
        if (otherItem) {
          const colonIdx = otherItem.indexOf(':')
          const textAfterColon = colonIdx >= 0 ? otherItem.slice(colonIdx + 1).trim() : (a.otherText || '').trim()
          if (!textAfterColon) {
            this.setData({ errorQuestionIndex: i })
            wx.showToast({ title: `请在第 ${i + 1} 题补充【其他】的具体内容`, icon: 'none' })
            wx.pageScrollTo({ selector: `#question-${i}`, duration: 300 })
            return false
          }
        }
      }
    }
    return true
  },

  submit() {
    if (this.data.submitting || (this.data.detail && this.data.detail.answered)) return
    if (!this.validateAnswers()) return
    this.setData({ submitting: true })
    const answersToSubmit = (this.data.answers || []).map(a => ({
      questionId: a.questionId,
      type: a.type,
      value: a.value
    }))
    callFunction('questionnaire', 'submit', { id: this.data.id, role: 'staff', answers: answersToSubmit })
      .then(() => {
        wx.showModal({
          title: '🎉 问卷提交成功！',
          content: '非常感谢宠托师伙伴的真诚反馈！调研奖励邮件已发至奖励邮箱，去查收吧～',
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
