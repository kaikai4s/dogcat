const { callFunction, showError, requestSubscribeTemplates, setCachedSystemSettings } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
const { plotNumber } = require('./plot-number')
const { subscriptionTemplateIssue } = require('../../../utils/subscription-options')
const { portraitPrompt } = require('./portrait-prompt')
const { poseLabel, placementPreview, MIN_SCALE, MAX_SCALE } = require('./memorial-portrait-layout')
const { monumentFileID } = require('./memorial-asset-path')
const { preparePortraitImage } = require('./portrait-upload')
const { createPlacementImages } = require('./portrait-preview')
const queues = { applications: ['listAdmin', 'review'], memories: ['listMemoriesAdmin', 'reviewMemory'], portraits: ['listPortraitsAdmin', 'reviewPortrait'] }
const native = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }))
Page({
  data: { mode: 'applications', status: 'pending', rows: [], loading: false, busy: false, hasMore: false, error: '', reviewForm: null,
    uploadingPortraitId: '', portraitUploadTip: '',
    subscriptionReady: false, subscribing: false, subscriptionTip: '正在读取通知配置…', subscriptionFeedback: '' },
  onLoad(options = {}) { if (Object.prototype.hasOwnProperty.call(queues, options.mode)) this.setData({ mode: options.mode }) },
  changeMode(e) {
    if (this.data.busy || !Object.prototype.hasOwnProperty.call(queues, e.currentTarget.dataset.mode)) return
    this._reviewRequest = (this._reviewRequest || 0) + 1
    this.stopAudio(); this._cursor = ''; this.setData({ mode: e.currentTarget.dataset.mode, rows: [], hasMore: false, reviewForm: null }); this.load()
  },
  onShow() { this._closed = false;
    if (this._pickingAsset) return
    const permissions = this.data.adminPermissions
    if (permissions && !this.data.adminSuper) {
      if (!permissions['memorial_' + queues[this.data.mode][0]]) {
        const mode = Object.keys(queues).find(key => permissions['memorial_' + queues[key][0]])
        if (mode) this.setData({ mode })
      }
    }
    this.setData({ busy: false, reviewForm: null }); return Promise.all([this.load(), this.loadSubscription()]) },
  onHide() { this.stopAudio(); if (this._pickingAsset && !this._unloaded) return; this._closed = true; this._reviewRequest = (this._reviewRequest || 0) + 1; this._request = (this._request || 0) + 1; this._settingsRequest = (this._settingsRequest || 0) + 1 },
  onUnload() { this._unloaded = true; if (this._placementImages) this._placementImages.dispose(); if (this._uploadTask && this._uploadTask.abort) this._uploadTask.abort(); this.onHide() },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()) },
  async load(e) {
    if (this.data.busy) return
    const more = e && e.currentTarget && e.currentTarget.dataset.more
    if (more && (this.data.loading || !this.data.hasMore)) return
    if (!more) this.stopAudio()
    const request = this._request = (this._request || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('memorial', queues[this.data.mode][0], { status: this.data.status, cursor: more ? this._cursor : '' })
      if (this._closed || request !== this._request) return
      this._cursor = result.cursor
      const rows = result.list.map(row => this.portraitRow({ ...row, plotNumber: plotNumber(row.plotId), createdText: formatDateTime(row.createdAt),
        ...(row.status === 'pending' && this._portraitAssets && this._portraitAssets[row._id] && this._portraitAssets[row._id].revision === row.revision ? { stagedAsset: this._portraitAssets[row._id].asset } : {}),
        statusText: { pending: '待审核', approved: this.data.mode === 'memories' ? '已公开' : '已安放', rejected: '需调整' }[row.status] || row.status }))
      this.setData({ rows: (more ? this.data.rows : []).concat(rows), hasMore: result.hasMore })
      await Promise.all(rows.filter(row => row.stagedAsset || row.result).map(row => this.preparePlacement(row)))
    } catch (error) { if (!this._closed && request === this._request) this.setData({ error: error.message || '加载失败，请重试' }) }
    finally { if (!this._closed && request === this._request) this.setData({ loading: false }) }
  },
  portraitRow(row) {
    const asset = row.stagedAsset || row.result
    const result = { ...row, poseLabel: poseLabel(row.pose) }
    if (!asset) return result
    result.preview = placementPreview(row, asset)
    result.previewKey = [row._id, row.revision, asset.uploadId, row.style || 'arch'].join(':')
    const loaded = this._placementLoaded && this._placementLoaded[result.previewKey] || {}
    result.previewReady = !!(loaded.pet && loaded.monument && !loaded.pending)
    result.previewPending = !!loaded.pending
    result.previewAttempt = loaded.attempt || 0
    result.previewError = loaded.petError || loaded.monumentError || ''
    result.petUrl = loaded.petUrl || ''
    result.monumentUrl = loaded.monumentUrl || ''
    return result
  },
  refreshPlacement(key) {
    if (this._unloaded) return
    const row = this.data.rows.find(item => item.previewKey === key)
    if (!row) return
    const updated = this.portraitRow(row), patch = { rows: this.data.rows.map(item => item === row ? updated : item) }
    if (this.data.reviewForm && this.data.reviewForm.previewKey === key) {
      patch.reviewForm = { ...this.data.reviewForm, petUrl: updated.petUrl, monumentUrl: updated.monumentUrl,
        previewAttempt: updated.previewAttempt, previewReady: updated.previewReady, previewPending: updated.previewPending, previewError: updated.previewError }
    }
    this.setData(patch)
  },
  preparePlacement(row, retry = false) {
    if (this._unloaded || !row || !(row.stagedAsset || row.result)) return Promise.resolve()
    const key = row.previewKey
    this._placementLoaded = this._placementLoaded || {}
    this._placementJobs = this._placementJobs || {}
    if (this._placementJobs[key]) return this._placementJobs[key]
    if (!retry && this._placementLoaded[key]) return Promise.resolve()
    const state = { attempt: (this._placementLoaded[key]?.attempt || 0) + 1, pending: true }
    this._placementLoaded[key] = state
    this.refreshPlacement(key)
    this._placementImages = this._placementImages || createPlacementImages(wx)
    // Finish cached state even if a filter temporarily removes this row. Only
    // refreshPlacement decides whether there is a visible row to update.
    const current = () => !this._unloaded && this._placementLoaded[key] === state
    const work = Promise.all(['pet', 'monument'].map(async part => {
      try {
        const source = part === 'pet' ? (row.stagedAsset || row.result).url : monumentFileID(row.style)
        const url = await this._placementImages.resolve(source)
        if (!current()) return
        state[part + 'Url'] = url; state[part] = true; state[part + 'Error'] = ''
      } catch (error) {
        if (!current()) return
        state[part] = false
        state[part + 'Error'] = (part === 'pet' ? '画像预览：' : '平台预览：') + error.message
      }
      if (current()) this.refreshPlacement(key)
    })).finally(() => {
      delete this._placementJobs[key]
      if (current()) { state.pending = false; this.refreshPlacement(key) }
    })
    this._placementJobs[key] = work
    return work
  },
  retryPlacement(e) {
    if (this.data.busy || this._unloaded) return
    const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    return this.preparePlacement(row, true)
  },
  placementImageLoaded(e) {
    this.placementImageState(e, true)
  },
  placementImageError(e) {
    this.placementImageState(e, false)
  },
  placementImageState(e, ready) {
    const { key, part, attempt, src } = e.currentTarget.dataset
    const state = this._placementLoaded && this._placementLoaded[key]
    if (this._unloaded || !state || !['pet', 'monument'].includes(part) || Number(attempt) !== state.attempt || !src || src !== state[part + 'Url']) return
    if (state[part] === ready) return
    state[part] = ready
    state[part + 'Error'] = ready ? '' : (part === 'pet' ? '画像' : '平台') + '预览未能显示，请重试预览，无需重新上传'
    this.refreshPlacement(key)
  },
  resizePortrait(e) {
    if (this.data.busy || this.data.reviewForm || !(this.data.adminSuper || (this.data.adminPermissions || {}).memorial_preparePortraitAsset)) return
    const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id)
    if (!row || row.status !== 'pending' || !row.stagedAsset) return
    const step = Number(e.currentTarget.dataset.step)
    if (![0, -5, 5].includes(step)) return
    const percent = step === 0 ? 100 : Math.round(row.stagedAsset.scale * 100) + step
    const scale = Math.round(Math.max(MIN_SCALE * 100, Math.min(MAX_SCALE * 100, percent))) / 100
    const asset = { ...row.stagedAsset, scale }
    this._portraitAssets[row._id] = { revision: row.revision, asset }
    this.setData({ rows: this.data.rows.map(r => r._id === row._id ? this.portraitRow({ ...r, stagedAsset: asset }) : r) })
  },
  changeStatus(e) { if (!this.data.busy && e.currentTarget.dataset.status !== this.data.status) { this._reviewRequest = (this._reviewRequest || 0) + 1; this._cursor = ''; this.setData({ status: e.currentTarget.dataset.status, rows: [], hasMore: false, reviewForm: null }); return this.load() } },
  async loadSubscription() {
    const request = this._settingsRequest = (this._settingsRequest || 0) + 1
    this.setData({ subscriptionReady: false })
    try {
      const settings = await callFunction('system', 'getSettings')
      if (this._closed || request !== this._settingsRequest) return
      this._subscriptionSettings = setCachedSystemSettings(settings)
      const subscription = this._subscriptionSettings.subscription || {}
      const issue = subscriptionTemplateIssue((subscription.templates || {}).adminPendingAudit)
      this.setData({ subscriptionReady: !!subscription.enabled && !issue,
        subscriptionTip: !subscription.enabled ? '平台尚未开启订阅消息，请在系统设置中开启。' : issue ? '业务待审核通知：' + issue : '使用“业务待审核通知”，新申请提交后提醒您处理。一次授权对应一次提醒，可再次订阅。' })
    } catch (_) {
      if (!this._closed && request === this._settingsRequest) this.setData({ subscriptionTip: '通知配置加载失败，请点击重试。' })
    }
  },
  subscribeAudit() {
    if (this.data.subscribing || !this.data.subscriptionReady) return
    this.setData({ subscribing: true, subscriptionFeedback: '' })
    // Prepared configuration keeps the native authorization inside the tap gesture.
    return requestSubscribeTemplates(['adminPendingAudit'], 'memorial_admin_audit', { settings: this._subscriptionSettings, waitForConsent: false }).then(result => {
      if (this._closed) return
      const id = result.templateIdByKey && result.templateIdByKey.adminPendingAudit
      const accepted = result.requested && result.results && result.results[id] === 'accept'
      this.setData({ subscriptionFeedback: accepted ? '已同意接收审核提醒；次数用完后请再次订阅。' : '尚未开启提醒。请重试，或在微信通知设置中允许订阅。' })
    }).catch(error => { if (!this._closed) showError(error) })
      .finally(() => { if (!this._unloaded) this.setData({ subscribing: false }) })
  },
  openNotificationSettings() { wx.openSetting({ withSubscriptions: true }) },
  async review(e) {
    if (this.data.busy || !(this.data.adminSuper || (this.data.adminPermissions || {})['memorial_' + queues[this.data.mode][1]])) return
    const version = this._reviewRequest = (this._reviewRequest || 0) + 1
    let row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    if (this.data.mode === 'portraits' && e.currentTarget.dataset.status === 'approved') {
      if (!row || !row.stagedAsset) { showError(new Error('请先从手机相册上传画像成品')); return }
      if (!row.previewReady || row.previewError) {
        const key = row.previewKey
        await this.preparePlacement(row, true)
        row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
        if (this._closed || version !== this._reviewRequest || this.data.busy || this.data.mode !== 'portraits' || !row || row.previewKey !== key) return
        if (!row.previewReady || row.previewError) { showError(new Error(row.previewError || '安放预览正在加载，请稍候')); return }
      }
    }
    if (row && row.status === 'pending' && ['approved', 'rejected'].includes(e.currentTarget.dataset.status)) this.setData({ reviewForm: { id: row._id, revision: row.revision, petName: row.petName, lawn: row.lawn, plotNumber: row.plotNumber, status: e.currentTarget.dataset.status, reason: '', preview: row.preview, previewKey: row.previewKey, previewAttempt: row.previewAttempt, previewReady: row.previewReady, previewPending: row.previewPending, previewError: row.previewError, petUrl: row.petUrl, monumentUrl: row.monumentUrl, poseLabel: row.poseLabel, ...(this.data.mode === 'portraits' && row.stagedAsset ? row.stagedAsset : {}) } })
  },
  previewImage(e) { if (this.data.busy) return; const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id); if (row) wx.previewImage({ urls: (row.memory ? row.memory.images : (row.photos || []).concat(row.stagedAsset || row.result || [])).map(m => m.url).filter(Boolean), current: e.currentTarget.dataset.url }) },
  openUser(e) {
    const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id)
    if (row && row.ownerOpenid && (this.data.adminSuper || (this.data.adminPermissions || {}).admin_getUserDetail)) wx.navigateTo({ url: '/pages/admin/users/edit/index?openid=' + encodeURIComponent(row.ownerOpenid) })
  },
  openArchive(e) {
    const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id)
    if (row && row.ownerOpenid && (this.data.adminSuper || (this.data.adminPermissions || {}).memorial_listUserMemorialsAdmin)) wx.navigateTo({ url: '/pages/admin/memorial/user-archive?openid=' + encodeURIComponent(row.ownerOpenid) + '&id=' + encodeURIComponent(row.applicationId || row._id) })
  },
  copyPortraitPrompt(e) {
    const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id)
    if (row) wx.setClipboardData({ data: portraitPrompt(row.pose) })
  },
  async uploadPortrait(e) {
    if (this.data.busy || this._closed || !(this.data.adminSuper || (this.data.adminPermissions || {}).memorial_preparePortraitAsset)) return
    const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id)
    if (!row || row.status !== 'pending') return
    this.setData({ busy: true, uploadingPortraitId: row._id, portraitUploadTip: '选择画像…' }); this._pickingAsset = true
    try {
      const selected = await native('chooseMedia', { count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'] })
      if (this._unloaded) return
      const file = (selected.tempFiles || [])[0]
      if (!file) return
      this.setData({ portraitUploadTip: '正在整理画像…' })
      const image = await preparePortraitImage(file, wx, () => new Promise(resolve => {
        wx.createSelectorQuery().in(this).select('#portrait-export').fields({ node: true }).exec(result => resolve(result[0] && result[0].node))
      }), () => !!this._unloaded)
      const path = image.filePath
      if (this._unloaded) return
      this.setData({ portraitUploadTip: '正在上传画像…' })
      const ticket = await callFunction('memorial', 'preparePortraitAsset', { id: row._id, revision: row.revision })
      if (this._unloaded) return
      const uploaded = await new Promise((resolve, reject) => { this._uploadTask = wx.cloud.uploadFile({ cloudPath: ticket.cloudPath, filePath: path, success: resolve, fail: reject }) })
      if (this._unloaded) return
      this.setData({ portraitUploadTip: '正在检查画像…' })
      const inspected = await callFunction('memorial', 'preparePortraitAsset', { id: row._id, revision: row.revision, uploadId: ticket.uploadId, fileId: uploaded.fileID })
      if (this._unloaded) return
      if (inspected.layoutVersion !== 1 || !inspected.bounds || !inspected.previewDigest) throw new Error('画像预览数据不完整，请更新云函数后重试')
      const asset = { ...inspected, uploadId: ticket.uploadId, fileId: uploaded.fileID, url: path }

      this._portraitAssets = this._portraitAssets || {}
      this._portraitAssets[row._id] = { revision: row.revision, asset }
      this.setData({ rows: this.data.rows.map(r => r._id === row._id && r.revision === row.revision ? this.portraitRow({ ...r, stagedAsset: asset }) : r) })
      this.setData({ portraitUploadTip: '正在加载安放预览…' })
      await this.preparePlacement(this.data.rows.find(r => r._id === row._id && r.revision === row.revision))
      if (!this._unloaded) wx.showToast({ title: '画像已上传，可在下方预览并安放', icon: 'none' })
    } catch (error) { if (!this._unloaded && !/cancel/.test(error.errMsg || '')) showError(error) }
    finally { this._pickingAsset = false; this._uploadTask = null; if (!this._unloaded) this.setData({ busy: false, uploadingPortraitId: '', portraitUploadTip: '' }) }
  },
  stopAudio() { const audio = this._audio; this._audio = null; if (audio) audio.destroy(); if (!this._unloaded) this.setData({ playingUrl: '' }) },
  playAudio(e) {
    if (this._closed) return
    const url = e.currentTarget.dataset.url, previous = this.data.playingUrl
    this.stopAudio()
    if (!url || url === previous) return
    const audio = this._audio = wx.createInnerAudioContext()
    audio.onError(() => { if (this._audio !== audio || this._closed) return; this.stopAudio(); showError(new Error('音乐未能播放，请刷新后重试')) })
    audio.onEnded(() => { if (this._audio === audio && !this._closed) this.stopAudio() })
    audio.src = url; audio.play(); this.setData({ playingUrl: url })
  },
  reason(e) { if (!this.data.busy) this.setData({ 'reviewForm.reason': e.detail.value }) },
  close() { if (!this.data.busy) { this._reviewRequest = (this._reviewRequest || 0) + 1; this.setData({ reviewForm: null }) } },
  async confirm() {
    if (this.data.busy || !this.data.reviewForm) return
    const form = this.data.reviewForm
    if (this.data.mode === 'portraits' && form.status === 'approved') {
      const row = this.data.rows.find(r => r._id === form.id)
      if (!row || row.revision !== form.revision || !row.previewReady || row.previewError || !row.stagedAsset || row.stagedAsset.uploadId !== form.uploadId || row.stagedAsset.scale !== form.scale) { showError(new Error('请重新确认画像安放预览')); return }
    }
    if (form.status === 'rejected' && !form.reason.trim()) { showError(new Error('请填写驳回原因')); return }
    const version = this._reviewRequest = (this._reviewRequest || 0) + 1
    this.setData({ busy: true })
    try {
      await callFunction('memorial', queues[this.data.mode][1], form)
      if (this._closed || version !== this._reviewRequest) return
      if (this._portraitAssets) delete this._portraitAssets[form.id]
      this.setData({ reviewForm: null, busy: false })
      wx.showToast({ title: form.status === 'approved' ? (this.data.mode === 'memories' ? '回忆已公开' : this.data.mode === 'portraits' ? '画像已安放' : '已为它安放时光小筑') : '已通知申请人调整', icon: 'none' })
      await this.load()
    } catch (error) { if (!this._closed && version === this._reviewRequest) showError(error) }
    finally { if (!this._closed && version === this._reviewRequest) this.setData({ busy: false }) }
  }
})
