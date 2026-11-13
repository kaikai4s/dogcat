const { poseLabel } = require('../scene/memorial-portrait-layout')
const { callFunction } = require('../../utils/cloud')
const { prepareImage } = require('../../utils/image-upload')
const { plotNumber } = require('../scene/plot-number')
const native = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }))
const reviewLabel = status => ({ pending: '公开回忆待审核', private: '仅自己可见', approved: '回忆已公开', rejected: '请调整后重新提交', empty: '尚未整理回忆' }[status] || '')
const copyContent = value => ({ ...(value || {}), text: value && value.text || '', images: (value && value.images || []).map(m => ({ ...m })),
  videos: (value && value.videos || []).map(m => ({ ...m })), music: value && value.music ? { ...value.music } : null })
const contentKey = (value, isPublic) => JSON.stringify([!!isPublic, value && value.text || '',
  ...['images', 'videos'].map(kind => (value && value[kind] || []).map(m => [m.uploadId, !!m.entrance])), value && value.music && value.music.uploadId || null])
const changeContent = (value, change) => !value ? value : { ...value, [change.kind]: change.operation === 'remove'
  ? (value[change.kind] || []).filter(m => m.uploadId !== change.uploadId)
  : (value[change.kind] || []).map(m => m.uploadId === change.uploadId ? { ...m, entrance: change.enabled } : m) }
Page({
  data: { loading: true, saving: false, uploading: false, error: '', detail: null, editing: false, previewing: false,
    managing: false, managementError: '', mediaSaving: false, mediaSavingId: '', mediaSaveError: '', hasUnsavedChanges: false,
    textCount: 0, portrait: null, portraitForm: false, portraitPhotos: {}, portraitNote: '', portraitPose: 'sitting',
    draft: { text: '', images: [], videos: [], music: null }, isPublic: false, playing: false, uploadTip: '' },
  onLoad(options = {}) { this._alive = true; this.id = options.id || ''; this.load() },
  onHide() { this._confirmVersion = (this._confirmVersion || 0) + 1; this.stopMusic() },
  onUnload() { this._alive = false; if (this._uploadTask && this._uploadTask.abort) this._uploadTask.abort(); this.stopMusic(); if (this.audio) this.audio.destroy() },
  api(action, data) { return callFunction('memorial', action, { id: this.id, ...data }) },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const detail = await this.api('detail')
      if (!this._alive) return
      if (detail.owner) this.loadPortrait()
      this.setData({ detail, demolished: false, plotNumber: plotNumber(detail.plotId), draft: copyContent(detail.draft), isPublic: detail.isPublic,
        hasUnsavedChanges: false, mediaSaveError: '', textCount: Array.from(detail.draft && detail.draft.text || '').length, story: detail.story, reviewLabel: reviewLabel(detail.reviewStatus) })
    } catch (error) { if (this._alive) this.setData({ error: error.message || '回忆加载失败，请重试' }) }
    finally { if (this._alive) this.setData({ loading: false }) }
  },
  async manageMemorial(e) {
    const detail = this.data.detail, operation = e.currentTarget.dataset.operation
    if (!detail || !detail.owner || this.data.managing || this.data.saving || this.data.uploading || this.data.mediaSaving) return
    if (!['relocate', 'demolish'].includes(operation)) return
    const version = this._confirmVersion || 0
    const active = () => this._alive && version === (this._confirmVersion || 0)
    this.setData({ managing: true, managementError: '' })
    try {
      if (operation === 'relocate') {
        if (this.data.hasUnsavedChanges) {
          const answer = await native('showModal', { title: '还有未保存的回忆', content: '继续迁移会离开编辑页，请先保存希望保留的修改。', confirmText: '继续迁移' })
          if (!answer.confirm || !active()) return
        }
        await native('navigateTo', { url: '/packageMemorial/pages/entrance?moveId=' + encodeURIComponent(this.id) })
        this._refreshOnReturn = true
        return
      }
      const answer = await native('showModal', { title: '确认拆除时光小筑？', content: '拆除后小筑将从园区移除，原位置立即释放。全部内容保留 7 天，可在回收站恢复；超过期限将永久清除。', confirmText: '继续拆除', confirmColor: '#ad514a' })
      if (!answer.confirm || !active()) return
      if (!this._alive) return
      const typed = await native('showModal', { title: '再次确认拆除', content: '请输入宠物名字“' + detail.petName + '”确认。拆除 7 天后，回忆、照片、视频、音乐、画像、鲜花和零食记录将永久丢失。', editable: true, placeholderText: '输入完整宠物名字', confirmText: '确认拆除', confirmColor: '#ad514a' })
      if (!typed.confirm || !active()) return
      const confirmName = String(typed.content || '').normalize('NFKC').trim()
      if (confirmName !== detail.petName) { this.setData({ managementError: '名字不匹配，请重新点击拆除并输入完整宠物名字。' }); return }
      const demolitionKey = this.id + ':' + (detail.locationRevision || 0)
      if (this._demolitionKey !== demolitionKey) { this._demolitionKey = demolitionKey; this._demolitionRequest = '' }
      this._demolitionRequest = this._demolitionRequest || 'remove_' + Date.now() + '_' + Math.random().toString(36).slice(2)
      const removed = await this.api('demolish', { locationRevision: detail.locationRevision || 0, requestId: this._demolitionRequest, confirm: true, confirmName })
      if (!this._alive) return
      this.setData({ recoverUntilText: require('../scene/recovery-time').deadline(removed.recoverUntil) })
      this.stopMusic()
      this.setData({ detail: null, story: null, draft: { text: '', images: [], videos: [], music: null }, portrait: null, demolished: true })
      wx.showToast({ title: '小筑已拆除', icon: 'none' })
    } catch (error) { if (this._alive) this.setData({ managementError: error.message || '操作失败，请重试' }) }
    finally { if (this._alive) this.setData({ managing: false }) }
  },
  onShow() { if (this._refreshOnReturn) { this._refreshOnReturn = false; this.load() } },
  openRecycle() { wx.redirectTo({ url: '/packageMemorial/pages/recycle' }) },
  chooseGarden() { wx.redirectTo({ url: '/packageMemorial/pages/entrance' }) },
  edit() { if (this.data.detail && this.data.detail.owner && !this.data.saving && !this.data.mediaSaving) { this.stopMusic(); this.setData({ editing: true, previewing: false }) } },
  finishEditing() { if (!this.data.saving && !this.data.uploading && !this.data.mediaSaving) this.setData({ editing: false }) },
  preview() { this.stopMusic(); this.setData({ editing: false, previewing: true, story: this.data.detail.story }) },
  closePreview() { this.stopMusic(); this.setData({ previewing: false }) },
  updateDirty() {
    const detail = this.data.detail
    this.setData({ hasUnsavedChanges: !!detail && contentKey(this.data.draft, this.data.isPublic) !== contentKey(detail.draft, detail.isPublic) })
  },
  input(e) { if (!this.data.saving) { this.setData({ 'draft.text': e.detail.value, textCount: Array.from(e.detail.value).length }); this.updateDirty() } },
  privacy(e) { if (!this.data.saving) { this.setData({ isPublic: e.detail.value }); this.updateDirty() } },
  async toggleEntrance(e) {
    if (!this._alive || this.data.saving || this.data.uploading || this.data.mediaSaving || !this.data.detail || !this.data.detail.owner) return
    const { kind, id } = e.currentTarget.dataset
    if (!['images', 'videos'].includes(kind)) return
    const item = this.data.draft[kind].find(m => m.uploadId === id)
    if (item) await this.updateMedia({ kind, uploadId: id, operation: 'entrance', enabled: !item.entrance })
  },
  async remove(e) {
    if (!this._alive || this.data.saving || this.data.uploading || this.data.mediaSaving || !this.data.detail || !this.data.detail.owner) return
    this.stopMusic()
    const { kind, index } = e.currentTarget.dataset
    if (kind === 'music') { this.setData({ 'draft.music': null }); this.updateDirty() }
    else if (['images', 'videos'].includes(kind)) {
      const item = this.data.draft[kind][Number(index)]
      if (item) await this.updateMedia({ kind, uploadId: item.uploadId, operation: 'remove' })
    }
  },
  async updateMedia(change) {
    if (!this._alive || this.data.saving || this.data.uploading || this.data.mediaSaving || !this.data.detail || !this.data.detail.owner) return
    const detail = this.data.detail
    const saved = (detail.draft && detail.draft[change.kind] || []).some(m => m.uploadId === change.uploadId)
    if (!saved) {
      // Newly uploaded files belong only to this unsaved edit. Selection must
      // not publish them; removal simply discards them from the pending edit.
      this.setData({ draft: changeContent(this.data.draft, change), mediaSaveError: '' }); this.updateDirty()
      wx.showToast({ title: change.operation === 'remove' ? '已移除' : change.enabled ? '提交并审核通过后展示' : '已取消入口展示', icon: 'none' })
      return
    }
    this.setData({ mediaSaving: true, mediaSavingId: change.uploadId, mediaSaveError: '' })
    try {
      const result = await this.api('updateMemoryMedia', { ...change, revision: detail.revision, mediaRevision: detail.mediaRevision || 0 })
      if (!this._alive) return
      // Merge the single acknowledged operation without replacing unsaved text,
      // uploads or privacy edits with a freshly fetched server draft.
      this.setData({ draft: changeContent(this.data.draft, change),
        detail: { ...detail, ...result, draft: changeContent(detail.draft, change) }, story: result.story,
        reviewLabel: reviewLabel(result.reviewStatus) })
      this.updateDirty()
      const shown = result.story && (result.story[change.kind] || []).some(m => m.uploadId === change.uploadId && m.entrance)
      wx.showToast({ title: change.operation === 'remove' ? '已移除，立即生效' : !change.enabled ? '已取消入口展示' : shown ? '已在入口展示' : '设置已保存，公开审核通过后展示', icon: 'none' })
    } catch (error) {
      if (this._alive) { this.setData({ mediaSaveError: error.message || '操作未确认，请重试' }); wx.showToast({ title: error.message || '操作未确认，请重试', icon: 'none' }) }
    } finally { if (this._alive) this.setData({ mediaSaving: false, mediaSavingId: '' }) }
  },
  async addMedia(e) {
    if (!this._alive || this.data.uploading || this.data.saving || this.data.mediaSaving || !this.data.detail || !this.data.detail.owner) return
    const kind = e.currentTarget.dataset.kind
    if (!['image', 'video', 'music'].includes(kind)) return
    const field = kind === 'image' ? 'images' : 'videos', max = kind === 'image' ? 12 : 6
    if (kind !== 'music' && this.data.draft[field].length >= max) return
    this.setData({ uploading: true, uploadTip: '选择文件…' })
    try {
      const selected = kind === 'music'
        ? await native('chooseMessageFile', { count: 1, type: 'file', extension: ['mp3', 'm4a', 'wav'] })
        : await native('chooseMedia', { count: Math.min(9, max - this.data.draft[field].length), mediaType: [kind], sourceType: ['album'], maxDuration: 300 })
      for (const [index, file] of (selected.tempFiles || []).entries()) {
        if (!this._alive) return
        this.setData({ uploadTip: '正在上传第 ' + (index + 1) + ' 个文件…' })
        let path = file.tempFilePath || file.path, extension, size = file.size
        if (kind === 'image') { const image = await prepareImage(path); path = image.filePath; extension = image.extension.slice(1); size = image.size }
        else {
          const match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(file.name || path)
          extension = match ? match[1].toLowerCase() : kind === 'video' ? 'mp4' : ''
        }
        if (!this._alive) return
        const ticket = await this.api('prepareMedia', { kind, extension, name: file.name || (kind === 'image' ? '回忆照片' : '回忆视频') + '.' + extension })
        if (size > ticket.maxBytes) throw new Error(kind === 'video' ? '每段视频最多 30MB' : '背景音乐最多 10MB')
        if (!this._alive) return
        const uploaded = await new Promise((resolve, reject) => {
          this._uploadTask = wx.cloud.uploadFile({ cloudPath: ticket.cloudPath, filePath: path, success: resolve, fail: reject })
        })
        if (!this._alive) return
        const media = await this.api('finishMedia', { uploadId: ticket.uploadId, fileId: uploaded.fileID })
        if (!this._alive) return
        const item = { ...media, url: path }
        if (kind === 'music') this.setData({ 'draft.music': item })
        else this.setData({ ['draft.' + field]: this.data.draft[field].concat(item) })
        this.updateDirty()
      }
    } catch (error) { if (this._alive && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || error.errMsg || '上传失败，请重试', icon: 'none' }) }
    finally { if (this._alive) this.setData({ uploading: false, uploadTip: '' }); this._uploadTask = null }
  },
  async save() {
    if (!this._alive || this.data.saving || this.data.uploading || this.data.mediaSaving || !this.data.detail || !this.data.detail.owner) return
    if (contentKey(this.data.draft, this.data.isPublic) === contentKey(this.data.detail.draft, this.data.detail.isPublic)) {
      wx.showToast({ title: '没有需要保存的修改', icon: 'none' }); return
    }
    this.setData({ saving: true })
    const draft = this.data.draft
    try {
      await this.api('saveMemory', { revision: this.data.detail.revision, mediaRevision: this.data.detail.mediaRevision || 0, text: draft.text, isPublic: this.data.isPublic,
        images: draft.images.map(m => m.uploadId), videos: draft.videos.map(m => m.uploadId), music: draft.music && draft.music.uploadId,
        entranceImages: draft.images.filter(m => m.entrance).map(m => m.uploadId), entranceVideos: draft.videos.filter(m => m.entrance).map(m => m.uploadId) })
      if (!this._alive) return
      this.setData({ editing: false }); await this.load()
      if (this._alive) wx.showToast({ title: this.data.isPublic ? '已保存，公开内容待审核' : '已保存，仅自己可见', icon: 'none' })
    } catch (error) { if (this._alive) wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' }) }
    finally { if (this._alive) this.setData({ saving: false }) }
  },
  async loadPortrait() {
    try {
      const portrait = await this.api('portraitDetail')
      if (!this._alive) return
      this.setData({ portrait, portraitPoseLabel: poseLabel(portrait.pose), portraitError: '', portraitLabel: { empty: '还没有申请画像', pending: '已收到申请 · 等待审核员制作', approved: '专属画像已安放', rejected: '请调整照片后重新申请' }[portrait.status] || '' })
    } catch (error) { if (this._alive) this.setData({ portraitError: error.message || '画像申请暂时无法读取' }) }
  },
  openPortrait() {
    if (this.data.uploading || this.data.saving || !this.data.portrait || this.data.portrait.status === 'pending') return
    const photos = this.data.portrait.photos || []
    this.setData({ portraitForm: true, portraitPhotos: { front: photos[0] || null, side: photos[1] || null }, portraitNote: this.data.portrait.note || '', portraitPose: this.data.portrait.pose === 'sleeping' ? 'sleeping' : 'sitting' })
  },
  closePortrait() { if (!this.data.uploading && !this.data.saving) this.setData({ portraitForm: false }) },
  selectPortraitPose(e) {
    const pose = e.currentTarget.dataset.pose
    if (!this.data.saving && !this.data.uploading && ['sitting', 'sleeping'].includes(pose)) this.setData({ portraitPose: pose })
  },
  inputPortraitNote(e) { if (!this.data.saving) this.setData({ portraitNote: e.detail.value }) },
  async addPortraitPhoto(e) {
    const side = e.currentTarget.dataset.side
    if (!this._alive || !['front', 'side'].includes(side) || this.data.saving || this.data.uploading || !this.data.detail.owner) return
    this.setData({ uploading: true, uploadTip: '选择宠物照片…' })
    try {
      const selected = await native('chooseMedia', { count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] })
      if (!this._alive || !selected.tempFiles || !selected.tempFiles[0]) return
      const image = await prepareImage(selected.tempFiles[0].tempFilePath)
      if (!this._alive) return
      this.setData({ uploadTip: '正在上传' + (side === 'front' ? '正面' : '侧面') + '照片…' })
      const ticket = await this.api('prepareMedia', { kind: 'image', extension: image.extension.slice(1), name: side === 'front' ? '宠物正面照' : '宠物侧面照' })
      if (!this._alive) return
      const uploaded = await new Promise((resolve, reject) => { this._uploadTask = wx.cloud.uploadFile({ cloudPath: ticket.cloudPath, filePath: image.filePath, success: resolve, fail: reject }) })
      if (!this._alive) return
      const media = await this.api('finishMedia', { uploadId: ticket.uploadId, fileId: uploaded.fileID })
      if (this._alive) this.setData({ ['portraitPhotos.' + side]: { ...media, url: image.filePath } })
    } catch (error) { if (this._alive && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '照片上传失败', icon: 'none' }) }
    finally { this._uploadTask = null; if (this._alive) this.setData({ uploading: false, uploadTip: '' }) }
  },
  async submitPortrait() {
    if (!this._alive || this.data.uploading || this.data.saving || !this.data.detail.owner || !this.data.portrait) return
    const photos = this.data.portraitPhotos
    if (!photos.front || !photos.side) return
    this.setData({ saving: true })
    try {
      await this.api('submitPortrait', { revision: this.data.portrait.revision, front: photos.front.uploadId, side: photos.side.uploadId, note: this.data.portraitNote, pose: this.data.portraitPose })
      if (!this._alive) return
      this.setData({ portraitForm: false }); await this.loadPortrait()
      if (this._alive) wx.showToast({ title: '画像制作申请已提交', icon: 'none' })
    } catch (error) { if (this._alive) wx.showToast({ title: error.message || '提交失败，请重试', icon: 'none' }) }
    finally { if (this._alive) this.setData({ saving: false }) }
  },
  showImage(e) {
    const content = this.data.editing ? this.data.draft : this.data.previewing || !this.data.detail.owner ? this.data.story : this.data.draft
    const urls = (content && content.images || []).map(m => m.url).filter(Boolean)
    if (urls.length) wx.previewImage({ urls, current: e.currentTarget.dataset.url })
  },
  playMusic(e) {
    if (this.data.playing) { this.stopMusic(); return }
    const src = e.currentTarget.dataset.url
    if (!src) return
    if (!this.audio) {
      this.audio = wx.createInnerAudioContext()
      this.audio.onEnded(() => { if (this._alive) this.setData({ playing: false }) })
      this.audio.onError(() => { if (this._alive) { this.setData({ playing: false }); wx.showToast({ title: '音乐暂不可播放，请重新打开回忆后重试', icon: 'none' }) } })
    }
    this.audio.src = src; this.audio.play(); this.setData({ playing: true })
  },
  stopMusic() { if (this.audio) this.audio.pause(); if (this._alive) this.setData({ playing: false }) }
})
