const { callFunction, showError } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
Page({
  data: { rows: [], loading: false, busy: false, error: '', hasMore: false, form: null },
  onShow() { this._closed = false; if (this.data.busy && !this._savePending) this.setData({ busy: false }); return this.load() },
  onHide() { this._closed = true; this._request = (this._request || 0) + 1 },
  onUnload() { this._unloaded = true; this.onHide() },
  async load(e) {
    if (this.data.busy) return
    const more = e && e.currentTarget && e.currentTarget.dataset.more
    if (more && (this.data.loading || !this.data.hasMore)) return
    const request = this._request = (this._request || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('memorial', 'listGardensAdmin', { cursor: more ? this._cursor : '' })
      if (this._closed || request !== this._request) return
      this._cursor = result.cursor
      this.setData({ rows: (more ? this.data.rows : []).concat(result.list.map(r => ({ ...r, createdText: formatDateTime(r.createdAt) || '原有纪念园' }))), hasMore: result.hasMore })
    } catch (error) { if (!this._closed && request === this._request) this.setData({ error: error.message || '读取失败' }) }
    finally { if (!this._closed && request === this._request) this.setData({ loading: false }) }
  },
  create() {
    if (this.data.busy || !(this.data.adminSuper || (this.data.adminPermissions || {}).memorial_createGarden)) return
    this.setData({ form: { name: '', accepting: true, requestId: 'garden_' + Date.now() + '_' + Math.random().toString(36).slice(2) } })
  },
  edit(e) {
    if (this.data.busy || !(this.data.adminSuper || (this.data.adminPermissions || {}).memorial_updateGarden)) return
    const row = this.data.rows.find(r => r.id === e.currentTarget.dataset.id)
    if (row) this.setData({ form: { id: row.id, revision: row.revision, name: row.name, accepting: row.accepting } })
  },
  input(e) { if (!this.data.busy) this.setData({ 'form.name': e.detail.value }) },
  accepting(e) { if (!this.data.busy) this.setData({ 'form.accepting': e.detail.value }) },
  close() { if (!this.data.busy) this.setData({ form: null }) },
  async save() {
    if (this.data.busy || !this.data.form) return
    const form = this.data.form
    if (!form.name.trim()) { showError(new Error('请填写纪念园名称')); return }
    this.setData({ busy: true })
    this._savePending = true
    try {
      await callFunction('memorial', form.id ? 'updateGarden' : 'createGarden', form)
      if (this._closed) { this._savedWhileHidden = true; return }
      this.setData({ form: null, busy: false }); wx.showToast({ title: '纪念园已保存', icon: 'success' }); await this.load()
    } catch (error) { if (!this._closed) showError(error) }
    finally { this._savePending = false; if (!this._unloaded) this.setData({ busy: false, ...(this._savedWhileHidden ? { form: null } : {}) }); this._savedWhileHidden = false }
  },
  visit(e) { wx.navigateTo({ url: '/packageMemorial/pages/garden?gardenId=' + encodeURIComponent(e.currentTarget.dataset.id) }) }
})
