const { poseLabel } = require('../scene/memorial-portrait-layout')
const { callFunction } = require('../../utils/cloud')
const { prepareImage } = require('../../utils/image-upload')
const { plotNumber } = require('../scene/plot-number')
const yearsMod = require('../scene/memorial-years') || {}
const buildMemorialYearOptions = yearsMod.buildMemorialYearOptions || (() => [{ value: 'unknown', label: '未知' }])
const yearOptionIndex = yearsMod.yearOptionIndex || (() => 0)
const validateMemorialYearRange = yearsMod.validateMemorialYearRange || (() => '')
const formatMemorialLifeSpan = yearsMod.formatMemorialLifeSpan || (() => '')
const MEMORY_YEAR_OPTIONS = buildMemorialYearOptions()
const native = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }))
const reviewLabel = (status, isPublic) => ({ pending: isPublic ? '公开回忆待审核' : '文字修改待审核', private: '仅自己可见', approved: isPublic ? '回忆已公开' : '文字已审核 · 仅自己可见', rejected: '请调整后重新提交', empty: '尚未整理回忆' }[status] || '')
const copyPrologue = value => value && typeof value === 'object' ? { id: value.id || 'prologue', title: value.title || '序章', text: value.text || '' } : null
const novelToPlainText = value => [
  ...(value && value.prologue ? [['序章 · ' + (value.prologue.title || '序章'), value.prologue.text || ''].filter(Boolean).join('\n')] : []),
  ...((value && value.chapters) || []).map((chapter, index) => ['第 ' + (index + 1) + ' 章 · ' + (chapter.title || '未命名章节'), chapter.text || ''].filter(Boolean).join('\n'))
].filter(Boolean).join('\n\n')
const copyContent = value => ({ ...(value || {}), mode: value && value.mode === 'novel' ? 'novel' : 'plain', text: value && value.text || '',
  prologue: copyPrologue(value && value.prologue), chapters: (value && value.chapters || []).map((chapter, index) => ({ id: chapter.id || 'chapter-' + index, title: chapter.title || '', text: chapter.text || '' })), images: (value && value.images || []).map(m => ({ ...m })),
  videos: (value && value.videos || []).map(m => ({ ...m })), music: value && value.music ? { ...value.music } : null })
const contentKey = (value, isPublic) => JSON.stringify([!!isPublic, value && value.mode || 'plain', value && value.text || '',
  value && value.prologue ? [value.prologue.id, value.prologue.title, value.prologue.text] : null,
  (value && value.chapters || []).map(chapter => [chapter.id, chapter.title, chapter.text]),
  ...['images', 'videos'].map(kind => (value && value[kind] || []).map(m => [m.uploadId, !!m.entrance])), value && value.music && value.music.uploadId || null])
const changeContent = (value, change) => !value ? value : { ...value, [change.kind]: change.operation === 'remove'
  ? (value[change.kind] || []).filter(m => m.uploadId !== change.uploadId)
  : (value[change.kind] || []).map(m => m.uploadId === change.uploadId ? { ...m, entrance: change.enabled } : m) }
Page({
  data: { loading: true, saving: false, uploading: false, error: '', detail: null, editing: false, previewing: false,
    managing: false, managementError: '', demolitionConfirmVisible: false, demolitionConfirmName: '', demolitionExpectedName: '', demolitionConfirmError: '', mediaSaving: false, mediaSavingId: '', mediaSaveError: '', hasUnsavedChanges: false,
    yearOptions: MEMORY_YEAR_OPTIONS, birthYearIndex: 0, passingYearIndex: 0, editBirthYear: 'unknown', editPassingYear: 'unknown', editLifeSpanPreview: '',
    yearSaving: false, yearError: '', hasYearChanges: false,
    textCount: 0, portrait: null, portraitForm: false, portraitPhotos: {}, portraitNote: '', portraitPose: 'sitting',
    draft: { mode: 'plain', text: '', prologue: null, chapters: [], images: [], videos: [], music: null }, hasPrologue: false, isPublic: false, playing: false, uploadTip: '',
    readerChapterIndex: 0, readerPageIndex: 0, readerPageCount: 1, readerChapterTitle: '', readerSectionLabel: '', readerSectionCount: 0, readerIsPrologue: false, readerPageText: '', readerCanPrev: false, readerCanNext: false },
  onLoad(options = {}) { this._alive = true; this.id = options.id || ''; this.load() },
  onHide() { this._confirmVersion = (this._confirmVersion || 0) + 1; this._demolitionConfirmVersion = null; this._demolitionTarget = null; this.setData({ demolitionConfirmVisible: false, demolitionConfirmName: '', demolitionExpectedName: '', demolitionConfirmError: '' }); this.stopMusic() },
  onUnload() { this._alive = false; this._demolitionConfirmVersion = null; this._demolitionTarget = null; if (this._uploadTask && this._uploadTask.abort) this._uploadTask.abort(); this.stopMusic(); if (this.audio) this.audio.destroy() },
  api(action, data) { return callFunction('memorial', action, { id: this.id, ...data }) },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const detail = await this.api('detail')
      if (!this._alive) return
      if (detail.owner) this.loadPortrait()
      const yearOptions = buildMemorialYearOptions()
      const editBirthYear = detail.birthYear || 'unknown'
      const editPassingYear = detail.passingYear || 'unknown'
      const hasYearChanges = editBirthYear !== (detail.birthYear || 'unknown') || editPassingYear !== (detail.passingYear || 'unknown')
      this._prologueBackup = null
      this._novelBackup = null
      this._demolitionConfirmVersion = null
      this._demolitionTarget = null
      this.setData({ detail, demolished: false, demolitionConfirmVisible: false, demolitionConfirmName: '', demolitionExpectedName: '', demolitionConfirmError: '', plotNumber: plotNumber(detail.plotId), draft: copyContent(detail.draft), isPublic: detail.isPublic,
        yearOptions, editBirthYear, editPassingYear,
        birthYearIndex: yearOptionIndex(yearOptions, editBirthYear),
        passingYearIndex: yearOptionIndex(yearOptions, editPassingYear),
        editLifeSpanPreview: formatMemorialLifeSpan(editBirthYear, editPassingYear),
        yearError: '', hasYearChanges,
        hasUnsavedChanges: false, mediaSaveError: '', textCount: this.contentLength(detail.draft), hasPrologue: !!(detail.draft && detail.draft.prologue), story: detail.story, reviewLabel: reviewLabel(detail.reviewStatus, detail.isPublic) })
      this.syncReader(detail.owner ? detail.draft : detail.story)
    } catch (error) { if (this._alive) this.setData({ error: error.message || '回忆加载失败，请重试' }) }
    finally { if (this._alive) this.setData({ loading: false }) }
  },
  updateEditYear(field, value) {
    if (!this.data.detail || !this.data.detail.owner || this.data.managing || this.data.yearSaving) return
    if (!['birthYear', 'passingYear'].includes(field)) return
    const editBirthYear = field === 'birthYear' ? value : (this.data.editBirthYear || 'unknown')
    const editPassingYear = field === 'passingYear' ? value : (this.data.editPassingYear || 'unknown')
    const options = this.data.yearOptions || MEMORY_YEAR_OPTIONS
    const hasYearChanges = editBirthYear !== (this.data.detail.birthYear || 'unknown') || editPassingYear !== (this.data.detail.passingYear || 'unknown')
    this.setData({
      editBirthYear,
      editPassingYear,
      birthYearIndex: yearOptionIndex(options, editBirthYear),
      passingYearIndex: yearOptionIndex(options, editPassingYear),
      editLifeSpanPreview: formatMemorialLifeSpan(editBirthYear, editPassingYear),
      yearError: '',
      hasYearChanges
    })
  },
  chooseYear(e) {
    const field = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.field
    const options = this.data.yearOptions || MEMORY_YEAR_OPTIONS
    const picked = options[Number(e && e.detail && e.detail.value)] || options[0]
    this.updateEditYear(field, picked ? picked.value : 'unknown')
  },
  setYearUnknown(e) {
    const field = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.field
    this.updateEditYear(field, 'unknown')
  },
  async saveYears() {
    const detail = this.data.detail
    if (!this._alive || !detail || !detail.owner || this.data.managing || this.data.yearSaving || !this.data.hasYearChanges) return
    const birthYear = this.data.editBirthYear || 'unknown'
    const passingYear = this.data.editPassingYear || 'unknown'
    const rangeError = validateMemorialYearRange(birthYear, passingYear)
    if (rangeError) {
      this.setData({ yearError: rangeError })
      return
    }
    this.setData({ yearSaving: true, yearError: '' })
    try {
      const saved = await this.api('updateYears', { birthYear, passingYear })
      if (!this._alive) return
      const nextBirth = (saved && saved.birthYear) || birthYear
      const nextPassing = (saved && saved.passingYear) || passingYear
      const lifeSpanText = (saved && saved.lifeSpanText) || formatMemorialLifeSpan(nextBirth, nextPassing)
      const options = this.data.yearOptions || MEMORY_YEAR_OPTIONS
      this.setData({
        detail: { ...detail, birthYear: nextBirth, passingYear: nextPassing, lifeSpanText },
        editBirthYear: nextBirth,
        editPassingYear: nextPassing,
        birthYearIndex: yearOptionIndex(options, nextBirth),
        passingYearIndex: yearOptionIndex(options, nextPassing),
        editLifeSpanPreview: lifeSpanText,
        hasYearChanges: false
      })
      wx.showToast({ title: '年份已更新', icon: 'none' })
    } catch (error) {
      if (this._alive) this.setData({ yearError: (error && error.message) || '年份保存失败，请重试' })
    } finally {
      if (this._alive) this.setData({ yearSaving: false })
    }
  },
  async manageMemorial(e) {
    const detail = this.data.detail, operation = e.currentTarget.dataset.operation
    if (!detail || !detail.owner || this.data.managing || this.data.saving || this.data.uploading || this.data.mediaSaving || this.data.demolitionConfirmVisible) return
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
      this._demolitionConfirmVersion = version
      this._demolitionTarget = { id: this.id, petName: detail.petName, locationRevision: detail.locationRevision || 0 }
      this.setData({ demolitionConfirmVisible: true, demolitionConfirmName: '', demolitionExpectedName: detail.petName, demolitionConfirmError: '' })
    } catch (error) { if (this._alive) this.setData({ managementError: error.message || '操作失败，请重试' }) }
    finally { if (this._alive) this.setData({ managing: false }) }
  },
  inputDemolitionName(e) {
    if (!this.data.demolitionConfirmVisible || this.data.managing) return
    this.setData({ demolitionConfirmName: e.detail.value, demolitionConfirmError: '' })
  },
  cancelDemolition() {
    if (this.data.managing) return
    this._demolitionConfirmVersion = null
    this._demolitionTarget = null
    this.setData({ demolitionConfirmVisible: false, demolitionConfirmName: '', demolitionExpectedName: '', demolitionConfirmError: '' })
  },
  async confirmDemolition() {
    const target = this._demolitionTarget
    const version = this._demolitionConfirmVersion
    if (!this._alive || !this.data.demolitionConfirmVisible || !target || target.id !== this.id || !this.data.detail || !this.data.detail.owner || this.data.managing || this.data.saving || this.data.uploading || this.data.mediaSaving || version !== (this._confirmVersion || 0)) return
    const confirmName = String(this.data.demolitionConfirmName || '').normalize('NFKC').trim()
    if (!confirmName) { this.setData({ demolitionConfirmError: '请输入宠物名字后再确认拆除。' }); return }
    if (confirmName !== target.petName) { this.setData({ demolitionConfirmError: '名字不匹配，请核对后重试。' }); return }
    this.setData({ managing: true, demolitionConfirmError: '' })
    try {
      const demolitionKey = target.id + ':' + target.locationRevision
      if (this._demolitionKey !== demolitionKey) { this._demolitionKey = demolitionKey; this._demolitionRequest = '' }
      this._demolitionRequest = this._demolitionRequest || 'remove_' + Date.now() + '_' + Math.random().toString(36).slice(2)
      const removed = await this.api('demolish', { locationRevision: target.locationRevision, requestId: this._demolitionRequest, confirm: true, confirmName })
      if (!this._alive || version !== (this._confirmVersion || 0)) return
      this._demolitionConfirmVersion = null
      this._demolitionTarget = null
      this.setData({ recoverUntilText: require('../scene/recovery-time').deadline(removed.recoverUntil), demolitionConfirmVisible: false, demolitionConfirmName: '', demolitionExpectedName: '', demolitionConfirmError: '' })
      this.stopMusic()
      this.setData({ detail: null, story: null, draft: { text: '', images: [], videos: [], music: null }, portrait: null, demolished: true })
      wx.showToast({ title: '小筑已拆除', icon: 'none' })
    } catch (error) {
      if (this._alive && version === (this._confirmVersion || 0)) this.setData({ demolitionConfirmError: error.message || '操作失败，请重试' })
    } finally { if (this._alive) this.setData({ managing: false }) }
  },
  noop() {},
  onShow() { if (this._refreshOnReturn) { this._refreshOnReturn = false; this.load() } },
  openRecycle() { wx.redirectTo({ url: '/packageMemorial/pages/recycle' }) },
  chooseGarden() { wx.redirectTo({ url: '/packageMemorial/pages/entrance' }) },
  focusEditor() {
    if (typeof wx === 'undefined' || typeof wx.pageScrollTo !== 'function') return
    wx.pageScrollTo({ selector: '#memory-editor', offsetTop: -16, duration: 280 })
  },
  edit() {
    if (!this.data.detail || !this.data.detail.owner || this.data.managing || this.data.uploading || this.data.saving || this.data.mediaSaving) return
    this.stopMusic()
    if (this.data.editing) { this.focusEditor(); return }
    this.setData({ editing: true, previewing: false }, () => {
      // The editor is conditionally rendered, so scroll after setData has
      // committed the new view tree.
      this.focusEditor()
    })
  },
  finishEditing() { if (!this.data.saving && !this.data.uploading && !this.data.mediaSaving) { this.setData({ editing: false }); this.syncReader(this.data.draft) } },
  preview() { this.stopMusic(); this.setData({ editing: false, previewing: true, story: this.data.detail.story }); this.syncReader(this.data.detail.story) },
  closePreview() { this.stopMusic(); this.setData({ previewing: false }); this.syncReader(this.data.draft) },
  updateDirty() {
    const detail = this.data.detail
    this.setData({ hasUnsavedChanges: !!detail && contentKey(this.data.draft, this.data.isPublic) !== contentKey(detail.draft, detail.isPublic) })
  },
  contentLength(value) {
    if (!value || value.mode !== 'novel') return Array.from(value && value.text || '').length
    const prologue = value.prologue ? Array.from(value.prologue.title || '').length + Array.from(value.prologue.text || '').length : 0
    return prologue + (value.chapters || []).reduce((sum, chapter) => sum + Array.from(chapter.title || '').length + Array.from(chapter.text || '').length, 0)
  },
  selectFormat(e) {
    if (this.data.saving || this.data.uploading || this.data.mediaSaving) return
    const mode = e.currentTarget.dataset.mode
    if (!['plain', 'novel'].includes(mode) || mode === this.data.draft.mode) return
    if (mode === 'novel') {
      const restore = this._novelBackup && this.data.draft.text === novelToPlainText(this._novelBackup)
      const prologue = restore ? this._novelBackup.prologue : this.data.draft.prologue
      const chapters = restore ? this._novelBackup.chapters : (this.data.draft.chapters.length ? this.data.draft.chapters : [{ id: this.newChapterId(), title: '相遇', text: this.data.draft.text }])
      this._novelBackup = null
      this.setData({ 'draft.mode': mode, 'draft.prologue': prologue, 'draft.chapters': chapters, hasPrologue: !!prologue, textCount: this.contentLength({ mode, prologue, chapters }) })
    } else {
      const novel = this.data.draft.mode === 'novel' ? copyContent(this.data.draft) : null
      const text = novel ? novelToPlainText(novel) : this.data.draft.text
      if (novel) this._novelBackup = novel
      this._prologueBackup = null
      this.setData({ 'draft.mode': mode, 'draft.text': text, 'draft.prologue': null, 'draft.chapters': [], hasPrologue: false, textCount: this.contentLength({ mode, text }) })
    }
    this.updateDirty()
  },
  newChapterId() { return 'chapter-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) },
  newPrologueId() { return 'prologue-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) },
  togglePrologue(e) {
    if (this.data.saving || this.data.uploading || this.data.mediaSaving || this.data.draft.mode !== 'novel') return
    const enabled = !!(e && e.detail && e.detail.value)
    if (!enabled && this.data.draft.prologue) this._prologueBackup = { ...this.data.draft.prologue }
    const prologue = enabled ? (this.data.draft.prologue || this._prologueBackup || { id: this.newPrologueId(), title: '序章', text: '' }) : null
    if (enabled) this._prologueBackup = null
    this.setData({ 'draft.prologue': prologue, hasPrologue: enabled, textCount: this.contentLength({ mode: 'novel', prologue, chapters: this.data.draft.chapters }) })
    this.updateDirty()
  },
  inputPrologueTitle(e) {
    if (this.data.saving || !this.data.draft.prologue) return
    const prologue = { ...this.data.draft.prologue, title: e.detail.value }
    this.setData({ 'draft.prologue': prologue, textCount: this.contentLength({ mode: 'novel', prologue, chapters: this.data.draft.chapters }) }); this.updateDirty()
  },
  inputPrologueText(e) {
    if (this.data.saving || !this.data.draft.prologue) return
    const prologue = { ...this.data.draft.prologue, text: e.detail.value }
    this.setData({ 'draft.prologue': prologue, textCount: this.contentLength({ mode: 'novel', prologue, chapters: this.data.draft.chapters }) }); this.updateDirty()
  },
  input(e) { if (!this.data.saving) { this.setData({ 'draft.text': e.detail.value, textCount: Array.from(e.detail.value).length }); this.updateDirty() } },
  inputChapterTitle(e) {
    if (this.data.saving) return
    const index = Number(e.currentTarget.dataset.index), chapters = this.data.draft.chapters.slice()
    if (!chapters[index]) return
    chapters[index] = { ...chapters[index], title: e.detail.value }
    this.setData({ 'draft.chapters': chapters, textCount: this.contentLength({ mode: 'novel', prologue: this.data.draft.prologue, chapters }) }); this.updateDirty()
  },
  inputChapterText(e) {
    if (this.data.saving) return
    const index = Number(e.currentTarget.dataset.index), chapters = this.data.draft.chapters.slice()
    if (!chapters[index]) return
    chapters[index] = { ...chapters[index], text: e.detail.value }
    this.setData({ 'draft.chapters': chapters, textCount: this.contentLength({ mode: 'novel', prologue: this.data.draft.prologue, chapters }) }); this.updateDirty()
  },
  addChapter() {
    if (this.data.saving || this.data.uploading || this.data.mediaSaving || this.data.draft.chapters.length >= 100) return
    const chapters = this.data.draft.chapters.concat({ id: this.newChapterId(), title: '', text: '' })
    this.setData({ 'draft.chapters': chapters, textCount: this.contentLength({ mode: 'novel', prologue: this.data.draft.prologue, chapters }) }); this.updateDirty()
  },
  removeChapter(e) {
    if (this.data.saving || this.data.uploading || this.data.mediaSaving) return
    const index = Number(e.currentTarget.dataset.index), chapters = this.data.draft.chapters.filter((_, i) => i !== index)
    if (!chapters.length) chapters.push({ id: this.newChapterId(), title: '', text: '' })
    this.setData({ 'draft.chapters': chapters, textCount: this.contentLength({ mode: 'novel', prologue: this.data.draft.prologue, chapters }) }); this.updateDirty()
  },
  readerSections(content) {
    if (!content || content.mode !== 'novel') return []
    return (content.prologue ? [{ ...content.prologue, isPrologue: true }] : []).concat((content.chapters || []).map(chapter => ({ ...chapter, isPrologue: false })))
  },
  readerLabel(section, index, hasPrologue = this._readerHasPrologue) { return section && section.isPrologue ? '序章' : '第 ' + (index + 1 - (hasPrologue ? 1 : 0)) + ' 章' },
  syncReader(content) {
    const sections = this.readerSections(content)
    this._readerHasPrologue = !!(content && content.prologue)
    if (!sections.length) {
      this.setData({ readerChapterIndex: 0, readerPageIndex: 0, readerPageCount: 1, readerSectionCount: 0, readerSectionLabel: '', readerIsPrologue: false, readerPageText: '', readerChapterTitle: '', readerCanPrev: false, readerCanNext: false }); return
    }
    const chapter = sections[0], pages = this.splitPages(chapter.text || '')
    this.setData({ readerChapterIndex: 0, readerPageIndex: 0, readerPageCount: pages.length, readerSectionCount: sections.length, readerSectionLabel: this.readerLabel(chapter, 0), readerIsPrologue: !!chapter.isPrologue, readerPageText: pages[0], readerChapterTitle: chapter.title || (chapter.isPrologue ? '序章' : '未命名章节'), readerCanPrev: false, readerCanNext: pages.length > 1 || sections.length > 1 })
  },
  splitPages(text) { const chars = Array.from(text || ''), pages = []; for (let i = 0; i < chars.length; i += 150) pages.push(chars.slice(i, i + 150).join('')); return pages.length ? pages : [''] },
  moveReader(e) {
    const content = this.data.detail && (this.data.detail.owner && !this.data.previewing ? this.data.draft : this.data.story)
    const sections = this.readerSections(content)
    this._readerHasPrologue = !!(content && content.prologue)
    if (!sections.length) return
    const direction = e.currentTarget.dataset.direction === 'next' ? 1 : -1
    let chapterIndex = this.data.readerChapterIndex, pageIndex = this.data.readerPageIndex
    const pages = this.splitPages(sections[chapterIndex].text)
    if (direction > 0 && pageIndex + 1 < pages.length) pageIndex++
    else if (direction < 0 && pageIndex > 0) pageIndex--
    else { chapterIndex += direction; if (chapterIndex < 0 || chapterIndex >= sections.length) return; pageIndex = direction > 0 ? 0 : this.splitPages(sections[chapterIndex].text).length - 1 }
    const chapter = sections[chapterIndex], nextPages = this.splitPages(chapter.text)
    this.setData({ readerChapterIndex: chapterIndex, readerPageIndex: pageIndex, readerPageCount: nextPages.length, readerSectionLabel: this.readerLabel(chapter, chapterIndex), readerIsPrologue: !!chapter.isPrologue, readerPageText: nextPages[pageIndex], readerChapterTitle: chapter.title || (chapter.isPrologue ? '序章' : '未命名章节'),
      readerCanPrev: chapterIndex > 0 || pageIndex > 0, readerCanNext: pageIndex + 1 < nextPages.length || chapterIndex + 1 < sections.length })
  },
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
        reviewLabel: reviewLabel(result.reviewStatus, detail.isPublic) })
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
        : await native('chooseMedia', { count: Math.min(9, max - this.data.draft[field].length), mediaType: [kind], sourceType: ['album'] })
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
    // Clone the editor state before awaiting the network request. This keeps
    // the submitted novel contents stable if an input event arrives while
    // the request is in flight.
    const draft = copyContent(this.data.draft)
    try {
      const saved = await this.api('saveMemory', { revision: this.data.detail.revision, mediaRevision: this.data.detail.mediaRevision || 0, mode: draft.mode, text: draft.text,
        prologue: draft.mode === 'novel' ? draft.prologue : null, chapters: draft.mode === 'novel' ? draft.chapters : undefined, isPublic: this.data.isPublic,
        images: draft.images.map(m => m.uploadId), videos: draft.videos.map(m => m.uploadId), music: draft.music && draft.music.uploadId,
        entranceImages: draft.images.filter(m => m.entrance).map(m => m.uploadId), entranceVideos: draft.videos.filter(m => m.entrance).map(m => m.uploadId) })
      if (!this._alive) return
      this._prologueBackup = null
      this._novelBackup = null
      this.setData({ editing: false }); await this.load()
      if (this._alive) wx.showToast({ title: saved.status === 'pending' ? (this.data.isPublic ? '已保存，等待管理员审核' : '文字修改已保存，等待管理员审核') : '已保存，仅自己可见', icon: 'none' })
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
