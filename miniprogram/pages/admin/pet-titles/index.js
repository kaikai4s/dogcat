const { callFunction, showError } = require('../../../utils/cloud')

const COLOR_PALETTE = [
  { name: '皇家金', hex: '#d99200' },
  { name: '白银银', hex: '#8e9aaf' },
  { name: '梦幻粉', hex: '#ff4d6d' },
  { name: '星空蓝', hex: '#409eff' },
  { name: '翡翠绿', hex: '#67c23a' },
  { name: '赤焰红', hex: '#ff3300' },
  { name: '霓虹紫', hex: '#b5179e' },
  { name: '典雅黑', hex: '#333333' }
]

const EFFECT_OPTIONS = [
  { key: 'none', name: '无特效' },
  { key: 'gold_shine', name: '金光流耀' },
  { key: 'silver_shine', name: '银辉流光' },
  { key: 'pink_dream', name: '粉梦流光' },
  { key: 'blue_diamond', name: '蓝钻流光' },
  { key: 'emerald_glow', name: '翡翠流光' },
  { key: 'fire_glow', name: '烈焰流金' },
  { key: 'purple_neon', name: '紫金流光' },
  { key: 'gradient_rainbow', name: '霓虹彩虹' },
  { key: '3d_emboss', name: '3D浮雕' }
]

const BADGE_STYLES = [
  { key: 'gold', name: '金质' },
  { key: 'silver', name: '银光' },
  { key: 'purple', name: '紫光' },
  { key: 'pink', name: '粉梦' },
  { key: 'blue', name: '蓝钻' },
  { key: 'green', name: '翡翠' },
  { key: 'red', name: '赤焰' },
  { key: 'dark', name: '黑金' },
  { key: 'rainbow', name: '彩虹' }
]

function emptyTitle() {
  return { _id: '', name: '', description: '', icon: '🏅', nameColor: '#d99200', nameEffect: 'none', badgeStyle: 'gold', duplicatePoints: 20, autoGrantLevelIds: [], enabled: true, sortOrder: 0 }
}

function emptyMail() {
  return { titleId: '', titleName: '', targetType: 'openid_list', openids: '', role: 'client', targetLevelIds: [], title: '', content: '' }
}

function decorateLevels(levels = [], selectedIds = []) {
  const set = new Set(selectedIds || [])
  return (levels || []).map((lvl) => ({
    ...lvl,
    selected: set.has(lvl._id)
  }))
}

Page({
  data: {
    titles: [],
    levels: [],
    formLevelOptions: [],
    mailLevelOptions: [],
    form: emptyTitle(),
    mailForm: emptyMail(),
    showFormModal: false,
    showMailModal: false,
    saving: false,
    colorPalette: COLOR_PALETTE,
    effectOptions: EFFECT_OPTIONS,
    badgeStyles: BADGE_STYLES,
    targetTypes: [
      { key: 'openid_list', name: '指定 openid' },
      { key: 'all_active', name: '全部活跃用户' },
      { key: 'role', name: '按角色' },
      { key: 'member_level', name: '按会员等级' }
    ]
  },

  onShow() { this.load() },

  load() {
    Promise.all([
      callFunction('admin', 'listPetTitles'),
      callFunction('admin', 'listMemberLevels')
    ]).then(([titles, levels]) => {
      this.setData({
        titles,
        levels,
        formLevelOptions: decorateLevels(levels, this.data.form.autoGrantLevelIds),
        mailLevelOptions: decorateLevels(levels, this.data.mailForm.targetLevelIds)
      })
    }).catch(showError)
  },

  noop() {},
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }) },
  mailInput(e) { this.setData({ ['mailForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  switchEnabled(e) { this.setData({ 'form.enabled': e.detail.value }) },
  selectColor(e) { this.setData({ 'form.nameColor': e.currentTarget.dataset.hex }) },
  selectEffect(e) { this.setData({ 'form.nameEffect': e.currentTarget.dataset.effect }) },
  selectBadgeStyle(e) { this.setData({ 'form.badgeStyle': e.currentTarget.dataset.style }) },

  toggleAutoLevel(e) {
    const id = e.currentTarget.dataset.id
    const current = this.data.form.autoGrantLevelIds || []
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    this.setData({
      'form.autoGrantLevelIds': next,
      formLevelOptions: decorateLevels(this.data.levels, next)
    })
  },

  toggleMailLevel(e) {
    const id = e.currentTarget.dataset.id
    const current = this.data.mailForm.targetLevelIds || []
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    this.setData({
      'mailForm.targetLevelIds': next,
      mailLevelOptions: decorateLevels(this.data.levels, next)
    })
  },

  setMailTargetType(e) { this.setData({ 'mailForm.targetType': e.currentTarget.dataset.type }) },

  openAddModal() {
    this.setData({
      form: emptyTitle(),
      formLevelOptions: decorateLevels(this.data.levels, []),
      showFormModal: true
    })
  },
  closeFormModal() {
    this.setData({
      form: emptyTitle(),
      formLevelOptions: decorateLevels(this.data.levels, []),
      showFormModal: false,
      saving: false
    })
  },

  chooseTitle(e) {
    const item = this.data.titles[Number(e.currentTarget.dataset.index)]
    if (!item) return
    const autoGrantLevelIds = item.autoGrantLevelIds || []
    this.setData({
      form: {
        _id: item._id || '',
        name: item.name || '',
        description: item.description || '',
        icon: item.icon || '',
        nameColor: item.nameColor || '#d99200',
        nameEffect: item.nameEffect || 'none',
        badgeStyle: item.badgeStyle || 'gold',
        duplicatePoints: Number(item.duplicatePoints || 0),
        autoGrantLevelIds,
        enabled: item.enabled !== false,
        sortOrder: Number(item.sortOrder || 0)
      },
      formLevelOptions: decorateLevels(this.data.levels, autoGrantLevelIds),
      showFormModal: true
    })
  },

  save() {
    if (this.data.saving) return
    const form = this.data.form
    if (!String(form.name || '').trim()) return wx.showToast({ title: '请填写头衔名称', icon: 'none' })
    const payload = { ...form, duplicatePoints: Number(form.duplicatePoints || 0), sortOrder: Number(form.sortOrder || 0) }
    if (!payload._id) delete payload._id
    this.setData({ saving: true })
    callFunction('admin', 'savePetTitle', payload)
      .then((res) => {
        wx.showToast({ title: res.autoGrantCount ? `已保存并发放${res.autoGrantCount}份` : '已保存', icon: 'none' })
        this.closeFormModal()
        this.load()
      })
      .catch(showError)
      .finally(() => this.setData({ saving: false }))
  },

  deleteTitle(e) {
    const item = this.data.titles[Number(e.currentTarget.dataset.index)]
    if (!item) return
    wx.showModal({
      title: '确认删除',
      content: `删除头衔「${item.name}」？已拥有的用户记录会保留。`,
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'deletePetTitle', { _id: item._id }).then(() => { wx.showToast({ title: '已删除' }); this.load() }).catch(showError)
      }
    })
  },

  openMailModal(e) {
    const item = this.data.titles[Number(e.currentTarget.dataset.index)]
    if (!item) return
    this.setData({ mailForm: { ...emptyMail(), titleId: item._id, titleName: item.name, title: `宠物头衔【${item.name}】到账提醒`, content: `平台已向你发放宠物头衔【${item.name}】，请领取后为宠物佩戴。` }, showMailModal: true })
  },

  closeMailModal() { this.setData({ mailForm: emptyMail(), showMailModal: false, saving: false }) },

  sendMail() {
    if (this.data.saving) return
    const form = this.data.mailForm
    if (form.targetType === 'openid_list' && !String(form.openids || '').trim()) return wx.showToast({ title: '请输入 openid', icon: 'none' })
    if (form.targetType === 'member_level' && !(form.targetLevelIds || []).length) return wx.showToast({ title: '请选择会员等级', icon: 'none' })
    this.setData({ saving: true })
    callFunction('admin', 'publishPetTitleMail', form)
      .then((res) => { wx.showToast({ title: `已发送${res.issued}封`, icon: 'none' }); this.closeMailModal() })
      .catch(showError)
      .finally(() => this.setData({ saving: false }))
  }
})
