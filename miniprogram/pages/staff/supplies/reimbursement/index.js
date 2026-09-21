const { callFunction, showError, requirePrivacyAuthorize } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { copyText } = require('../../../../utils/clipboard')

// Same cloud upload pattern as the existing staff evidence/identity pages.
function uploadReceipt(filePath) {
  const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: `staff_supplies/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject
    })
  })
}

Page({
  data: {
    themeClass: 'theme-day',
    profile: null,
    application: null,
    supplies: null,
    canApply: false,
    loading: false,
    loadError: false,
    busy: false,
    uploading: false,
    amount: '',
    remark: '',
    receipts: [],
    submittedReceipts: [],
    statusLabel: '',
    failureReason: '',
    canConfirmTransfer: false,
    transferNotice: '',
    copyModal: {
      show: false,
      title: '',
      tip: '',
      content: '',
      btnText: '一键复制'
    }
  },

  onShow() {
    this.setData(getThemeState(applyTheme().value))
    if (!this.data.busy && !this.data.uploading) this.load(true)
  },

  async load(query = false) {
    if (this.data.loading) return
    this.setData({ loading: true, loadError: false, canApply: false, canConfirmTransfer: false })
    try {
      // Query refreshes the merchant transfer; the status endpoint is authoritative.
      if (query) {
        try {
          await callFunction('staff', 'querySupplyReimbursement')
        } catch (error) {
          this.setData({ transferNotice: '转账状态同步失败，以下为服务端已记录状态，请稍后刷新核实到账。' })
          showError(error)
        }
      }
      const [result, profile] = await Promise.all([
        callFunction('staff', 'getSupplyReimbursementStatus'),
        callFunction('staff', 'getStaffProfile')
      ])
      const application = result.application || null
      const status = String(application && application.status || '').toUpperCase()
      const transferStatus = String(application && application.transferStatus || status).toUpperCase()
      const approved = ['APPROVED', 'APPROVED_AWAITING_PAYMENT', 'WAITING_PAYMENT', 'PENDING_PAYMENT'].includes(status)
      const canConfirmTransfer = Boolean(application && (approved || transferStatus === 'WAIT_USER_CONFIRM'))
      this.setData({
        profile,
        application,
        supplies: result.supplies || {},
        canApply: Boolean(result.canApply && profile && profile.staffLevel === 'certified' && (!result.supplies || result.supplies.reimbursementEnabled !== false)),
        statusLabel: application ? (approved ? '审核通过，等待平台付款' : application.statusText || application.status || '处理中') : '暂无申请',
        failureReason: application && (application.rejectReason || application.failureReason || application.failReason || application.reason) || '',
        submittedReceipts: application && Array.isArray(application.mediaFileIds) ? application.mediaFileIds : [],
        canConfirmTransfer
      })
    } catch (error) {
      this.setData({ loadError: true })
      showError(error)
    } finally {
      this.setData({ loading: false })
    }
  },

  refresh() {
    if (!this.data.busy && !this.data.uploading) this.load(true)
  },

  inputAmount(e) {
    this.setData({ amount: e.detail.value })
  },

  inputRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  async chooseReceipts() {
    if (!this.data.canApply || this.data.loading || this.data.busy || this.data.uploading || this.data.receipts.length >= 9) return
    this.setData({ uploading: true })
    try {
      await requirePrivacyAuthorize()
      const chosen = await new Promise((resolve, reject) => wx.chooseMedia({
        count: 9 - this.data.receipts.length,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: resolve,
        fail: reject
      }))
      wx.showLoading({ title: '上传凭证...', mask: true })
      for (const file of chosen.tempFiles) {
        const fileId = await uploadReceipt(file.tempFilePath)
        this.setData({ receipts: [...this.data.receipts, { fileId, preview: file.tempFilePath }] })
      }
    } catch (error) {
      showError(error)
    } finally {
      wx.hideLoading()
      this.setData({ uploading: false })
    }
  },

  removeReceipt(e) {
    if (this.data.busy || this.data.uploading) return
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ receipts: this.data.receipts.filter((item, i) => i !== index) })
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

  executeCopyModal() {
    const content = this.data.copyModal && this.data.copyModal.content
    copyText(content, { successTitle: '复制成功', emptyTitle: '暂无可复制内容' })
  },

  closeCopyModal() {
    this.setData({ 'copyModal.show': false })
  },

  noop() {},

  async previewReceipt(e) {
    const submitted = e.currentTarget.dataset.submitted === 'yes'
    const urls = submitted ? this.data.submittedReceipts : this.data.receipts.map((item) => item.preview)
    const index = Number(e.currentTarget.dataset.index)
    try {
      const cloudIds = urls.filter((url) => url.startsWith('cloud://'))
      let resolved = urls
      if (cloudIds.length) {
        const result = await wx.cloud.getTempFileURL({ fileList: cloudIds })
        const urlMap = {}
        ;(result.fileList || []).forEach((file) => { if (file.tempFileURL) urlMap[file.fileID] = file.tempFileURL })
        resolved = urls.map((url) => urlMap[url] || url)
      }
      if (resolved[index]) wx.previewImage({ current: resolved[index], urls: resolved, fail: showError })
    } catch (error) {
      showError(error)
    }
  },

  async submit() {
    if (!this.data.canApply || this.data.loading || this.data.busy || this.data.uploading) return
    const amountText = this.data.amount.trim()
    const amount = Number(amountText)
    if (!/^\d+(\.\d{1,2})?$/.test(amountText) || !Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请填写有效金额，最多两位小数', icon: 'none' })
      return
    }
    const maxCap = (this.data.supplies && this.data.supplies.maxReimbursementAmount) || 200
    if (amount > maxCap) {
      wx.showToast({ title: `报销金额不能超过上限 ¥${maxCap}`, icon: 'none' })
      return
    }
    if (!this.data.receipts.length) {
      wx.showToast({ title: '请上传首次购买截图凭证', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    wx.showLoading({ title: '提交申请...', mask: true })
    try {
      await callFunction('staff', 'submitSupplyReimbursement', {
        mediaFileIds: this.data.receipts.map((item) => item.fileId),
        amount,
        remark: this.data.remark.trim(),
        clientRequestId: `req_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
      })
      this.setData({ receipts: [], amount: '', remark: '' })
      wx.showToast({ title: '已提交，等待审核', icon: 'none' })
    } catch (error) {
      showError(error)
    } finally {
      wx.hideLoading()
      await this.load()
      this.setData({ busy: false })
    }
  },

  async confirmTransfer() {
    if (this.data.busy || this.data.loading || !this.data.canConfirmTransfer) return
    this.setData({ busy: true, transferNotice: '' })
    wx.showLoading({ title: '获取收款信息...', mask: true })
    try {
      const result = await callFunction('staff', 'getSupplyTransferConfirmation')
      wx.hideLoading()
      if (String(result.status || '').toUpperCase() !== 'WAIT_USER_CONFIRM') {
        this.setData({ transferNotice: '当前无需确认收款，请刷新服务端状态；审核通过不代表已到账。' })
        return
      }
      if (!result.mchId || !result.appId || !result.packageInfo) {
        this.setData({ transferNotice: '审核通过，等待平台付款。收款配置暂未就绪，请联系平台；尚未确认到账。' })
        return
      }
      if (typeof wx.canIUse !== 'function' || !wx.canIUse('requestMerchantTransfer') || typeof wx.requestMerchantTransfer !== 'function') {
        this.setData({ transferNotice: '当前微信版本不支持商家转账确认，请升级微信后重试。款项尚未确认到账。' })
        return
      }
      await new Promise((resolve, reject) => wx.requestMerchantTransfer({
        mchId: result.mchId,
        appId: result.appId,
        package: result.packageInfo,
        success: resolve,
        fail: reject
      }))
      this.setData({ transferNotice: '收款确认页面已展示，不代表到账；请以服务端查询结果为准。' })
    } catch (error) {
      this.setData({ transferNotice: '未能确认到账；已审核申请仍需等待平台付款及服务端核实，可稍后刷新。' })
      showError(error)
    } finally {
      wx.hideLoading()
      await this.load(true)
      this.setData({ busy: false })
    }
  }
})
