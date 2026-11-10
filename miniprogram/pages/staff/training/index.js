const { callFunction, showError, requirePrivacyAuthorize } = require('../../../utils/cloud')
const { withStaffWorkflowText, formatDateTime } = require('../../../utils/format')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { copyText } = require('../../../utils/clipboard')

const positiveDuration = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0
const videoPassPercent = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 100 ? Number(value) : 80

const depositStatusText = {
  unpaid: '待缴纳',
  paid: '已缴纳',
  partially_refunded: '部分退款',
  refund_requested: '退款审核中',
  refund_approved: '审核通过，待发起退款',
  refunding: '微信原路退款处理中',
  refunded: '已退款',
  forfeited: '已没收'
}

const depositRefundStatusText = {
  requested: '退款申请中',
  processing: '退款处理中',
  approved: '退款已同意',
  rejected: '退款已驳回',
  refunded: '已退款',
  success: '已退款',
  failed: '退款失败'
}

function normalizeDeposit(deposit) {
  if (!deposit) return null
  const status = String(deposit.status || '').toLowerCase()
  const refundStatus = String(deposit.refundStatus || '').toLowerCase()
  const acceptanceUnconfirmed = refundStatus === 'processing' && deposit.refundNo && !deposit.wechatRefundId
  return {
    ...deposit,
    statusText: acceptanceUnconfirmed ? '退款受理待核实' : depositStatusText[status] || deposit.statusText || (status ? '已记录' : ''),
    refundStatusText: acceptanceUnconfirmed ? '微信受理待核实' : depositRefundStatusText[refundStatus] || (refundStatus ? '退款处理中' : '')
  }
}

function supplyAddressIssues(address = {}) {
  const errors = {}
  if (!address.name || address.name.length > 40) errors.name = '请填写收件人姓名，最多40字'
  if (!/^1[3-9]\d{9}$/.test(address.phone || '')) errors.phone = '请填写有效的11位收件手机号'
  if (![address.province, address.city, address.district].every(value => value && value.length <= 100)) errors.region = '请选择完整的省、市、区县'
  if (!address.detail || address.detail.length > 100) errors.detail = '请填写街道、楼栋及门牌号，最多100字'
  return errors
}

function buildSteps(profile = {}, videos = []) {
  return [
    { title: '资料审核', desc: profile.auditStatus === 'approved' ? '已通过' : '待通过', done: profile.auditStatus === 'approved' },
    { title: '培训视频', desc: videos.every((item) => item.watched) ? '已完成' : '待观看', done: videos.every((item) => item.watched) },
    { title: '培训答题', desc: profile.quizPassedAt ? '已通过' : '待完成', done: Boolean(profile.quizPassedAt) },
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
    quizExpanded: false,
    quizBusy: false,
    watchedVideoCount: 0,
    videoPassPercent: 80,
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
    supplyAgreed: false,
    depositModal: '',
    depositIntent: 'payment',
    depositDetailsExpanded: false,
    checkoutError: '',
    checkoutNeedsRefresh: false,
    choosingSupplyAddress: false,
    supplyAddressErrors: {},
    supplyAddressFocus: '',
    supplyRegion: [],
    supplyAddress: { name: '', phone: '', province: '', city: '', district: '', detail: '' },
    supplyLogistics: null,
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
    this._unloaded = false
    this._trainingHidden = false
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
    this.load()
    if (!this.data.depositBusy && !this.data.depositModal) this.loadDeposit()
  },

  onHide() {
    this._trainingHidden = true
    this.pauseAllVideos()
  },

  onUnload() {
    this._unloaded = true
    this._depositLoadVersion = (this._depositLoadVersion || 0) + 1
    this._trainingLoadVersion = (this._trainingLoadVersion || 0) + 1
    this.pauseAllVideos()
  },

  pauseAllVideos() {
    (this.data.videos || []).forEach((item) => {
      const track = this._videoTracking && this._videoTracking[item.key]
      if (track) {
        this.clearVideoSyncRetry(track)
        this.stopVideoPlayback(track)
      }
      try {
        const videoCtx = wx.createVideoContext(`video-${item.key}`, this)
        videoCtx.pause()
      } catch (_) {}
    })
  },

  async loadDeposit(options = {}) {
    if (this._unloaded) return null
    const preserveCheckout = options.preserveCheckout === true && Boolean(this.data.depositModal)
    const previousKey = this.data.depositState?.checkoutPolicyKey
    const version = this._depositLoadVersion = (this._depositLoadVersion || 0) + 1
    this.setData({ depositLoading: true, depositError: false,
      ...(!preserveCheckout ? { depositAgreed: false, supplyAgreed: false, depositModal: '' } : {}) })
    try {
      const depositState = await callFunction('staff', 'getDepositStatus')
      if (depositState && depositState.deposit) {
        depositState.deposit = normalizeDeposit(depositState.deposit)
      }
      if (version !== this._depositLoadVersion || this._unloaded) return null
      const supplyAddress = this._supplyAddressDraftEdited ? this.data.supplyAddress : depositState?.deposit?.supplyAddress || this.data.supplyAddress
      const patch = { depositState, supplyAddress, supplyRegion: [supplyAddress.province, supplyAddress.city, supplyAddress.district], checkoutNeedsRefresh: false }
      if (preserveCheckout && this.data.depositModal) {
        const canContinue = this.data.depositIntent === 'payment' ? depositState?.canPay
          : depositState?.supplyDeliveryRequired && ['paid', 'partially_refunded'].includes(depositState.deposit?.status)
        if (!canContinue) patch.depositModal = ''
        else if (previousKey && depositState.checkoutPolicyKey && previousKey !== depositState.checkoutPolicyKey) {
          Object.assign(patch, { depositModal: 'rules', depositAgreed: false, supplyAgreed: false, checkoutError: '规则已更新，请重新阅读并确认后继续' })
        }
      }
      this.setData(patch)
      return depositState
    } catch (error) {
      if (version !== this._depositLoadVersion || this._unloaded) return null
      this.setData({ depositError: true, ...(preserveCheckout
        ? { checkoutNeedsRefresh: true, checkoutError: '暂未核实支付状态，请刷新状态后再试，地址已保留。' }
        : { depositState: null }) })
      if (!preserveCheckout) showError(error)
    } finally {
      if (version === this._depositLoadVersion && !this._unloaded) this.setData({ depositLoading: false })
    }
  },

  agreeDeposit(e) {
    this.setData({ depositAgreed: e.detail.value.includes('agreed') })
  },
  agreeSupply(e) {
    this.setData({ supplyAgreed: e.detail.value.includes('agreed') })
  },
  supplyAddressInput(e) {
    const field = e.currentTarget.dataset.field
    if (!['name', 'phone', 'province', 'city', 'district', 'detail'].includes(field) || this.data.depositBusy) return
    this._supplyAddressDraftEdited = true
    const nextAddress = { ...(this.data.supplyAddress || {}), [field]: e.detail.value }
    const patch = { supplyAddress: nextAddress }
    if (this.data.supplyAddressErrors && this.data.supplyAddressErrors[field]) {
      const errors = { ...this.data.supplyAddressErrors }
      delete errors[field]
      patch.supplyAddressErrors = errors
    }
    if (this.data.supplyAddressFocus) {
      patch.supplyAddressFocus = ''
    }
    this.setData(patch)
  },
  supplyRegionChange(e) {
    if (this.data.depositBusy) return
    const region = e.detail.value || []
    if (region.length !== 3) return
    this._supplyAddressDraftEdited = true
    const errors = { ...this.data.supplyAddressErrors }
    delete errors.region
    this.setData({ supplyRegion: region, supplyAddress: { ...this.data.supplyAddress, province: region[0], city: region[1], district: region[2] }, supplyAddressErrors: errors })
  },
  async chooseSupplyAddress() {
    if (this.data.choosingSupplyAddress || this.data.depositBusy || this.data.depositModal !== 'address') return
    this.setData({ choosingSupplyAddress: true })
    try {
      await requirePrivacyAuthorize()
      if (this._unloaded) return
      const address = await new Promise((resolve, reject) => wx.chooseAddress({ success: resolve, fail: reject }))
      if (this._unloaded) return
      this._supplyAddressDraftEdited = true
      this.setData({ supplyAddress: {
        name: address.userName || '', phone: address.telNumber || '', province: address.provinceName || '',
        city: address.cityName || '', district: address.countyName || '', detail: address.detailInfo || ''
      }, supplyRegion: [address.provinceName || '', address.cityName || '', address.countyName || ''], supplyAddressErrors: {} })
    } catch (error) {
      if (!this._unloaded && !String(error?.errMsg || error?.message || '').includes('cancel')) showError(error)
    } finally { if (!this._unloaded) this.setData({ choosingSupplyAddress: false }) }
  },
  async confirmSupplyDelivery() {
    if (this.data.depositBusy || this.data.depositLoading || this.data.choosingSupplyAddress || this.data.checkoutNeedsRefresh || this.data.depositModal !== 'address' ||
        this.data.depositIntent !== 'delivery' || !this.data.depositAgreed || !this.data.supplyAgreed || !this.validateSupplyAddress()) return
    this.setData({ depositBusy: true, checkoutError: '' })
    try {
      await callFunction('staff', 'confirmSupplyDelivery', { acceptSupplyPolicy: true, supplyAddress: this.data.supplyAddress, checkoutPolicyKey: this.data.depositState?.checkoutPolicyKey })
      if (this._unloaded) return
      wx.showToast({ title: '已确认，等待发货', icon: 'none' })
      await this.loadDeposit()
    } catch (error) {
      if (!this._unloaded) this.setData({ checkoutError: error.message || '地址提交失败，请稍后重试', checkoutNeedsRefresh: String(error.message || '').includes('规则已更新') })
    } finally { if (!this._unloaded) this.setData({ depositBusy: false }) }
  },
  async querySupplyLogistics() {
    const depositId = this.data.depositState?.profile?.supplyShipmentDepositId || this.data.depositState?.deposit?._id
    if (!depositId || this.data.depositBusy) return
    this.setData({ depositBusy: true })
    try {
      const result = await callFunction('staff', 'querySupplyDeliveryLogistics', { depositId })
      if (this._unloaded) return
      this.setData({ supplyLogistics: result })
    } catch (error) { if (!this._unloaded) showError(error) } finally { if (!this._unloaded) this.setData({ depositBusy: false }) }
  },
  copySupplyTracking() {
    copyText(this.data.depositState?.firstSupplyShipment?.trackingNo || '')
  },

  inputRefundReason(e) {
    this.setData({ refundReason: e.detail.value })
  },

  async payDeposit() {
    const state = this.data.depositState
    if (this.data.depositBusy || this.data.depositLoading || this.data.depositError || !state || !state.canPay) {
      if (state && !state.canPay) {
        wx.showToast({ title: '当前状态无需缴纳或暂不可缴', icon: 'none' })
      }
      return
    }
    this.setData({ depositModal: 'rules', depositIntent: 'payment', depositAgreed: false, supplyAgreed: false, checkoutError: '', checkoutNeedsRefresh: false, supplyAddressErrors: {} })
  },

  openSupplyDelivery() {
    if (this.data.depositBusy || this.data.depositLoading) return
    this.setData({ depositModal: 'rules', depositIntent: 'delivery', depositAgreed: false, supplyAgreed: false, checkoutError: '', checkoutNeedsRefresh: false, supplyAddressErrors: {} })
  },

  closeDepositModal() {
    if (this.data.depositBusy || this.data.choosingSupplyAddress) return
    this.setData({ depositModal: '', depositAgreed: false, supplyAgreed: false })
  },

  backToDepositRules() {
    if (!this.data.depositBusy && !this.data.choosingSupplyAddress) this.setData({ depositModal: 'rules', checkoutError: '' })
  },

  async reloadDepositCheckout() {
    if (this.data.depositBusy || this.data.depositLoading || this.data.choosingSupplyAddress) return
    const intent = this.data.depositIntent
    const state = await this.loadDeposit({ preserveCheckout: true })
    if (!state || this._unloaded) return
    if (this.data.depositModal) this.setData({ depositModal: 'rules', depositIntent: intent, depositAgreed: false, supplyAgreed: false, checkoutError: '' })
  },

  toggleDepositDetails() {
    this.setData({ depositDetailsExpanded: !this.data.depositDetailsExpanded })
  },

  async continueDepositRules() {
    const state = this.data.depositState
    if (this.data.depositBusy || this.data.depositLoading || this.data.checkoutNeedsRefresh || !state || this.data.depositModal !== 'rules') return
    if (!this.data.depositAgreed || ((state.supplyDeliveryRequired || this.data.depositIntent === 'delivery') && !this.data.supplyAgreed)) {
      wx.showToast({ title: '请阅读并勾选规则', icon: 'none' })
      return
    }
    if (state.supplyDeliveryRequired || this.data.depositIntent === 'delivery') {
      this.setData({ depositModal: 'address' })
      return
    }
    await this.submitDepositPayment()
  },

  validateSupplyAddress() {
    const address = this.data.supplyAddress || {}
    const normalized = {}
    for (const key of ['name', 'phone', 'province', 'city', 'district', 'detail']) normalized[key] = String(address[key] || '').trim()
    const errors = supplyAddressIssues(normalized)
    this.setData({ supplyAddressErrors: errors })
    if (Object.keys(errors).length) {
      const field = Object.keys(errors)[0]
      this.setData({ supplyAddressFocus: field })
      wx.showToast({ title: errors[field], icon: 'none' })
      return false
    }
    this.setData({ supplyAddress: normalized })
    return true
  },

  async confirmAddressAndPay() {
    if (this.data.depositModal !== 'address') return
    if (this.data.depositIntent === 'delivery') return this.confirmSupplyDelivery()
    return this.submitDepositPayment()
  },

  async submitDepositPayment() {
    const state = this.data.depositState
    if (this.data.depositBusy || this.data.depositLoading || this.data.choosingSupplyAddress || this.data.checkoutNeedsRefresh || !state?.canPay || this.data.depositIntent !== 'payment') return
    if (!this.data.depositAgreed || !['rules', 'address'].includes(this.data.depositModal)) {
      wx.showToast({ title: '请先阅读并勾选保证金缴纳规则', icon: 'none' })
      return
    }
    if (state.supplyDeliveryRequired && (!this.data.supplyAgreed || this.data.depositModal !== 'address')) {
      wx.showToast({ title: '请确认首次用品规则及地址', icon: 'none' })
      return
    }
    if (state.supplyDeliveryRequired && !this.validateSupplyAddress()) return
    this.setData({ depositBusy: true, checkoutError: '' })
    let paymentSubmitted = false
    wx.showLoading({ title: '创建支付...', mask: true })
    try {
      const result = await callFunction('staff', 'createDepositPayment', { agreed: true,
        acceptSupplyPolicy: state.supplyDeliveryRequired === true, supplyAddress: this.data.supplyAddress, checkoutPolicyKey: state.checkoutPolicyKey })
      wx.hideLoading()
      if (this._unloaded) return
      if (result.paid) {
        paymentSubmitted = true
      } else {
        if (!result.payParams) throw new Error('支付暂不可用，请稍后重试或联系平台')
        await new Promise((resolve, reject) => wx.requestPayment({ ...result.payParams, success: resolve, fail: reject }))
        paymentSubmitted = true
      }
      if (!result.paid) {
        wx.showLoading({ title: '核实支付结果...', mask: true })
      }
    } catch (error) {
      wx.hideLoading()
      const errMsg = (error && (error.message || error.errMsg)) || ''
      if (!this._unloaded) this.setData({ checkoutError: errMsg.includes('cancel') || errMsg.includes('canceled')
        ? '已取消支付，收货地址已保留，核对后可再次支付。' : errMsg || '发起支付失败，请稍后重试',
        checkoutNeedsRefresh: errMsg.includes('规则已更新') })
    } finally {
      wx.hideLoading()
      let confirmed = await this.loadDeposit({ preserveCheckout: !paymentSubmitted })
      for (let attempt = 0; paymentSubmitted && attempt < 2 && !this._unloaded && (!confirmed || confirmed.deposit?.status === 'unpaid'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1200))
        if (!this._unloaded) confirmed = await this.loadDeposit()
      }
      if (!this._unloaded) {
        if (paymentSubmitted) {
          wx.showToast({ title: confirmed?.deposit?.status === 'paid' ? '保证金已缴纳' : '结果确认中，请刷新状态，勿重复支付', icon: 'none' })
          if (confirmed?.deposit?.status === 'paid') {
            try { wx.removeStorageSync('staff_profile_display_cache_v1') } catch (_) {}
          }
        }
        this.load()
        this.setData({ depositBusy: false })
      }
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
      content: state.deposit?.supplyShipment && state.deposit?.supplyPolicyAcceptedAt
        ? `可退押金 ¥${state.deposit.availableRefundAmount}；预计用品费用 ¥${state.supplyFeeDue || 0}（减免申请待审时先不结算）。审核通过后按结算明细退款，是否提交？`
        : '未确认并收取首次用品，不扣用品费用；其他有效扣除按记录结算。是否提交？',
      success: async (res) => {
        if (!res.confirm || this._unloaded || this.data.depositBusy) return
        this.setData({ depositBusy: true })
        wx.showLoading({ title: '提交申请...', mask: true })
        try {
          await callFunction('staff', 'requestDepositRefund', { reason })
          if (this._unloaded) return
          try { wx.removeStorageSync('staff_profile_display_cache_v1') } catch (_) {}
          wx.showToast({ title: '已提交，以服务端状态为准', icon: 'none' })
        } catch (error) {
          if (!this._unloaded) showError(error)
        } finally {
          wx.hideLoading()
          await this.loadDeposit()
          if (!this._unloaded) {
            this.load()
            this.setData({ depositBusy: false })
          }
        }
      }
    })
  },

  goReimbursement() {
    wx.navigateTo({ url: '/pages/staff/supplies/reimbursement/index' })
  },

  load(options = {}) {
    if (this._unloaded) return Promise.resolve()
    const version = this._trainingLoadVersion = (this._trainingLoadVersion || 0) + 1
    this.setData({ loading: true })
    return callFunction('staff', 'getTrainingStatus')
      .then((res) => {
        if (this._unloaded || version !== this._trainingLoadVersion) return
        const profile = withStaffWorkflowText(res.profile)
        if (!this._videoTracking) this._videoTracking = {}
        const videos = (res.videos || []).map((item) => {
          const previous = this.data.videos.find(video => video.key === item.key && video.fileId === item.fileId)
          const track = this._videoTracking[item.key]
          if (track && track.fileId !== item.fileId) {
            this.clearVideoSyncRetry(track)
            delete this._videoTracking[item.key]
          } else if (track && item.watched) {
            track.completed = true
            this.clearVideoSyncRetry(track)
          }
          const duration = positiveDuration(item.duration)
          const progressPercent = duration > 0 ? Math.min(100, Math.floor(Number(item.watchedSeconds || 0) / duration * 100 + 0.000001)) : (item.watched ? 100 : 0)
          return {
            ...item,
            watchedAtText: formatDateTime(item.watchedAt),
            progressPercent: item.watched ? progressPercent : (previous && previous.progressPercent || 0),
            syncError: !item.watched && previous && previous.syncError || false,
            tempUrl: previous && previous.tempUrl || '',
            posterTempUrl: previous && previous.posterFileId === item.posterFileId && previous.posterTempUrl || ''
          }
        })
        const supplies = res.supplies || {}
        const supplyItems = Array.isArray(supplies.items) && supplies.items.length
          ? supplies.items.filter((i) => i.enabled !== false)
          : this.data.supplyItems
        this.setData({
          profile,
          quiz: res.quiz,
          answers: this.data.quiz && this.data.quiz.version === res.quiz?.version ? this.data.answers : {},
          quizExpanded: res.quiz && res.quiz.unlocked === true && this.data.quizExpanded,
          watchedVideoCount: videos.filter(item => item.watched).length,
          videoPassPercent: videoPassPercent(res.videoPassPercent),
          videos,
          steps: buildSteps(profile, videos),
          videoAuditGuide: res.videoAuditGuide,
          canRequestVideoAudit: res.canRequestVideoAudit,
          supplyItems,
          loading: false
        }, () => {
          this.resolveVideoUrls(videos, version, options.preserveVideoUrls === true)
          this.retryPendingVideoSyncs()
        })
      })
      .catch((err) => {
        if (this._unloaded || version !== this._trainingLoadVersion) return
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
    copyText(url, { successTitle: '已尝试自动复制' })
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
    copyText(wechatId, { successTitle: '已尝试自动复制', emptyTitle: '暂无审核微信号' })
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
    copyText(content, { successTitle: '复制成功', emptyTitle: '暂无可复制内容' })
  },

  closeCopyModal() {
    this.setData({ 'copyModal.show': false })
  },

  noop() {},

  toggleQuiz() {
    if (!this.data.quiz?.unlocked || this.data.quizBusy) return
    this.setData({ quizExpanded: !this.data.quizExpanded })
  },

  selectAnswer(e) {
    if (!this.data.quiz?.unlocked || this.data.quiz.passed || this.data.quizBusy) return
    const { questionId, value } = e.currentTarget.dataset
    this.setData({ [`answers.${questionId}`]: value })
  },

  submitQuiz() {
    if (!this.data.quiz?.unlocked || this.data.quiz.passed || this.data.quizBusy) return
    const questions = (this.data.quiz && this.data.quiz.questions) || []
    const missing = questions.some((item) => !this.data.answers[item.id])
    if (missing) {
      wx.showToast({ title: '请完成全部题目', icon: 'none' })
      return
    }
    this.setData({ quizBusy: true })
    callFunction('staff', 'submitTrainingQuiz', { answers: this.data.answers, quizVersion: this.data.quiz.version })
      .then((res) => {
        wx.showToast({ title: res.passed ? '答题通过' : `得分${res.score}，请重试`, icon: 'none' })
        this.load()
      })
      .catch(error => {
        showError(error)
        if (!this._unloaded && String(error.message || '').includes('题目配置已更新')) {
          this.setData({ answers: {} })
          this.load()
        }
      })
      .finally(() => { if (!this._unloaded) this.setData({ quizBusy: false }) })
  },

  resolveVideoUrls(videos = [], version = this._trainingLoadVersion, preserveVideoUrls = false) {
    const fileIds = []
    videos.forEach((item) => {
      if (item.fileId && (!preserveVideoUrls || !item.tempUrl)) fileIds.push(item.fileId)
      if (item.posterFileId && (!preserveVideoUrls || !item.posterTempUrl)) fileIds.push(item.posterFileId)
    })
    const uniqueIds = Array.from(new Set(fileIds))
    if (!uniqueIds.length) return
    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        if (this._unloaded || version !== this._trainingLoadVersion) return
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

  getVideoTracking(key) {
    const target = this.data.videos.find(video => video.key === key)
    if (!target) return null
    if (!this._videoTracking) this._videoTracking = {}
    if (!this._videoTracking[key] || this._videoTracking[key].fileId !== target.fileId) {
      this._videoTracking[key] = { fileId: target.fileId, maxTime: 0, duration: 0, lastToast: 0, seeking: false, completed: target.watched === true }
    }
    return this._videoTracking[key]
  },

  onVideoLoadedMetadata(e) {
    const track = this.getVideoTracking(e.currentTarget.dataset.key)
    if (track) track.duration = positiveDuration(e.detail.duration) || track.duration
  },

  onVideoPlay(e) {
    const track = this.getVideoTracking(e.currentTarget.dataset.key)
    if (!track) return
    if (!track.playing) track.lastSampleAt = Date.now()
    track.playing = true
  },

  onVideoPause(e) {
    const track = this.getVideoTracking(e.currentTarget.dataset.key)
    if (!track) return
    this.stopVideoPlayback(track)
  },

  stopVideoPlayback(track) {
    const nowMs = Date.now()
    if (track.playing && track.lastSampleAt != null) {
      track.tailPlaybackSeconds = (track.tailPlaybackSeconds || 0) + Math.max(0, (nowMs - track.lastSampleAt) / 1000)
    }
    track.playing = false
    track.pausedAt = nowMs
    track.lastSampleAt = nowMs
  },

  onVideoSeeking(e) {
    const track = this.getVideoTracking(e.currentTarget.dataset.key)
    if (track) {
      track.seeking = true
      track.tailPlaybackSeconds = 0
    }
  },

  onVideoSeekComplete(e) {
    const key = e.currentTarget.dataset.key
    if (this._videoTracking && this._videoTracking[key]) {
      this._videoTracking[key].seeking = false
      this._videoTracking[key].lastSampleAt = Date.now()
    }
  },

  onVideoTimeUpdate(e) {
    const key = e.currentTarget.dataset.key
    const track = this.getVideoTracking(key)
    if (!track) return
    const currentTime = Number(e.detail.currentTime)
    const duration = positiveDuration(e.detail.duration) || track.duration
    if (!Number.isFinite(currentTime) || currentTime < 0 || duration <= 0) return
    track.duration = duration
    if (track.completed || track.seeking) return

    const target = this.data.videos.find((v) => v.key === key)
    if (target && target.watched) {
      track.completed = true
      return
    }

    // Delayed native callbacks can cover more than 2.5 seconds of normal playback.
    const nowMs = Date.now()
    const elapsedPlayback = (track.tailPlaybackSeconds || 0) + (track.playing && track.lastSampleAt != null ? Math.max(0, (nowMs - track.lastSampleAt) / 1000) : 0)
    if (currentTime > track.maxTime + Math.max(2.5, elapsedPlayback + 0.5)) {
      const videoCtx = wx.createVideoContext(`video-${key}`, this)
      videoCtx.seek(track.maxTime)
      if (nowMs - (track.lastToast || 0) > 3000) {
        track.lastToast = nowMs
        wx.showToast({
          title: '请连续观看视频，不可快进',
          icon: 'none',
          duration: 2500
        })
      }
      return
    }

    track.lastSampleAt = nowMs
    track.tailPlaybackSeconds = 0
    // Preserve fractional seconds so short videos use the same ratio as long ones.
    if (currentTime > track.maxTime) {
      track.maxTime = Math.min(currentTime, duration)
      const percent = Math.min(100, Math.floor((track.maxTime / duration) * 100 + 0.000001))
      if (target && target.progressPercent !== percent) {
        const updatedVideos = this.data.videos.map((item) => {
          if (item.key === key) {
            return { ...item, progressPercent: percent }
          }
          return item
        })
        this.setData({ videos: updatedVideos })
      }
    }

    if (track.maxTime + 0.000001 >= duration * videoPassPercent(this.data.videoPassPercent) / 100) {
      return this.handleVideoFinish(key, track.maxTime, duration)
    }
  },

  onVideoEnded(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const target = this.data.videos.find((v) => v.key === key)
    // 已经标记为已完成的视频，重播结束属于正常温习，直接放行不弹任何报错
    if (target && target.watched) return

    const track = this.getVideoTracking(key)
    if (!track) return
    const duration = track.duration
    if (!duration) {
      wx.showToast({ title: '未获取到视频时长，请重新播放', icon: 'none' })
      return
    }
    // ended can arrive after the final timeupdate. Count only the small tail
    // confirmed by both natural completion and elapsed playback time.
    const stoppedAt = track.playing ? Date.now() : track.pausedAt
    const tailElapsed = (track.tailPlaybackSeconds || 0) + (track.lastSampleAt != null && stoppedAt != null ? Math.max(0, (stoppedAt - track.lastSampleAt) / 1000) : 0)
    const remaining = duration - track.maxTime
    if (!track.seeking && remaining >= 0 && remaining <= 2.5 && remaining <= tailElapsed + 0.05) track.maxTime = duration
    this.stopVideoPlayback(track)
    if (track.seeking || track.maxTime + 0.000001 < duration * videoPassPercent(this.data.videoPassPercent) / 100) {
      wx.showToast({
        title: `观看未达到 ${this.data.videoPassPercent}%，请继续观看`,
        icon: 'none'
      })
      const videoCtx = wx.createVideoContext(`video-${key}`, this)
      videoCtx.seek(track.maxTime)
      return
    }
    return this.handleVideoFinish(key, track.maxTime, duration)
  },

  handleVideoFinish(key, watchedSeconds, duration) {
    const track = this.getVideoTracking(key)
    if (this._unloaded || this._trainingHidden || !track || track.completed || track.syncing || Date.now() < (track.retryAfter || 0)) return
    if (track.retryable && track.retryAttempts > 2) return
    if (!positiveDuration(duration) || watchedSeconds + 0.000001 < duration * videoPassPercent(this.data.videoPassPercent) / 100) return
    const target = this.data.videos.find((item) => item.key === key)
    if (target && target.watched) {
      track.completed = true
      return
    }
    this.clearVideoSyncRetry(track)
    track.syncing = true
    this.setData({ videos: this.data.videos.map(item => item.key === key ? { ...item, syncError: false } : item) })
    wx.showLoading({ title: '记录学习进度...' })
    return callFunction('staff', 'markTrainingVideoWatched', {
      videoKey: key,
      fileId: track.fileId,
      watchedSeconds,
      duration
    })
      .then(() => {
        track.completed = true
        track.retryable = false
        track.retryAttempts = 0
        this.clearVideoSyncRetry(track)
        wx.hideLoading()
        if (this._unloaded || this._trainingHidden || this._videoTracking[key] !== track) return
        this.setData({ videos: this.data.videos.map(item => item.key === key ? { ...item, watched: true } : item) })
        wx.showToast({ title: '该视频观看已达标', icon: 'success' })
        return this.load({ preserveVideoUrls: true })
      })
      .catch((err) => {
        wx.hideLoading()
        if (this._unloaded || this._videoTracking[key] !== track) return
        track.retryable = !err.module
        track.retryAttempts = (track.retryAttempts || 0) + 1
        track.retryAfter = Date.now() + Math.min(3000, track.retryAttempts * 1000)
        if (track.retryable && track.retryAttempts <= 2) {
          this.scheduleVideoSyncRetry(key, track)
        } else {
          this.setData({ videos: this.data.videos.map(item => item.key === key ? { ...item, syncError: track.retryable } : item) })
          if (!this._trainingHidden) {
            showError(err)
            if (String(err.code || '').startsWith('TRAINING_')) this.load({ preserveVideoUrls: true })
          }
        }
      })
      .finally(() => { track.syncing = false })
  },

  clearVideoSyncRetry(track) {
    if (track.retryTimer !== undefined) {
      clearTimeout(track.retryTimer)
      delete track.retryTimer
    }
  },

  scheduleVideoSyncRetry(key, track) {
    if (this._unloaded || this._trainingHidden || track.completed || track.retryTimer !== undefined) return
    track.retryTimer = setTimeout(() => {
      delete track.retryTimer
      if (this._videoTracking[key] !== track) return
      return this.handleVideoFinish(key, track.maxTime, track.duration)
    }, Math.max(0, (track.retryAfter || 0) - Date.now()))
  },

  retryPendingVideoSyncs() {
    this.data.videos.forEach(video => {
      const track = this._videoTracking && this._videoTracking[video.key]
      if (track && track.retryable && track.retryAttempts <= 2 && !track.completed) this.scheduleVideoSyncRetry(video.key, track)
    })
  },

  retryVideoSync(e) {
    const key = e.currentTarget.dataset.key
    const track = this.getVideoTracking(key)
    if (!track || track.syncing || track.completed) return
    track.retryAttempts = 0
    track.retryAfter = 0
    return this.handleVideoFinish(key, track.maxTime, track.duration)
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
