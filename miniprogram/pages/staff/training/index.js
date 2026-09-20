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
    refundReason: '',
    supplyItems: [
      { name: '一次性手套', description: '足量自备', purchaseUrl: '' },
      { name: '一次性口罩', description: '规范防护', purchaseUrl: '' },
      { name: '一次性鞋套', description: '进门即穿戴', purchaseUrl: '' },
      { name: '安全宠物消毒用品', description: '正规安全无毒', purchaseUrl: '' }
    ],
    copyModal: {
      show: false,
      title: '',
      tip: '',
      content: '',
      btnText: '一键复制'
    }
  },

  onShow() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
    this.load()
    if (!this.data.depositBusy) this.loadDeposit()
  },

  onHide() {
    this.pauseAllVideos()
  },

  onUnload() {
    this.pauseAllVideos()
  },

  pauseAllVideos() {
    (this.data.videos || []).forEach((item) => {
      try {
        const videoCtx = wx.createVideoContext(`video-${item.key}`, this)
        videoCtx.pause()
      } catch (_) {}
    })
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
        if (!this._videoTracking) this._videoTracking = {}
        const videos = (res.videos || []).map((item) => {
          if (item.watched) {
            this._videoTracking[item.key] = {
              maxTime: item.duration || 999999,
              completed: true,
              lastToast: 0,
              seeking: false
            }
          }
          return {
            ...item,
            watchedAtText: formatDateTime(item.watchedAt),
            progressPercent: item.watched ? 100 : 0,
            tempUrl: '',
            posterTempUrl: ''
          }
        })
        const supplies = res.supplies || {}
        const supplyItems = Array.isArray(supplies.items) && supplies.items.length
          ? supplies.items.filter((i) => i.enabled !== false)
          : this.data.supplyItems
        this.setData({
          profile,
          quiz: res.quiz,
          videos,
          steps: buildSteps(profile, videos),
          videoAuditGuide: res.videoAuditGuide,
          canRequestVideoAudit: res.canRequestVideoAudit,
          supplyItems,
          loading: false
        }, () => this.resolveVideoUrls(videos))
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  openPurchaseUrl(e) {
    const url = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.url) || ''
    const name = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.name) || '物品'
    if (!url) {
      wx.showToast({ title: '暂未配置购买链接', icon: 'none' })
      return
    }
    if (url.startsWith('/')) {
      wx.navigateTo({ url })
      return
    }
    // 同步手势中先执行剪贴板复制尝试
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({ title: '已尝试自动复制', icon: 'none' })
      },
      fail: () => {}
    })
    // 弹出自定义支持长按选择复制与一键复制的交互弹窗
    this.setData({
      copyModal: {
        show: true,
        title: `${name} 购买链接`,
        tip: '链接可用于在微信对话框或手机浏览器中打开完成购买：',
        content: url,
        btnText: '复制购买链接'
      }
    })
  },

  copyAuditWechat(e) {
    const wechatId = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.wechat)
      || (this.data.videoAuditGuide && this.data.videoAuditGuide.wechatId)
      || ''
    if (!wechatId || wechatId === '未配置') {
      wx.showToast({ title: '管理员暂未配置审核微信号', icon: 'none' })
      return
    }
    const remark = (this.data.videoAuditGuide && this.data.videoAuditGuide.remarkTemplate) || '宠托师审核'
    // 同步手势中先执行剪贴板复制尝试
    wx.setClipboardData({
      data: wechatId,
      success: () => {
        wx.showToast({ title: '已尝试自动复制', icon: 'none' })
      },
      fail: () => {}
    })
    // 弹出自定义支持长按选择复制与一键复制的交互弹窗
    this.setData({
      copyModal: {
        show: true,
        title: '平台视频审核微信号',
        tip: `请添加管理员微信好友进行线上考核，添加时请备注：${remark}`,
        content: wechatId,
        btnText: '复制微信号'
      }
    })
  },

  executeCopyModal() {
    const content = this.data.copyModal && this.data.copyModal.content
    if (!content) return
    wx.setClipboardData({
      data: content,
      success: () => {
        wx.showToast({ title: '复制成功', icon: 'success' })
      }
    })
  },

  closeCopyModal() {
    this.setData({ 'copyModal.show': false })
  },

  noop() {},

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

  onVideoSeeking(e) {
    const key = e.currentTarget.dataset.key
    if (!this._videoTracking) this._videoTracking = {}
    if (!this._videoTracking[key]) this._videoTracking[key] = { maxTime: 0, lastToast: 0 }
    this._videoTracking[key].seeking = true
  },

  onVideoSeekComplete(e) {
    const key = e.currentTarget.dataset.key
    if (this._videoTracking && this._videoTracking[key]) {
      this._videoTracking[key].seeking = false
    }
  },

  onVideoTimeUpdate(e) {
    const key = e.currentTarget.dataset.key
    const currentTime = Number(e.detail.currentTime || 0)
    const duration = Number(e.detail.duration || 0)
    if (!key || duration <= 0) return

    if (!this._videoTracking) this._videoTracking = {}
    if (!this._videoTracking[key]) {
      this._videoTracking[key] = { maxTime: 0, lastToast: 0, seeking: false, completed: false, duration }
    }
    const track = this._videoTracking[key]
    track.duration = duration
    if (track.completed) return

    const target = this.data.videos.find((v) => v.key === key)
    if (target && target.watched) {
      track.completed = true
      return
    }

    // 防快进拦截：若当前点跳跃超过已观看到的历史最大点 2.5 秒，判定为快进
    if (currentTime > track.maxTime + 2.5) {
      const videoCtx = wx.createVideoContext(`video-${key}`, this)
      videoCtx.seek(track.maxTime)
      const nowMs = Date.now()
      if (nowMs - (track.lastToast || 0) > 3000) {
        track.lastToast = nowMs
        wx.showToast({
          title: '培训视频须全程看完，不可快进',
          icon: 'none',
          duration: 2500
        })
      }
      return
    }

    // 连续正常播放，推进历史最大观看时间
    if (currentTime > track.maxTime) {
      track.maxTime = currentTime
      const percent = Math.min(100, Math.round((track.maxTime / duration) * 100))
      if (target && target.progressPercent !== percent && (percent % 5 === 0 || percent >= 98)) {
        const updatedVideos = this.data.videos.map((item) => {
          if (item.key === key) {
            return { ...item, progressPercent: percent }
          }
          return item
        })
        this.setData({ videos: updatedVideos })
      }
    }

    // 达到尾部（还剩不到 1.5 秒且已看 90% 以上）
    if (currentTime >= duration - 1.5 && track.maxTime >= duration * 0.9) {
      this.handleVideoFinish(key, Math.max(track.maxTime, duration), duration)
    }
  },

  onVideoEnded(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const target = this.data.videos.find((v) => v.key === key)
    // 已经标记为已完成的视频，重播结束属于正常温习，直接放行不弹任何报错
    if (target && target.watched) return

    const track = (this._videoTracking && this._videoTracking[key]) || { maxTime: 0, duration: 0 }
    const duration = track.duration || 0
    if (duration > 0 && track.maxTime < duration * 0.9) {
      wx.showToast({
        title: '未完整看完视频，请从头完整观看',
        icon: 'none'
      })
      const videoCtx = wx.createVideoContext(`video-${key}`, this)
      videoCtx.seek(track.maxTime)
      return
    }
    this.handleVideoFinish(key, Math.max(track.maxTime, duration), duration)
  },

  handleVideoFinish(key, watchedSeconds, duration) {
    if (!this._videoTracking) this._videoTracking = {}
    if (!this._videoTracking[key]) this._videoTracking[key] = {}
    if (this._videoTracking[key].completed) return

    const target = this.data.videos.find((item) => item.key === key)
    if (!key || (target && target.watched)) {
      this._videoTracking[key].completed = true
      return
    }

    this._videoTracking[key].completed = true
    wx.showLoading({ title: '记录学习进度...' })
    callFunction('staff', 'markTrainingVideoWatched', {
      videoKey: key,
      watchedSeconds: Math.round(Math.max(watchedSeconds || 0, duration ? duration * 0.95 : 0)),
      duration: Math.round(duration || 0)
    })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已全程看完该视频', icon: 'success' })
        this.load()
      })
      .catch((err) => {
        wx.hideLoading()
        this._videoTracking[key].completed = false
        showError(err)
      })
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
