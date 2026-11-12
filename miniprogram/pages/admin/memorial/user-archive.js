const { callFunction, showError } = require('../../../utils/cloud')
const { plotNumber } = require('./plot-number')
const { formatBeijingDate, formatBeijingClock } = require('../../../utils/format')
const date = value => value ? (formatBeijingDate(value) + ' ' + formatBeijingClock(value)) : '未记录'
Page({
  data: { openid: '', rows: [], loading: false, more: false, error: '', selected: null, detailLoading: false, detailError: '', content: null, playingUrl: '' },
  onLoad(options = {}) { this.setData({ openid: options.openid || '' }); this._focusId = options.id || '' },
  onShow() { this._closed = false; this.setData({ playingUrl: '' }); if (this.data.selected) this.openContent({ currentTarget: { dataset: { id: this.data.selected } } }); return this.load() },
  onHide() { this._closed = true; this._request = (this._request || 0) + 1; this._detailRequest = (this._detailRequest || 0) + 1; this.stopAudio() },
  onUnload() { this.onHide() },
  async load(e) {
    if (!this.data.openid) { this.setData({ error: '缺少用户信息，请从用户资料进入' }); return }
    const more = e && e.currentTarget && e.currentTarget.dataset.more
    if (more && (this.data.loading || !this.data.more)) return
    const request = this._request = (this._request || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('memorial', 'listUserMemorialsAdmin', { openid: this.data.openid, cursor: more ? this._cursor : '' })
      if (this._closed || request !== this._request) return
      this._cursor = result.cursor
      this.setData({ rows: (more ? this.data.rows : []).concat(result.list.map(r => ({ ...r, plotNumber: plotNumber(r.plotId), createdText: date(r.createdAt), reviewedText: date(r.reviewedAt), statusText: { pending: '待审核', approved: '已安放', rejected: '需调整' }[r.status] }))), more: result.hasMore })
      if (this._focusId && (this.data.adminSuper || (this.data.adminPermissions || {}).memorial_getMemorialAdmin)) { const id = this._focusId; this._focusId = ''; await this.openContent({ currentTarget: { dataset: { id } } }) }
    } catch (error) { if (!this._closed && request === this._request) this.setData({ error: error.message || '读取失败' }) }
    finally { if (!this._closed && request === this._request) this.setData({ loading: false }) }
  },
  async openContent(e) {
    if (!(this.data.adminSuper || (this.data.adminPermissions || {}).memorial_getMemorialAdmin)) return
    const id = e.currentTarget.dataset.id || this.data.selected
    const request = this._detailRequest = (this._detailRequest || 0) + 1
    this.stopAudio(); this.setData({ selected: id, content: null, detailLoading: true, detailError: '' })
    try {
      const content = await callFunction('memorial', 'getMemorialAdmin', { id })
      if (this._closed || request !== this._detailRequest) return
      if (content.ownerOpenid !== this.data.openid) throw new Error('这处小筑不属于当前用户')
      this.setData({ content: { ...content, memoryTime: date(content.memoryUpdatedAt), memoryLabel: { empty: '尚未整理', private: '仅主人可见', pending: '公开审核中', approved: '已审核', rejected: '需调整' }[content.reviewStatus], portraitLabel: { empty: '未申请', pending: '制作中', approved: '已安放', rejected: '需调整' }[content.portrait && content.portrait.status] || '未申请' } })
    } catch (error) { if (!this._closed && request === this._detailRequest) this.setData({ detailError: error.message || '内容读取失败' }) }
    finally { if (!this._closed && request === this._detailRequest) this.setData({ detailLoading: false }) }
  },
  closeContent() { this._detailRequest = (this._detailRequest || 0) + 1; this.stopAudio(); this.setData({ selected: null, content: null, detailLoading: false }) },
  profile() { if (this.data.adminSuper || (this.data.adminPermissions || {}).admin_getUserDetail) wx.navigateTo({ url: '/pages/admin/users/edit/index?openid=' + encodeURIComponent(this.data.openid) }) },
  locate(e) { const row = this.data.rows.find(r => r._id === e.currentTarget.dataset.id); if (row) wx.navigateTo({ url: '/packageMemorial/pages/garden?gardenId=' + encodeURIComponent(row.gardenId) + '&plotId=' + encodeURIComponent(row.plotId) }) },
  previewImage(e) { const c = this.data.content; if (!c) return; const urls = [c.draft, c.story].flatMap(m => m && m.images || []).concat(c.portrait && c.portrait.photos || [], c.portrait && c.portrait.result || []).map(m => m.url).filter(Boolean); wx.previewImage({ urls: [...new Set(urls)], current: e.currentTarget.dataset.url }) },
  stopAudio() { if (this._audio) this._audio.destroy(); this._audio = null; if (!this._closed) this.setData({ playingUrl: '' }) },
  playAudio(e) { const url = e.currentTarget.dataset.url, previous = this.data.playingUrl; this.stopAudio(); if (!url || url === previous) return; const audio = this._audio = wx.createInnerAudioContext(); audio.onError(() => { if (this._audio === audio && !this._closed) { this.stopAudio(); showError(new Error('音乐未能播放，请重新读取内容')) } }); audio.onEnded(() => { if (this._audio === audio) this.stopAudio() }); audio.src = url; audio.play(); this.setData({ playingUrl: url }) }
})
