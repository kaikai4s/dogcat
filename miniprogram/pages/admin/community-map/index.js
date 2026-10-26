const { callFunction, showError, requirePrivacyAuthorize } = require('../../../utils/cloud')
const { validPoint, communityLocationFields } = require('./location')
const { createClientRequestId } = require('../../../utils/offlineQueue')
const empty = () => ({ name: '', city: '', district: '', aliasesText: '', latitude: 0, longitude: 0, enabled: true, matchRadiusKm: 1, confirmPublic: false })
Page({
  data: { view: 'pending', city: '', keyword: '', rows: [], total: 0, hasMore: false, missingCityCount: 0,
    form: null, rejectForm: null, advanced: false, choosing: false, busy: false, loading: false, error: '' },
  onShow() { if (!this._choosing && !this.data.form && !this.data.rejectForm) return this.load() },
  onUnload() { this._closed = true; this._seq = (this._seq || 0) + 1; this._formToken = null; this._editToken = null },
  async load(append = false) {
    append = append === true
    if (this._closed || (append && (this.data.loading || !this.data.hasMore))) return
    this.cancelEditLookup()
    const seq = this._seq = (this._seq || 0) + 1
    const offset = append ? this._nextOffset || this.data.rows.length : 0
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('communityMap', 'listAdmin', { view: this.data.view, city: this.data.city, keyword: this.data.keyword, offset, paginated: true })
      if (this._closed || seq !== this._seq) return
      this._nextOffset = offset + result.list.length
      const rows = append ? [...this.data.rows, ...result.list] : result.list
      this.setData({ rows: [...new Map(rows.map(row => [row._id, row])).values()], total: result.total, hasMore: result.hasMore, missingCityCount: result.missingCityCount || 0 })
    } catch (error) { if (!this._closed && seq === this._seq) this.setData({ error: error.message || '加载失败，请重试' }) }
    finally { if (!this._closed && seq === this._seq) this.setData({ loading: false }) }
  },
  more() { return this.load(true) },
  changeView(e) {
    if (this.data.view === e.currentTarget.dataset.view) return
    this.setData({ view: e.currentTarget.dataset.view, rows: [], hasMore: false, total: 0 }); return this.load()
  },
  inputKeyword(e) { this._keyword = e.detail.value },
  search() { this.setData({ keyword: String(this._keyword ?? this.data.keyword).trim(), rows: [], total: 0, hasMore: false }); return this.load() },
  changeCity(e) {
    const values = e.detail.value || []
    const city = !values[1] || values[1] === '市辖区' || values[1] === '县' ? values[0] : values[1]
    this.setData({ city: city || '', rows: [], total: 0, hasMore: false }); return this.load()
  },
  clearCity() { this.setData({ city: '', rows: [], total: 0, hasMore: false }); return this.load() },
  cancelEditLookup() { if (this._editToken) { this._editToken = null; this.setData({ busy: false }) } },
  openForm(form) {
    if (this._closed || this.data.rejectForm || (this.data.busy && !this._editToken)) return
    this.cancelEditLookup()
    this._formToken = {}; this._saveRequest = null; this.setData({ form, advanced: false })
  },
  add() { this.openForm({ ...empty(), city: this.data.city }) },
  addCandidate(e) {
    const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    if (row) this.openForm({ ...empty(), name: row.name, city: row.city, district: row.district || '', applicationIds: row.applicationIds || [] })
  },
  edit(e) {
    const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    if (row) this.openForm({ ...row, id: row._id, aliasesText: (row.aliases || []).join('\n'), confirmPublic: false })
  },
  async editExisting(e) {
    const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    if (!row?.existingId || this.data.busy) return
    const token = this._editToken = {}
    this.setData({ busy: true })
    try {
      const result = await callFunction('communityMap', 'listAdmin', { id: row.existingId, paginated: true })
      if (this._closed || token !== this._editToken) return
      const existing = result.list[0]
      if (!existing) throw new Error('小区资料已变化，请刷新')
      this.openForm({ ...existing, id: existing._id, aliasesText: (existing.aliases || []).join('\n'), confirmPublic: false,
        applicationIds: row.applicationIds || [] })
    } catch (error) { if (!this._closed && token === this._editToken) showError(error) }
    finally { if (!this._closed && token === this._editToken) { this._editToken = null; this.setData({ busy: false }) } }
  },
  close() { if (!this.data.busy && !this.data.choosing) { this._formToken = null; this.setData({ form: null }) } },
  input(e) {
    const field = e.currentTarget.dataset.field
    if (!this.data.busy && ['name', 'city', 'district', 'aliasesText', 'matchRadiusKm'].includes(field)) this.setData({ ['form.' + field]: e.detail.value, 'form.confirmPublic': false })
  },
  toggleAdvanced() { this.setData({ advanced: !this.data.advanced }) },
  toggleEnabled(e) { if (!this.data.busy) this.setData({ 'form.enabled': e.detail.value, 'form.confirmPublic': false }) },
  confirm() { if (this.data.form && !this.data.busy) this.setData({ 'form.confirmPublic': !this.data.form.confirmPublic }) },
  async choose() {
    if (this.data.busy || this._choosing || !this.data.form) return
    const token = this._formToken, form = this.data.form
    this._choosing = true; this.setData({ choosing: true })
    try {
      await requirePrivacyAuthorize()
      if (this._closed || token !== this._formToken) return
      const point = await new Promise((resolve, reject) => wx.chooseLocation({
        ...(validPoint(form) ? { latitude: Number(form.latitude), longitude: Number(form.longitude) } : {}), success: resolve, fail: reject
      }))
      if (this._closed || token !== this._formToken) return
      if (!validPoint(point)) throw new Error('请选择有效的小区公共入口')
      const fields = communityLocationFields(point)
      const city = fields.city || form.city
      this.setData({ 'form.latitude': fields.latitude, 'form.longitude': fields.longitude,
        'form.name': form.name || fields.name, 'form.city': city, 'form.district': fields.district || (city === form.city ? form.district : ''),
        'form.confirmPublic': false })
    } catch (error) { if (!this._closed && !/cancel/i.test(error?.errMsg || error?.message || '')) showError(error) }
    finally { this._choosing = false; if (!this._closed) this.setData({ choosing: false }) }
  },
  async save() {
    const form = this.data.form
    if (this.data.busy || this.data.choosing || !form?.confirmPublic) return
    if (!form.name.trim() || !form.city.trim() || !validPoint(form)) { showError(new Error('请选择公共入口，并核对小区名称和城市')); return }
    const payload = { ...form, aliases: form.aliasesText.split(/[\n,，]/).map(v => v.trim()).filter(Boolean) }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== this._saveRequest?.fingerprint) this._saveRequest = { fingerprint, requestId: createClientRequestId('community') }
    this.setData({ busy: true })
    try {
      await callFunction('communityMap', 'saveAdmin', { ...payload, requestId: this._saveRequest.requestId })
      if (this._closed) return
      this._formToken = null; this.setData({ form: null }); wx.showToast({ title: '已保存，后续自动匹配', icon: 'none' }); await this.load()
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  canRejectApplications() { return !!(this.data.adminSuper || this.data.adminPermissions?.communityMap_rejectApplication) },
  rejectCandidate(e) {
    if (this._closed || this.data.busy || this.data.form || this.data.rejectForm || !this.canRejectApplications()) return
    const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id)
    if (this.data.view !== 'pending' || !row?.applicationIds?.length) return
    this.setData({ rejectForm: { name: row.name, applicationIds: [...row.applicationIds], reason: '' } })
  },
  inputRejectReason(e) { if (!this.data.busy && this.data.rejectForm) this.setData({ 'rejectForm.reason': e.detail.value }) },
  closeReject() { if (!this.data.busy) this.setData({ rejectForm: null }) },
  async submitReject() {
    const form = this.data.rejectForm
    if (this._closed || this.data.busy || !form?.applicationIds?.length || !this.canRejectApplications()) return
    const reason = String(form.reason || '').trim()
    if (!reason || reason.length > 200) { showError(new Error('请填写驳回原因，最多200字')); return }
    this.setData({ busy: true })
    try {
      const confirmation = await new Promise((resolve, reject) => wx.showModal({
        title: '确认永久驳回申请？', content: '驳回后，相关用户永久不可再次申请该小区。仅处理用户申请，不删除订单或宠托师地址候选。',
        confirmText: '确认驳回', confirmColor: '#b34232', success: resolve, fail: reject
      }))
      if (this._closed || !confirmation.confirm || !this.canRejectApplications()) return
      const result = await callFunction('communityMap', 'rejectApplication', { applicationIds: form.applicationIds, reason })
      if (this._closed) return
      this.setData({ rejectForm: null })
      wx.showToast({ title: `已驳回 ${result.rejectedCount || 0} 项申请`, icon: 'none' })
      await this.load()
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  noop() {}
})
