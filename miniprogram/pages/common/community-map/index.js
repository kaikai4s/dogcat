const { callFunction, showError, getSelectedLocation, saveSelectedLocation, requirePrivacyAuthorize, ensureLogin, requestSubscribeTemplates, subscribeIdentityChange, getCloudEnv, isLoginRequiredError } = require('../../../utils/cloud')
const { clusterCommunities, inRegion, validPoint, locationCity, viewportKey, readViewport, storeViewport } = require('./utils')

const VIEWPORT_STORAGE = 'communityMapViewportsV1'
function getCurrentLocation() {
  return requirePrivacyAuthorize().then(() => new Promise((resolve, reject) => wx.getLocation({
    type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 6000,
    success: point => validPoint(point) ? resolve(point) : reject(new Error('位置信息无效，请重新定位')),
    fail: () => reject(new Error('请允许获取实时位置后再操作'))
  })))
}

Page({
  data: {
    mode: 'sitters', canFindOrders: false, city: '', filterDate: '', orderKind: 'all',
    onlyDirect: false, inServiceRange: false, inServiceTime: false, staffGenderRequirement: 'any',
    latitude: 22.5431, longitude: 114.0579, scale: 13, zoomScale: 13, markers: [],
    loading: false, panelLoading: false, panelRefreshing: false, checkingIdentity: true, panelError: '', error: '', mapError: false, dirty: false,
    hasReference: false, referenceName: '选择参考位置', choosingReference: false, locating: false, cardsScrollTop: 0, pendingUpdates: false,
    selected: null, clusterChoices: null, cards: [], page: 1, hasMore: false, total: 0, visibleCount: 0, communityCount: 0,
    unmatchedCount: 0, expanded: false, entering: false, reducedMotion: false, submitting: '', sheetOffset: 0, dragging: false,
    acceptRisk: null, riskStep: 1, riskAgreed: false, pendingOrderId: '', successOrderId: '', confirmingOrderId: '',
    genderLabels: ['不限性别', '女性宠托师', '男性宠托师'], genderIndex: 0
  },
  onLoad(options = {}) {
    this._seq = 0; this._panelSeq = 0; this._authSeq = 0; this._cameraSeq = 0; this._opSeq = 0; this._communities = []; this._groups = []
    const previous = getCurrentPages().slice(-2, -1)[0]?.route || ''
    this._entryRole = previous.startsWith('pages/staff/') ? 'staff' : previous.startsWith('pages/client/') ? 'client'
      : (typeof getApp === 'function' ? getApp()?.globalData?.activeRole : '')
    const point = getSelectedLocation()
    const reducedMotion = wx.getStorageSync('communityMapReducedMotion') === true
    this.setData({ mode: this._entryRole === 'staff' ? 'orders' : 'sitters', city: options.city || locationCity(point),
      filterDate: options.date || '', orderKind: options.kind || 'all', staffGenderRequirement: options.gender || 'any',
      genderIndex: options.gender === 'female' ? 1 : options.gender === 'male' ? 2 : 0,
      inServiceRange: options.inServiceRange === '1', inServiceTime: options.inServiceTime === '1',
      reducedMotion, ...(validPoint(point) ? { latitude: Number(point.latitude), longitude: Number(point.longitude) } : {}) })
    this._reference = point || null
    this.getOpenerEventChannel?.()?.on?.('communityMapContext', context => {
      if (this._closed || !validPoint(context?.reference)) return
      this._entryReference = { latitude: Number(context.reference.latitude), longitude: Number(context.reference.longitude) }
      this.saveViewport(); this._orderReference = this._entryReference
      if (this.data.mode === 'orders') this._reference = this._entryReference
      this.setData({ hasReference: true })
      if (this._initialized && this.data.mode === 'orders') { this.closePanel(); this._cameraSeq++; this.restoreViewport(); this.refresh() }
    })
    this._unsubscribeIdentity = subscribeIdentityChange?.(user => {
      const identity = this.identityKey(user)
      if (identity === this._identity) return
      this.cancelLocate(); this.saveViewport(); this._seq++; this._panelSeq++; this._authSeq++; this._opSeq++; this._cameraSeq++
      this._user = user; this._identity = identity; this._communities = []; this._region = null; this._fitted = false; this._markerIds = new Map()
      this._initializing = false; this._initialized = false; this._loaded = false; this._viewport = null; this._grabAttempt = null
      this._choosingReference = false; this._locationChoice = null
      this._entryReference = null; this._orderReference = null; this._reference = getSelectedLocation()
      this.closePanel(); this.closeRisk()
      this.setData({ canFindOrders: false, choosingReference: false, hasReference: false, referenceName: '选择参考位置', markers: [], visibleCount: 0, communityCount: 0, successOrderId: '', confirmingOrderId: '', submitting: '', checkingIdentity: true })
      if (!this._hidden && !this._closed) this.initialize()
    })
    this.initialize()
  },
  identityKey(user) { return JSON.stringify([user?._id || user?.openid || 'guest', [...(user?.roles || [])].sort(), user?.activeRole || '']) },
  async initialize() {
    const seq = ++this._authSeq
    this._initializing = true
    this.setData({ checkingIdentity: true })
    let user = null, profile = null
    try {
      user = await callFunction('auth', 'checkSession')
      if (seq !== this._authSeq || this._closed || this._hidden) return
      const role = this._entryRole || user?.activeRole || (user?.roles?.includes('staff') ? 'staff' : 'client')
      if (role === 'staff' && user?.roles?.includes('staff')) profile = await callFunction('staff', 'getStaffProfile')
    } catch (error) {
      if (seq !== this._authSeq || this._closed || this._hidden) return
      if (!isLoginRequiredError(error)) {
        this._initializing = false
        this.setData({ loading: false, error: error.message || '身份检查失败，请重试' })
        return
      }
      user = null
    }
    if (seq !== this._authSeq || this._closed || this._hidden) return
    const identity = this.identityKey(user)
    if (this._identity && this._identity !== identity) {
      this.cancelLocate(); this.saveViewport(); this._seq++; this._opSeq++; this._cameraSeq++; this._grabAttempt = null
      this._entryReference = null; this._orderReference = null; this._loaded = false
      this._communities = []; this._fitted = false; this._region = null; this._viewport = null
      this.closePanel(); this.closeRisk(); this.setData({ successOrderId: '', confirmingOrderId: '' })
    }
    this._user = user; this._identity = identity
    const role = this._entryRole || user?.activeRole || (user?.roles?.includes('staff') ? 'staff' : 'client')
    const canFindOrders = role === 'staff' && !!user?.roles?.includes('staff') && !!profile
    const mode = canFindOrders ? 'orders' : 'sitters'
    const reference = this._entryReference || (validPoint({ latitude: profile?.serviceLatitude, longitude: profile?.serviceLongitude })
      ? { latitude: Number(profile.serviceLatitude), longitude: Number(profile.serviceLongitude) } : getSelectedLocation())
    this._orderReference = reference
    this._reference = mode === 'orders' ? reference : this._entryReference || getSelectedLocation()
    this.setData({ mode, canFindOrders, checkingIdentity: false, hasReference: validPoint(this._reference),
      referenceName: this._reference?.name || (validPoint(this._reference) ? '已选参考位置' : '选择参考位置'),
      ...(!this.data.city && profile?.serviceCity ? { city: profile.serviceCity } : {}) })
    this._initialized = true; this._initializing = false
    if (!this._fitted || this._viewportKey !== this.viewKey()) this.restoreViewport()
    await this.refresh(this._loaded === true)
  },
  onReady() {
    this._ready = true
    this.createMap()
    this.createSelectorQuery?.().select('.map-area').boundingClientRect(rect => {
      if (rect?.height > 0) this._mapHeight = rect.height
    }).exec()
  },
  createMap() {
    if (this._closed || this.data.mapError) return
    this._map = wx.createMapContext('communityMap', this)
    this.fitCommunities()
  },
  fitCommunities() {
    if (this.data.locating || this._fitted || !this._map || !this._communities.length) return
    this._cameraSeq++; this._fitted = true; this._cameraTarget = null
    this._map.includePoints({ points: this._communities, padding: [80, 40, 140, 40] })
  },
  onShow() {
    this._hidden = false
    if (this._choosingReference) return
    if (this._ready && !this.data.mapError && !this._map) this.createMap()
    if (!this._initializing) this.initialize()
  },
  onHide() {
    if (this._locationChoice) this._locationChoice.interrupted = true
    this.cancelLocate(); this.saveViewport(); this._hidden = true; this.stopRefresh(); this._seq++; this._panelSeq++; this._authSeq++; this._cameraSeq++
    this._opSeq++; this._initializing = false; this._cardsBusy = false; this._deferredCards = null; this._touchingCards = false; this._touchUntil = 0
    clearTimeout(this._cardTimer); clearTimeout(this._enterTimer); clearTimeout(this._mapRetryTimer)
    this.setData({ loading: false, panelLoading: false, panelRefreshing: false, dragging: false, sheetOffset: 0, entering: false, submitting: '',
      ...(this._grabAttempt ? { confirmingOrderId: this._grabAttempt.id, acceptRisk: null, pendingOrderId: '' } : {}) })
    this._grabAttempt = null
  },
  onUnload() { this.onHide(); this._closed = true; this._unsubscribeIdentity?.(); clearTimeout(this._enterTimer) },
  viewKey() { return viewportKey(`${getCloudEnv?.() || ''}:${this._user?._id || this._user?.openid || 'guest'}`, this.data, this._reference) },
  saveViewport() {
    if (!this._initialized || !this._viewport) return
    try { wx.setStorageSync(VIEWPORT_STORAGE, storeViewport(wx.getStorageSync(VIEWPORT_STORAGE), this._viewportKey || this.viewKey(), this._viewport)) } catch (_) {}
  },
  restoreViewport(keepCamera = false, fitCommunities = false) {
    this._viewportKey = this.viewKey()
    let saved
    try { saved = readViewport(wx.getStorageSync(VIEWPORT_STORAGE), this._viewportKey) } catch (_) {}
    if (saved) this.moveCamera(saved)
    else if (!keepCamera) {
      this._viewport = null; this._region = null; this._fitted = false; this._cameraTarget = null
      if (!fitCommunities && validPoint(this._reference)) this.moveCamera({ latitude: Number(this._reference.latitude), longitude: Number(this._reference.longitude), scale: 13 })
      else this.setData({ scale: 13, zoomScale: 13 })
    }
  },
  interactionLocked() { return !!(this._closed || this._hidden || this.data.choosingReference || this.data.checkingIdentity || this.data.submitting || this.data.confirmingOrderId || this.data.acceptRisk) },
  operationCurrent(op) { return op === this._opSeq && !this._closed && !this._hidden },
  retry() { return this.data.checkingIdentity ? this.initialize() : this.refresh() },
  stopRefresh() { clearTimeout(this._refreshTimer) },
  scheduleRefresh() {
    this.stopRefresh()
    if (!this._hidden && !this._closed && this.data.selected) this._refreshTimer = setTimeout(() => {
      if (this.interactionLocked() || this._cardsBusy || this.data.dragging || this._touchingCards || Date.now() < (this._touchUntil || 0)) this.scheduleRefresh()
      else this.refresh(true)
    }, 20000)
  },
  inputCity(e) { this._cityDraft = String(e.detail.value).trim() },
  confirmCity() {
    if (this.interactionLocked()) return
    if (this._cityDraft !== undefined && this._cityDraft !== this.data.city) {
      this.cancelLocate(); this.saveViewport()
      this.closePanel(); this._communities = []; this._region = null; this._cameraSeq++
      this.setData({ city: this._cityDraft, markers: [], visibleCount: 0, communityCount: 0, unmatchedCount: 0, updatedText: '' })
      this._fitted = false; this._viewport = null; this.restoreViewport(false, true)
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
    if (silent !== true && this.interactionLocked()) return
    silent = silent === true
    if (this._closed || this._hidden) return
    const seq = ++this._seq
    if (!this.data.city) { this.setData({ error: '输入服务城市，查看附近小区', loading: false }); return }
    if (!silent) { this._panelSeq++; this._cardsBusy = false; this._deferredCards = null; this.setData({ panelRefreshing: false, panelLoading: false }) }
    this.setData({ loading: !silent, error: '', dirty: false })
    try {
      const result = await callFunction('communityMap', this.action(), this.requestData())
      if (seq !== this._seq || this._closed || this._hidden) return
      this._communities = result.communities || []; this._loaded = true
      this.setData({ unmatchedCount: result.unmatchedCount || 0, loading: false,
        updatedText: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })
      this.fitCommunities()
      this.renderMarkers()
      if (this.data.selected) {
        const selected = this._communities.find(row => row._id === this.data.selected._id)
        if (!selected) this.closePanel()
        else { this.setData({ selected }); await this.loadCards(1, silent) }
      }
    } catch (error) {
      if (seq === this._seq && !this._closed && !this._hidden) this.setData({ loading: false, error: error.message || '加载失败，请重试' })
    } finally { this.scheduleRefresh() }
  },
  renderMarkers() {
    const groups = clusterCommunities(this._communities, this._viewport?.scale || this.data.scale, this._region)
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
        zIndex: selected ? 20 : 1, callout: { content: `${single ? (String(member.name || '').length > 12 ? String(member.name).slice(0, 12) + '…' : member.name) : group.members.length + '个小区'}\n${count}${isOrders ? ' 单' : ' 位宠托师'}${single && member.urgentCount ? ' · 含加急' : ''}`,
          display: 'ALWAYS', color: selected ? '#FFFFFF' : accent, bgColor: selected ? accent : '#FFFFFF',
          borderRadius: 18, padding: 9, fontSize: 12, borderWidth: 1, borderColor: accent, textAlign: 'center' } }
    })
    const visible = this._communities.filter(row => inRegion(row, this._region))
    const choices = this.data.clusterChoices && this.data.clusterChoices.map(row => this._communities.find(current => current._id === row._id)).filter(Boolean)
    this.setData({ markers, communityCount: visible.length, visibleCount: visible.reduce((n, row) => n + row.count, 0),
      ...(choices ? { clusterChoices: choices.length ? choices : null } : {}) })
  },
  regionChanged(e) {
    const cause = e.causedBy || e.detail?.causedBy
    const gesture = ['gesture', 'drag', 'scale'].includes(cause)
    if (gesture) this.cancelLocate()
    if (e.type === 'begin' || e.detail?.type === 'begin') {
      this._cameraSeq++
      if (gesture) { this._fitted = true; this._cameraTarget = null }
      return
    }
    if (e.type !== 'end' && e.detail?.type !== 'end') return
    if (this._closed || this._hidden || !this._map) return
    const seq = ++this._cameraSeq, map = this._map
    const read = method => new Promise((resolve, reject) => map[method]({ success: resolve, fail: reject }))
    return Promise.all([read('getRegion'), read('getScale'), read('getCenterLocation')]).then(([region, result, point]) => {
      const scale = Number(result.scale)
      if (seq !== this._cameraSeq || this._closed || this._hidden || !validPoint(point) || !Number.isFinite(scale) || scale < 5 || scale > 19) return
      // A delayed 'update' event may describe the command before the latest zoom tap.
      const target = this._cameraTarget
      if (!gesture && target && Date.now() < target.until && (Math.abs(scale - target.scale) > .05 ||
        Math.abs(Number(point.latitude) - target.latitude) > .00003 || Math.abs(Number(point.longitude) - target.longitude) > .00003)) return
      this._cameraTarget = null
      this._region = region
      this._viewport = { latitude: Number(point.latitude), longitude: Number(point.longitude), scale }
      // Observations must not write the native camera bindings back and trigger a second move.
      this.setData({ zoomScale: scale, dirty: this.data.dirty || gesture })
      this.renderMarkers(); this.saveViewport()
    }).catch(() => {})
  },
  async markerTap(e) {
    const group = this._markerLookup?.get(Number(e.detail.markerId))
    if (!group || this.interactionLocked()) return
    if (group.members.length > 1) {
      const scale = Number(this._viewport?.scale || this.data.scale)
      if (scale < 19) {
        this.moveCamera({ latitude: group.latitude, longitude: group.longitude, scale: Math.min(19, scale + 2) })
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
    if (this.interactionLocked()) return
    this._panelSeq++
    this._failedCardPage = 0
    this._nextCursor = ''
    this._scrollTop = 0; this._deferredCards = null; this._cardsBusy = false
    this.setData({ selected, expanded: false, cards: [], page: 1, hasMore: false, total: selected.count, panelError: '', entering: true, successOrderId: '',
      cardsScrollTop: 0, pendingUpdates: false, panelRefreshing: false })
    clearTimeout(this._enterTimer)
    this._enterTimer = setTimeout(() => { if (!this._closed) this.setData({ entering: false }) }, 360)
    this.renderMarkers(); this.loadCards(1)
    // Keep the point above the 58% sheet; convert screen pixels at the current zoom to latitude.
    const scale = Number(this._viewport?.scale || this.data.scale)
    const offset = (this._mapHeight || 360) * .29 * 360 * Math.cos(Number(selected.latitude) * Math.PI / 180) / (256 * Math.pow(2, scale))
    this.moveCamera({ latitude: Number(selected.latitude) - offset, longitude: Number(selected.longitude) })
    this.scheduleRefresh()
  },
  async loadCards(page = 1, silent = false) {
    const selected = this.data.selected
    if (!selected || this._hidden || this._closed) return
    const seq = ++this._panelSeq
    this._failedCardPage = 0
    const refreshing = silent && page === 1 && this.data.cards.length > 0
    const oldCards = this.data.cards.slice(), oldPage = this.data.page, oldCursor = this._nextCursor
    this._cardsBusy = true
    this.setData({ panelLoading: !silent, panelRefreshing: refreshing, panelError: '' })
    try {
      const result = await callFunction('communityMap', this.action(), { ...this.requestData(), communityId: selected._id, page,
        ...(refreshing ? { refreshIds: oldCards.map(row => row._id) } : {}),
        ...(page > 1 && this._nextCursor ? { cursor: this._nextCursor } : {}) })
      if (seq !== this._panelSeq || this._closed || this._hidden || this.data.selected?._id !== selected._id) return
      const apply = () => {
        if (seq !== this._panelSeq || this._closed || this._hidden || this.data.selected?._id !== selected._id) return
        const preserve = refreshing && Array.isArray(result.visibleList)
        const old = page > 1 ? oldCards : []
        const cards = preserve ? result.visibleList : [...old, ...(result.list || [])].filter((row, i, all) => all.findIndex(other => other._id === row._id) === i)
        const known = new Set(oldCards.map(row => row._id))
        this._nextCursor = preserve ? oldCursor : result.nextCursor || ''
        this._cardsBusy = false
        this.setData({ cards, page: preserve ? oldPage : page, total: result.total, panelLoading: false, panelRefreshing: false,
          hasMore: preserve ? !!oldCursor : result.hasMore,
          pendingUpdates: preserve ? this.data.pendingUpdates || (result.list || []).some(row => !known.has(row._id)) || (!oldCursor && result.total > cards.length) : page > 1 ? this.data.pendingUpdates : false,
          ...(!preserve && page === 1 ? { cardsScrollTop: this._scrollTop || 1 } : {}) }, () => {
          if (!preserve && page === 1 && seq === this._panelSeq && !this._closed && !this._hidden) {
            this._scrollTop = 0; this.setData({ cardsScrollTop: 0 })
          }
        })
      }
      if (this._touchingCards || this.data.dragging || Date.now() < (this._touchUntil || 0)) {
        this._deferredCards = apply; this.flushCardUpdates()
      } else apply()
    } catch (error) {
      if (seq === this._panelSeq && !this._closed && !this._hidden) {
        this._cardsBusy = false
        this._failedCardPage = page
        this.setData({ panelLoading: false, panelRefreshing: false, panelError: error.message || '加载失败' })
      }
    }
  },
  cardTouchStart() { this._touchingCards = true },
  cardTouchEnd() { this._touchingCards = false; this._touchUntil = Date.now() + 300; this.flushCardUpdates() },
  flushCardUpdates() {
    clearTimeout(this._cardTimer)
    if (this._closed || this._hidden || !this._deferredCards || this._touchingCards || this.data.dragging) return
    this._cardTimer = setTimeout(() => {
      if (this._touchingCards || this.data.dragging) return
      const apply = this._deferredCards; this._deferredCards = null; apply?.()
    }, Math.max(0, (this._touchUntil || 0) - Date.now()))
  },
  cardsScrolled(e) { this._scrollTop = Number(e.detail.scrollTop) || 0 },
  more() { if (!this.interactionLocked() && !this._cardsBusy && !this.data.panelLoading && !this.data.panelError && this.data.hasMore) return this.loadCards(this.data.page + 1) },
  retryPanel() { if (!this.interactionLocked() && !this._cardsBusy) return this.loadCards(this.data.pendingUpdates ? 1 : this._failedCardPage || 1) },
  closePanel() {
    this._panelSeq++; this._nextCursor = ''; this._cardsBusy = false; this._deferredCards = null; this._touchingCards = false
    this._failedCardPage = 0
    clearTimeout(this._cardTimer); this.stopRefresh()
    this.setData({ selected: null, clusterChoices: null, cards: [], panelLoading: false, panelRefreshing: false, panelError: '', expanded: false, pendingUpdates: false,
      dragging: false, sheetOffset: 0, cardsScrollTop: 0 })
    this.renderMarkers()
  },
  toggleExpanded() { if (this.data.selected) this.setData({ expanded: !this.data.expanded }) },
  dragStart(e) {
    const point = e.touches?.[0]
    if (!this.data.selected || !point || this.interactionLocked()) return
    this._dragY = point.clientY; this._lastDragAt = 0; this.setData({ dragging: true, entering: false })
  },
  dragMove(e) {
    if (!this.data.dragging || !e.touches?.[0]) return
    const now = Date.now()
    if (now - this._lastDragAt < 20) return
    this._lastDragAt = now
    const delta = e.touches[0].clientY - this._dragY
    this.setData({ sheetOffset: Math.max(this.data.expanded ? -20 : -140, Math.min(230, delta)) })
  },
  dragEnd(e) {
    if (!this.data.dragging || !e.changedTouches?.[0]) { this.dragCancel(); return }
    const delta = e.changedTouches[0].clientY - this._dragY
    this.setData({ dragging: false, sheetOffset: 0 })
    if (delta < -45) this.setData({ expanded: true })
    else if (delta > 65) { if (this.data.expanded) this.setData({ expanded: false }); else this.closePanel() }
    this.flushCardUpdates()
  },
  dragCancel() { this.setData({ dragging: false, sheetOffset: 0 }); this.flushCardUpdates() },
  updateFilters(patch) {
    if (this.interactionLocked()) return
    this.cancelLocate(); this.saveViewport(); this._seq++; this._cameraSeq++; this.closePanel(); this._communities = []
    this.setData({ ...patch, markers: [], visibleCount: 0, communityCount: 0, unmatchedCount: 0 })
    this.restoreViewport(true); return this.refresh()
  },
  changeKind(e) { if (['all', 'normal', 'urgent'].includes(e.currentTarget.dataset.kind)) return this.updateFilters({ orderKind: e.currentTarget.dataset.kind }) },
  changeDate(e) { return this.updateFilters({ filterDate: e.detail.value }) },
  clearDate() { return this.updateFilters({ filterDate: '' }) },
  toggleRange() {
    if (!this.data.inServiceRange && !validPoint(this._reference)) { wx.showToast({ title: '请先选择参考位置', icon: 'none' }); return }
    return this.updateFilters({ inServiceRange: !this.data.inServiceRange })
  },
  toggleTime() { return this.updateFilters({ inServiceTime: !this.data.inServiceTime }) },
  toggleDirect() { return this.updateFilters({ onlyDirect: !this.data.onlyDirect }) },
  changeGender(e) { const i = Number(e.detail.value); if ([0, 1, 2].includes(i)) return this.updateFilters({ genderIndex: i, staffGenderRequirement: ['any', 'female', 'male'][i] }) },
  toggleMotion() { const reducedMotion = !this.data.reducedMotion; this.setData({ reducedMotion }); wx.setStorageSync('communityMapReducedMotion', reducedMotion) },
  moveCamera(patch) {
    const camera = { latitude: Number(this.data.latitude), longitude: Number(this.data.longitude), scale: Number(this.data.scale), ...this._viewport, ...patch }
    if (!validPoint(camera) || !Number.isFinite(camera.scale)) return
    this.cancelLocate()
    camera.scale = Math.max(5, Math.min(19, camera.scale))
    const seq = ++this._cameraSeq
    const repeatCenter = (patch.latitude !== undefined || patch.longitude !== undefined) && camera.latitude === this.data.latitude && camera.longitude === this.data.longitude
    this._fitted = true; this._region = null; this._viewport = camera
    this._cameraTarget = { ...camera, until: Date.now() + 1500 }
    this.setData({ ...camera, zoomScale: camera.scale }, () => {
      // A native gesture can move away while the last bound coordinates stay unchanged.
      if (repeatCenter && seq === this._cameraSeq) this._map?.moveToLocation?.({ latitude: camera.latitude, longitude: camera.longitude })
    })
    this.renderMarkers(); this.saveViewport()
  },
  async chooseReference() {
    if (this.interactionLocked()) return
    this.cancelLocate()
    let changed = false
    const choice = {}; this._locationChoice = choice; this._choosingReference = true
    this.setData({ choosingReference: true })
    try {
      await requirePrivacyAuthorize()
      if (this._closed || this._locationChoice !== choice) return
      const initial = validPoint(this._reference) ? this._reference : this._viewport || this.data
      const point = await new Promise((resolve, reject) => wx.chooseLocation({
        ...(validPoint(initial) ? { latitude: Number(initial.latitude), longitude: Number(initial.longitude) } : {}),
        success: resolve, fail: reject
      }))
      if (this._closed || this._locationChoice !== choice) return
      if (!validPoint(point)) throw new Error('位置信息无效，请重新选择')
      const city = locationCity(point) || this.data.city
      const reference = { latitude: Number(point.latitude), longitude: Number(point.longitude), name: point.name || '已选参考位置', city }
      this.saveViewport(); this._seq++; this.closePanel(); this._communities = []
      this._entryReference = reference; this._reference = reference
      if (this.data.mode === 'orders') {
        this._orderReference = reference
        this.getOpenerEventChannel?.()?.emit?.('communityMapReferenceChanged', {
          reference: { latitude: reference.latitude, longitude: reference.longitude }, city
        })
      } else saveSelectedLocation({ ...point, city, locationSource: 'manual' })
      this.setData({ city, hasReference: true, referenceName: reference.name, markers: [], visibleCount: 0, communityCount: 0, unmatchedCount: 0 })
      this._cityDraft = city; this._viewportKey = this.viewKey()
      this.moveCamera({ latitude: reference.latitude, longitude: reference.longitude, scale: 15 })
      changed = true
    } catch (error) {
      if (!this._closed && this._locationChoice === choice && !/cancel/i.test(error?.errMsg || error?.message || '')) showError(error)
    } finally {
      if (!this._closed && this._locationChoice === choice) {
        this._choosingReference = false; this._locationChoice = null; this.setData({ choosingReference: false })
        if (!this._hidden) {
          if (!this._initialized || this.data.checkingIdentity || choice.interrupted) await this.initialize()
          else if (changed) await this.refresh()
        }
      }
    }
  },
  cancelLocate() {
    this._locateSeq = (this._locateSeq || 0) + 1
    if (this.data.locating) this.setData({ locating: false })
  },
  async locate() {
    if (this.interactionLocked() || this.data.mapError || this.data.locating) return
    const seq = this._locateSeq = (this._locateSeq || 0) + 1
    // Late data must not fit the camera while a requested GPS fix is pending.
    this.setData({ locating: true })
    try {
      const point = await getCurrentLocation()
      if (seq !== this._locateSeq || this.interactionLocked()) return
      this.closePanel()
      this.moveCamera({ latitude: Number(point.latitude), longitude: Number(point.longitude) })
    } catch (error) { if (seq === this._locateSeq && !this._hidden && !this._closed) showError(error) }
    finally {
      if (seq === this._locateSeq && !this._closed) {
        this.setData({ locating: false })
        this.fitCommunities()
      }
    }
  },
  returnToReference() {
    if (this.interactionLocked() || !validPoint(this._reference)) return
    this.closePanel()
    this.moveCamera({ latitude: Number(this._reference.latitude), longitude: Number(this._reference.longitude) })
  },
  zoom(e) {
    if (this.interactionLocked()) return
    const step = Number(e.currentTarget.dataset.step), scale = Number(this._viewport?.scale ?? this.data.scale)
    if (![1, -1].includes(step) || !Number.isFinite(scale)) return
    this.moveCamera({ scale: Math.max(5, Math.min(19, scale + step)) })
  },
  mapFailed() { this.cancelLocate(); this._cameraSeq++; this._map = null; this.closePanel(); this.setData({ mapError: true, clusterChoices: null }) },
  retryMap() {
    if (this._closed || this._hidden) return
    this._cameraSeq++
    this.setData({ mapError: false, ...(validPoint(this._viewport) ? { ...this._viewport, zoomScale: this._viewport.scale } : {}) }, () => {
      this._mapRetryTimer = setTimeout(() => {
        if (!this._closed && !this._hidden && !this.data.mapError) { this.createMap(); this.renderMarkers() }
      }, 50)
    })
  },
  listView() {
    if (this._closed || this._hidden || this.data.submitting || this.data.confirmingOrderId || this.data.acceptRisk) return
    const route = this.data.mode === 'orders' ? 'pages/staff/home/index' : 'pages/client/sitters/list/index'
    const pages = getCurrentPages()
    for (let i = pages.length - 2; i >= 0; i--) {
      if (pages[i].route === route) { wx.navigateBack({ delta: pages.length - 1 - i }); return }
    }
    wx.redirectTo({ url: '/' + route })
  },
  detail(e) {
    if (this.interactionLocked() || !this.data.cards.some(row => row._id === e.currentTarget.dataset.id)) return
    const id = encodeURIComponent(e.currentTarget.dataset.id)
    wx.navigateTo({ url: this.data.mode === 'orders' ? `/pages/staff/orders/detail/index?id=${id}` : `/pages/client/sitters/detail/index?id=${id}&staffGenderRequirement=${this.data.staffGenderRequirement}` })
  },
  async book(e) {
    if (this.interactionLocked() || this._cardsBusy || this.data.mode !== 'sitters') return
    const id = e.currentTarget.dataset.id, sitter = this.data.cards.find(row => row._id === id)
    if (!sitter || sitter.canDirectBook === false || sitter.acceptDirectOrders === false) return
    this._seq++; this.setData({ submitting: id, loading: false })
    const op = ++this._opSeq
    try {
      await ensureLogin({ content: '登录后可指定预约宠托师', isActive: () => this.operationCurrent(op) })
      if (this.operationCurrent(op)) wx.navigateTo({ url: `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${encodeURIComponent(id)}&staffGenderRequirement=${this.data.staffGenderRequirement}` })
    } catch (_) {} finally { if (this.operationCurrent(op)) this.setData({ submitting: '' }) }
  },
  async grab(e) {
    if (this.interactionLocked() || this._cardsBusy || this.data.mode !== 'orders' || !this.data.canFindOrders) return
    const id = e.currentTarget.dataset.id
    if (!this.data.cards.some(row => row._id === id)) return
    this._seq++; this.setData({ submitting: id, loading: false })
    const op = ++this._opSeq
    try {
      await requestSubscribeTemplates(['staffDirectOrder', 'upcomingServiceReminder', 'serviceProgress'], 'community_map_grab').catch(() => null)
      if (!this.operationCurrent(op)) return
      const risk = await callFunction('staff', 'checkAcceptOrderRisk', { orderId: id })
      if (!this.operationCurrent(op)) return
      if (risk?.requiresConfirmation) { this.setData({ acceptRisk: risk, pendingOrderId: id, riskStep: 1, riskAgreed: false, submitting: '' }); return }
      await this.submitGrab(id, false, op)
    } catch (error) { if (this.operationCurrent(op)) showError(error) }
    finally { if (this.operationCurrent(op)) this.setData({ submitting: '' }) }
  },
  async submitGrab(id, riskConfirmed, op = ++this._opSeq) {
    if (!this.operationCurrent(op) || this.data.mode !== 'orders' || !this.data.canFindOrders || !this.data.cards.some(row => row._id === id)) return
    this._seq++; this.setData({ submitting: id, loading: false })
    let attempted = false
    try {
      const location = await getCurrentLocation()
      if (!this.operationCurrent(op)) return
      attempted = true; this._grabAttempt = { id, op }
      await callFunction('staff', 'acceptOrder', { orderId: id, riskConfirmed, currentLatitude: location.latitude, currentLongitude: location.longitude })
      if (!this.operationCurrent(op)) return
      this._grabAttempt = null
      this.setData({ successOrderId: id }); this.closeRisk()
      wx.showToast({ title: '接单成功', icon: 'success' }); await this.refresh(true)
    } catch (error) {
      if (!this.operationCurrent(op)) return
      if (!attempted) { showError(error); return }
      // An RPC failure may arrive after the assignment committed. Resolve ownership before retry.
      let result
      try { result = await callFunction('staff', 'getGrabResult', { orderId: id }) } catch (_) {}
      if (!this.operationCurrent(op)) return
      if (result) this._grabAttempt = null
      if (result?.state === 'assigned') {
        this.setData({ successOrderId: id }); this.closeRisk(); wx.showToast({ title: '已确认接单成功', icon: 'none' }); await this.refresh(true)
      } else if (result) { this.closeRisk(); showError(error); await this.refresh(true) }
      else { this.closeRisk(); this.setData({ confirmingOrderId: id }); wx.showToast({ title: '接单结果待确认，请勿重复提交', icon: 'none' }) }
    } finally {
      if (this._grabAttempt?.op === op) this._grabAttempt = null
      if (this.operationCurrent(op)) this.setData({ submitting: '' })
    }
  },
  async confirmGrabResult() {
    const id = this.data.confirmingOrderId
    if (!id || this.data.submitting || this.data.checkingIdentity || this._hidden || this._closed) return
    this._seq++; this.setData({ submitting: id, loading: false })
    const op = ++this._opSeq
    try {
      const result = await callFunction('staff', 'getGrabResult', { orderId: id })
      if (!this.operationCurrent(op)) return
      this.setData({ confirmingOrderId: '', ...(result.state === 'assigned' ? { successOrderId: id } : {}) })
      wx.showToast({ title: result.state === 'assigned' ? '已确认接单成功' : result.state === 'available' ? '尚未接单，可重新尝试' : '该任务当前不可接', icon: 'none' })
      await this.refresh(true)
    } catch (_) { if (this.operationCurrent(op)) wx.showToast({ title: '仍在确认，请稍后重试', icon: 'none' }) }
    finally { if (this.operationCurrent(op)) this.setData({ submitting: '' }) }
  },
  closeRisk() { if (!this._closed) this.setData({ acceptRisk: null, pendingOrderId: '', riskStep: 1, riskAgreed: false }) },
  nextRisk() { this.setData({ riskStep: 2 }) },
  agreeRisk() { this.setData({ riskAgreed: !this.data.riskAgreed }) },
  confirmRisk() { if (this.data.riskAgreed && !this.data.submitting && !this.data.checkingIdentity && !this.data.confirmingOrderId) return this.submitGrab(this.data.pendingOrderId, true) },
  successDetail() { if (this.data.successOrderId) wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + encodeURIComponent(this.data.successOrderId) }) },
  noop() {}
})
