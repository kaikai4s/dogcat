const { poseLabel } = require('../scene/memorial-portrait-layout')
const { callFunction } = require('../../utils/cloud')
const { prepareImage } = require('../../utils/image-upload')
const { plotNumber } = require('../scene/plot-number')
const native = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }))
Page({
  data: { loading: true, saving: false, uploading: false, error: '', detail: null, editing: false, previewing: false,
    textCount: 0, portrait: null, portraitForm: false, portraitPhotos: {}, portraitNote: '', portraitPose: 'sitting',
    draft: { text: '', images: [], videos: [], music: null }, isPublic: false, playing: false, uploadTip: '' },
  onLoad(options = {}) { this._alive = true; this.id = options.id || ''; this.load() },
  onHide() { this.stopMusic() },
  onUnload() { this._alive = false; if (this._uploadTask && this._uploadTask.abort) this._uploadTask.abort(); this.stopMusic(); if (this.audio) this.audio.destroy() },
  api(action, data) { return callFunction('memorial', action, { id: this.id, ...data }) },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const detail = await this.api('detail')
      if (!this._alive) return
      if (detail.owner) this.loadPortrait()
      this.setData({ detail, plotNumber: plotNumber(detail.plotId), draft: detail.draft || { text: '', images: [], videos: [], music: null }, isPublic: detail.isPublic,
        textCount: Array.from(detail.draft && detail.draft.text || '').length, story: detail.story, reviewLabel: { pending: '公开回忆待审核', private: '仅自己可见', approved: '回忆已公开', rejected: '请调整后重新提交', empty: '尚未整理回忆' }[detail.reviewStatus] || '' })
    } catch (error) { if (this._alive) this.setData({ error: error.message || '回忆加载失败，请重试' }) }
    finally { if (this._alive) this.setData({ loading: false }) }
  },
  edit() { if (this.data.detail && this.data.detail.owner && !this.data.saving) { this.stopMusic(); this.setData({ editing: true, previewing: false }) } },
  finishEditing() { if (!this.data.saving && !this.data.uploading) this.setData({ editing: false }) },
  preview() { this.stopMusic(); this.setData({ editing: false, previewing: true, story: this.data.detail.story }) },
  closePreview() { this.stopMusic(); this.setData({ previewing: false }) },
  input(e) { if (!this.data.saving) this.setData({ 'draft.text': e.detail.value, textCount: Array.from(e.detail.value).length }) },
  privacy(e) { if (!this.data.saving) this.setData({ isPublic: e.detail.value }) },
  toggleEntrance(e) {
    if (this.data.saving || this.data.uploading || !this.data.detail || !this.data.detail.owner) return
    const { kind, id } = e.currentTarget.dataset
    if (!['images', 'videos'].includes(kind)) return
    this.setData({ ['draft.' + kind]: this.data.draft[kind].map(m => m.uploadId === id ? { ...m, entrance: !m.entrance } : m) })
  },
  remove(e) {
    if (this.data.saving || this.data.uploading) return
    this.stopMusic()
    const { kind, index } = e.currentTarget.dataset
    if (kind === 'music') this.setData({ 'draft.music': null })
    else if (['images', 'videos'].includes(kind)) this.setData({ ['draft.' + kind]: this.data.draft[kind].filter((_, i) => i !== Number(index)) })
  },
  async addMedia(e) {
    if (!this._alive || this.data.uploading || this.data.saving || !this.data.detail || !this.data.detail.owner) return
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
      }
    } catch (error) { if (this._alive && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || error.errMsg || '上传失败，请重试', icon: 'none' }) }
    finally { if (this._alive) this.setData({ uploading: false, uploadTip: '' }); this._uploadTask = null }
  },
  async save() {
    if (!this._alive || this.data.saving || this.data.uploading || !this.data.detail || !this.data.detail.owner) return
    this.setData({ saving: true })
    const draft = this.data.draft
    try {
      await this.api('saveMemory', { revision: this.data.detail.revision, text: draft.text, isPublic: this.data.isPublic,
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
