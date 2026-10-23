const { callFunction, showError, getSelectedLocation, getCurrentLocation, ensureLogin, requestSubscribeTemplates } = require('../../../utils/cloud')
const { clusterCommunities, inRegion, validPoint } = require('../../../utils/community-map')

Page({
  data: {
    mode: 'sitters', canFindOrders: false, city: '', filterDate: '', orderKind: 'all',
    onlyDirect: false, inServiceRange: false, inServiceTime: false, staffGenderRequirement: 'any',
    latitude: 22.5431, longitude: 114.0579, scale: 13, markers: [],
    loading: false, panelLoading: false, panelError: '', error: '', mapError: false, dirty: false,
    selected: null, clusterChoices: null, cards: [], page: 1, hasMore: false, total: 0, visibleCount: 0, communityCount: 0,
    unmatchedCount: 0, expanded: false, entering: false, reducedMotion: false, submitting: '', sheetOffset: 0, dragging: false,
    acceptRisk: null, riskStep: 1, riskAgreed: false, pendingOrderId: '', successOrderId: '', confirmingOrderId: '',
    genderLabels: ['不限性别', '女性宠托师', '男性宠托师'], genderIndex: 0
  },
  onLoad(options = {}) {
    this._seq = 0; this._panelSeq = 0; this._communities = []; this._groups = []
    const point = getSelectedLocation()
    const reducedMotion = wx.getStorageSync('communityMapReducedMotion') === true
    this.setData({ mode: options.mode === 'orders' ? 'orders' : 'sitters', city: options.city || point?.city || '',
      filterDate: options.date || '', orderKind: options.kind || 'all', staffGenderRequirement: options.gender || 'any',
      genderIndex: options.gender === 'female' ? 1 : options.gender === 'male' ? 2 : 0,
      reducedMotion, ...(validPoint(point) ? { latitude: Number(point.latitude), longitude: Number(point.longitude) } : {}) })
    this._reference = point || null
    callFunction('auth', 'me').then(user => {
      if (this._closed) return
      this._user = user
      this.setData({ canFindOrders: !!user.roles?.includes('staff') })
      if (this.data.mode === 'orders' && !user.roles?.includes('staff')) this.setData({ mode: 'sitters' })
      if (user.roles?.includes('staff')) return callFunction('staff', 'getStaffProfile')
    }).then(profile => {
      if (this._closed) return
      if (!this.data.city && profile?.serviceCity) this.setData({ city: profile.serviceCity })
      if (this.data.mode === 'orders' && validPoint({ latitude: profile?.serviceLatitude, longitude: profile?.serviceLongitude })) {
        this._reference = { latitude: profile.serviceLatitude, longitude: profile.serviceLongitude }
        this.setData({ latitude: profile.serviceLatitude, longitude: profile.serviceLongitude })
      }
      this.refresh()
    }).catch(() => { if (!this._closed) { if (this.data.mode === 'orders') this.setData({ mode: 'sitters' }); this.refresh() } })
  },
  onReady() {
    this._map = wx.createMapContext('communityMap', this)
    if (this._communities.length) { this._map.includePoints({ points: this._communities, padding: [80, 40, 140, 40] }); this._fitted = true }
  },
  onShow() {
    this._hidden = false
    if (this._loaded) this.refresh()
  },
  onHide() { this._hidden = true; this.stopRefresh(); this._seq++; this._panelSeq++ },
  onUnload() { this._closed = true; this.stopRefresh(); clearTimeout(this._enterTimer); this._seq++; this._panelSeq++ },
  stopRefresh() { clearTimeout(this._refreshTimer) },
  scheduleRefresh() {
    this.stopRefresh()
    if (!this._hidden && !this._closed && this.data.selected) this._refreshTimer = setTimeout(() => this.refresh(true), 20000)
  },
  inputCity(e) { this._cityDraft = String(e.detail.value).trim() },
  confirmCity() {
    if (this._cityDraft !== undefined && this._cityDraft !== this.data.city) {
      this.closePanel(); this._communities = []; this._region = null
      this.setData({ city: this._cityDraft, markers: [], visibleCount: 0, communityCount: 0 })
      this._fitNext = true
    }
    this.refresh()
  },
  requestData() {
    return { city: this.data.city, filterDate: this.data.filterDate, orderKind: this.data.orderKind,
      onlyDirect: this.data.onlyDirect, inServiceRange: this.data.inServiceRange, inServiceTime: this.data.inServiceTime,
      latitude: this._reference?.latitude || 0, longitude: this._reference?.longitude || 0,
      staffGenderRequirement: this.data.staffGenderRequirement }
  },
  action() { return this.data.mode === 'orders' ? 'listOrders' : 'listSitters' },
  async refresh(silent = false) {
    silent = silent === true
    if (this._closed || this._hidden) return
    if (!this.data.city) { this.setData({ error: '输入服务城市，查看附近小区', loading: false }); return }
    const seq = ++this._seq
    this.setData({ loading: !silent, error: '', dirty: false })
    try {
      const result = await callFunction('communityMap', this.action(), this.requestData())
      if (seq !== this._seq || this._closed || this._hidden) return
      this._communities = result.communities || []; this._loaded = true
      this.setData({ unmatchedCount: result.unmatchedCount || 0, loading: false,
        updatedText: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })
      if (!this._fitted || this._fitNext) {
        if (this._communities.length && this._map) {
          this._fitted = true; this._fitNext = false
          this._map.includePoints({ points: this._communities, padding: [80, 40, 140, 40] })
        }
      }
      this.renderMarkers()
      if (this.data.selected) {
        const selected = this._communities.find(row => row._id === this.data.selected._id)
        if (!selected) this.closePanel()
        else { this.setData({ selected }); await this.loadCards(1, silent) }
      }
    } catch (error) {
      if (seq === this._seq && !this._closed) this.setData({ loading: false, error: error.message || '加载失败，请重试' })
    } finally { this.scheduleRefresh() }
  },
  renderMarkers() {
    const groups = clusterCommunities(this._communities, this.data.scale, this._region)
    this._groups = groups
    this._markerIds = this._markerIds || new Map()
    this._markerLookup = new Map()
    const isOrders = this.data.mode === 'orders', accent = isOrders ? '#B84E1D' : '#176B5B'
    const markers = groups.map(group => {
      const key = `${this.data.mode}:${group.key}`
      if (!this._markerIds.has(key)) this._markerIds.set(key, this._markerIds.size + 1)
      const markerId = this._markerIds.get(key)
      this._markerLookup.set(markerId, group)
      const single = group.members.length === 1, member = group.members[0]
      const selected = single && this.data.selected?._id === member._id
      const count = group.count > 99 ? '99+' : group.count
      return { id: markerId, latitude: group.latitude, longitude: group.longitude,
        iconPath: isOrders ? '/assets/map-order.png' : '/assets/map-sitter.png', width: selected ? 24 : 18, height: selected ? 24 : 18,
        zIndex: selected ? 20 : 1, callout: { content: `${single ? member.name : group.members.length + '个小区'}\n${count}${isOrders ? ' 单' : ' 位宠托师'}${single && member.urgentCount ? ' · 含加急' : ''}`,
          display: 'ALWAYS', color: selected ? '#FFFFFF' : accent, bgColor: selected ? accent : '#FFFFFF',
          borderRadius: 18, padding: 9, fontSize: 12, borderWidth: 1, borderColor: accent, textAlign: 'center' } }
    })
    const visible = this._communities.filter(row => inRegion(row, this._region))
    this.setData({ markers, communityCount: visible.length, visibleCount: visible.reduce((n, row) => n + row.count, 0) })
  },
  regionChanged(e) {
    if (e.type !== 'end' && e.detail?.type !== 'end') return
    if (this._closed) return
    this._map?.getRegion({ success: region => {
      if (this._closed) return
      this._region = region
      this._map.getScale({ success: result => {
        if (this._closed) return
        this.setData({ scale: result.scale, dirty: e.causedBy === 'drag' || e.detail?.causedBy === 'drag' })
        this.renderMarkers()
      } })
    } })
  },
  async markerTap(e) {
    const group = this._markerLookup?.get(Number(e.detail.markerId))
    if (!group || this.data.submitting) return
    if (group.members.length > 1) {
      if (this.data.scale < 18) {
        this._map?.includePoints({ points: group.members, padding: [100, 50, 150, 50] })
        this.setData({ scale: Math.min(18, this.data.scale + 2) })
      } else {
        this.setData({ clusterChoices: group.members })
      }
      return
    }
    this.selectCommunity(group.members[0])
  },
  chooseClusterMember(e) {
    const selected = (this.data.clusterChoices || []).find(row => row._id === e.currentTarget.dataset.id)
    this.setData({ clusterChoices: null })
    if (selected) this.selectCommunity(selected)
  },
  closeCluster() { this.setData({ clusterChoices: null }) },
  selectCommunity(selected) {
    this._panelSeq++
    this._nextCursor = ''
    this.setData({ selected, cards: [], page: 1, total: selected.count, panelError: '', entering: true, successOrderId: '' })
    clearTimeout(this._enterTimer)
    this._enterTimer = setTimeout(() => { if (!this._closed) this.setData({ entering: false }) }, 360)
    this.renderMarkers(); this.loadCards(1)
    // Centre above the bottom sheet using public points only.
    this._map?.moveToLocation({ latitude: Number(selected.latitude) - 0.003, longitude: Number(selected.longitude) })
    this.scheduleRefresh()
  },
  async loadCards(page = 1, silent = false) {
    const selected = this.data.selected
    if (!selected || this._hidden) return
    const seq = ++this._panelSeq
    this.setData({ panelLoading: !silent, panelError: '' })
    try {
      const result = await callFunction('communityMap', this.action(), { ...this.requestData(), communityId: selected._id, page,
        ...(page > 1 && this._nextCursor ? { cursor: this._nextCursor } : {}) })
      if (seq !== this._panelSeq || this._closed || this.data.selected?._id !== selected._id) return
      const old = page > 1 ? this.data.cards : []
      const cards = [...old, ...(result.list || [])].filter((row, i, all) => all.findIndex(other => other._id === row._id) === i)
      this._nextCursor = result.nextCursor || ''
      this.setData({ cards, page, hasMore: result.hasMore, total: result.total, panelLoading: false })
    } catch (error) {
      if (seq === this._panelSeq && !this._closed) this.setData({ panelLoading: false, panelError: error.message || '加载失败' })
    }
  },
  more() { if (!this.data.panelLoading && this.data.hasMore) this.loadCards(this.data.page + 1) },
  retryPanel() { this.loadCards(1) },
  closePanel() { this._panelSeq++; this._nextCursor = ''; this.stopRefresh(); this.setData({ selected: null, cards: [], panelLoading: false, panelError: '', expanded: false }); this.renderMarkers() },
  toggleExpanded() { this.setData({ expanded: !this.data.expanded }) },
  dragStart(e) { this._dragY = e.touches[0].clientY; this._lastDragAt = 0; this.setData({ dragging: true, entering: false }) },
  dragMove(e) {
    if (!this.data.dragging) return
    const now = Date.now()
    if (now - this._lastDragAt < 20) return
    this._lastDragAt = now
    const delta = e.touches[0].clientY - this._dragY
    this.setData({ sheetOffset: Math.max(this.data.expanded ? -20 : -140, Math.min(230, delta)) })
  },
  dragEnd(e) {
    const delta = e.changedTouches[0].clientY - this._dragY
    this.setData({ dragging: false, sheetOffset: 0 })
    if (delta < -45) this.setData({ expanded: true })
    else if (delta > 65) { if (this.data.expanded) this.setData({ expanded: false }); else this.closePanel() }
  },
  dragCancel() { this.setData({ dragging: false, sheetOffset: 0 }) },
  changeMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode || this.data.submitting || (mode === 'orders' && !this.data.canFindOrders)) return
    this._seq++; this.closePanel(); this._communities = []; this._region = null
    this.setData({ mode, markers: [], visibleCount: 0, communityCount: 0, unmatchedCount: 0, filterDate: '' }); this.refresh()
  },
  changeKind(e) { this.closePanel(); this.setData({ orderKind: e.currentTarget.dataset.kind }); this.refresh() },
  changeDate(e) { this.closePanel(); this.setData({ filterDate: e.detail.value }); this.refresh() },
  clearDate() { this.closePanel(); this.setData({ filterDate: '' }); this.refresh() },
  toggleRange() { this.closePanel(); this.setData({ inServiceRange: !this.data.inServiceRange }); this.refresh() },
  toggleTime() { this.closePanel(); this.setData({ inServiceTime: !this.data.inServiceTime }); this.refresh() },
  toggleDirect() { this.closePanel(); this.setData({ onlyDirect: !this.data.onlyDirect }); this.refresh() },
  changeGender(e) { const i = Number(e.detail.value); this.closePanel(); this.setData({ genderIndex: i, staffGenderRequirement: ['any', 'female', 'male'][i] }); this.refresh() },
  toggleMotion() { const reducedMotion = !this.data.reducedMotion; this.setData({ reducedMotion }); wx.setStorageSync('communityMapReducedMotion', reducedMotion) },
  async locate() {
    try { const point = await getCurrentLocation(); if (this._closed) return; this.setData({ latitude: point.latitude, longitude: point.longitude }); this._map?.moveToLocation({ latitude: point.latitude, longitude: point.longitude }) }
    catch (error) { showError(error) }
  },
  zoom(e) { this.setData({ scale: Math.max(5, Math.min(19, this.data.scale + Number(e.currentTarget.dataset.step))) }) },
  mapFailed() { this.setData({ mapError: true }) },
  listView() { wx.navigateTo({ url: this.data.mode === 'orders' ? '/pages/staff/home/index' : '/pages/client/sitters/list/index' }) },
  detail(e) {
    const id = encodeURIComponent(e.currentTarget.dataset.id)
    wx.navigateTo({ url: this.data.mode === 'orders' ? `/pages/staff/orders/detail/index?id=${id}` : `/pages/client/sitters/detail/index?id=${id}&staffGenderRequirement=${this.data.staffGenderRequirement}` })
  },
  async book(e) {
    if (this.data.submitting) return
    const id = e.currentTarget.dataset.id, sitter = this.data.cards.find(row => row._id === id)
    if (!sitter || sitter.canDirectBook === false || sitter.acceptDirectOrders === false) return
    this.setData({ submitting: id })
    try { await ensureLogin({ content: '登录后可指定预约宠托师' }); wx.navigateTo({ url: `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${encodeURIComponent(id)}&staffGenderRequirement=${this.data.staffGenderRequirement}` }) }
    catch (_) {} finally { if (!this._closed) this.setData({ submitting: '' }) }
  },
  async grab(e) {
    if (this.data.submitting || this.data.confirmingOrderId) return
    const id = e.currentTarget.dataset.id
    if (!this.data.cards.some(row => row._id === id)) return
    this.setData({ submitting: id })
    try {
      await requestSubscribeTemplates(['staffDirectOrder', 'upcomingServiceReminder', 'serviceProgress'], 'community_map_grab').catch(() => null)
      const risk = await callFunction('staff', 'checkAcceptOrderRisk', { orderId: id })
      if (this._closed) return
      if (risk?.requiresConfirmation) { this.setData({ acceptRisk: risk, pendingOrderId: id, riskStep: 1, riskAgreed: false, submitting: '' }); return }
      await this.submitGrab(id, false)
    } catch (error) { showError(error) }
    finally { if (!this._closed) this.setData({ submitting: '' }) }
  },
  async submitGrab(id, riskConfirmed) {
    this.setData({ submitting: id })
    try {
      const location = await getCurrentLocation()
      await callFunction('staff', 'acceptOrder', { orderId: id, riskConfirmed, currentLatitude: location.latitude, currentLongitude: location.longitude })
      if (this._closed) return
      this.setData({ successOrderId: id }); this.closeRisk()
      wx.showToast({ title: '接单成功', icon: 'success' }); await this.refresh(true)
    } catch (error) {
      // An RPC failure may arrive after the assignment committed. Resolve ownership before retry.
      let result
      try { result = await callFunction('staff', 'getGrabResult', { orderId: id }) } catch (_) {}
      if (this._closed) return
      if (result?.state === 'assigned') {
        this.setData({ successOrderId: id }); this.closeRisk(); wx.showToast({ title: '已确认接单成功', icon: 'none' }); await this.refresh(true)
      } else if (result) { showError(error); await this.refresh(true) }
      else { this.closeRisk(); this.setData({ confirmingOrderId: id }); wx.showToast({ title: '接单结果待确认，请勿重复提交', icon: 'none' }) }
    } finally { if (!this._closed) this.setData({ submitting: '' }) }
  },
  async confirmGrabResult() {
    const id = this.data.confirmingOrderId
    if (!id || this.data.submitting) return
    this.setData({ submitting: id })
    try {
      const result = await callFunction('staff', 'getGrabResult', { orderId: id })
      if (this._closed) return
      this.setData({ confirmingOrderId: '', ...(result.state === 'assigned' ? { successOrderId: id } : {}) })
      wx.showToast({ title: result.state === 'assigned' ? '已确认接单成功' : result.state === 'available' ? '尚未接单，可重新尝试' : '该任务当前不可接', icon: 'none' })
      await this.refresh(true)
    } catch (_) { if (!this._closed) wx.showToast({ title: '仍在确认，请稍后重试', icon: 'none' }) }
    finally { if (!this._closed) this.setData({ submitting: '' }) }
  },
  closeRisk() { if (!this._closed) this.setData({ acceptRisk: null, pendingOrderId: '', riskStep: 1, riskAgreed: false }) },
  nextRisk() { this.setData({ riskStep: 2 }) },
  agreeRisk() { this.setData({ riskAgreed: !this.data.riskAgreed }) },
  confirmRisk() { if (this.data.riskAgreed && !this.data.submitting) this.submitGrab(this.data.pendingOrderId, true) },
  successDetail() { if (this.data.successOrderId) wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + encodeURIComponent(this.data.successOrderId) }) },
  noop() {}
})
