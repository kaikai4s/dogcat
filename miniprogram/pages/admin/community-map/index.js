const { callFunction, showError, chooseSelectedLocation } = require('../../../utils/cloud')
const empty = () => ({ name: '', city: '', district: '', aliasesText: '', latitude: 0, longitude: 0, enabled: true, matchRadiusKm: 1, confirmPublic: false })
Page({
  data: { rows: [], form: null, busy: false, loading: false, error: '' },
  onShow() { this.load() },
  async load() {
    this.setData({ loading: true, error: '' })
    try { const rows = await callFunction('communityMap', 'listAdmin'); this.setData({ rows }) }
    catch (error) { this.setData({ error: error.message }) } finally { this.setData({ loading: false }) }
  },
  add() { this.setData({ form: empty() }) },
  edit(e) { const row = this.data.rows.find(item => item._id === e.currentTarget.dataset.id); if (row) this.setData({ form: { ...row, id: row._id, aliasesText: row.aliases.join('\n'), confirmPublic: false } }) },
  close() { if (!this.data.busy) this.setData({ form: null }) },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }) },
  toggleEnabled(e) { this.setData({ 'form.enabled': e.detail.value }) },
  confirm() { this.setData({ 'form.confirmPublic': !this.data.form.confirmPublic }) },
  async choose() {
    try { const point = await chooseSelectedLocation(); this.setData({ 'form.latitude': point.latitude, 'form.longitude': point.longitude, 'form.confirmPublic': false }) }
    catch (error) { if (!String(error.errMsg || '').includes('cancel')) showError(error) }
  },
  async save() {
    if (this.data.busy || !this.data.form?.confirmPublic) return
    this.setData({ busy: true })
    try {
      const form = this.data.form
      await callFunction('communityMap', 'saveAdmin', { ...form, aliases: form.aliasesText.split(/[\n,，]/).map(v => v.trim()).filter(Boolean) })
      this.setData({ form: null }); wx.showToast({ title: '已保存公共小区' }); await this.load()
    } catch (error) { showError(error) } finally { this.setData({ busy: false }) }
  }
})
