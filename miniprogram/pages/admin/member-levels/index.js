const { callFunction, showError } = require('../../../utils/cloud')

const COLOR_PALETTE = [
  { name: '皇家金', hex: '#d99200' },
  { name: '白银银', hex: '#8e9aaf' },
  { name: '青铜棕', hex: '#b87333' },
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
  { key: 'gradient_rainbow', name: '霓虹彩虹' },
  { key: 'fire_glow', name: '烈焰发光' },
  { key: 'purple_neon', name: '霓虹紫光' },
  { key: '3d_emboss', name: '3D浮雕' }
]

const BADGE_STYLES = [
  { key: 'gold', name: '金质' },
  { key: 'silver', name: '银光' },
  { key: 'bronze', name: '青铜' },
  { key: 'purple', name: '紫光' },
  { key: 'pink', name: '粉梦' },
  { key: 'blue', name: '蓝钻' },
  { key: 'dark', name: '黑金' }
]

function emptyLevel() {
  return {
    _id: '',
    name: '',
    badgeTag: '',
    nameColor: '#d99200',
    nameEffect: 'none',
    badgeStyle: 'gold',
    minPoints: 0,
    icon: '',
    pointMultiplier: 1,
    description: '',
    benefitsText: '',
    sortOrder: 0
  }
}

Page({
  data: {
    levels: [],
    showFormModal: false,
    form: emptyLevel(),
    colorPalette: COLOR_PALETTE,
    effectOptions: EFFECT_OPTIONS,
    badgeStyles: BADGE_STYLES
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listMemberLevels')
      .then((levels) => this.setData({ levels }))
      .catch(showError)
  },

  openAddModal() {
    this.setData({
      form: emptyLevel(),
      showFormModal: true
    })
  },

  closeFormModal() {
    this.setData({
      showFormModal: false,
      form: emptyLevel()
    })
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  selectColor(e) {
    const hex = e.currentTarget.dataset.hex
    this.setData({ 'form.nameColor': hex })
  },

  selectEffect(e) {
    const effect = e.currentTarget.dataset.effect
    this.setData({ 'form.nameEffect': effect })
  },

  selectBadgeStyle(e) {
    const style = e.currentTarget.dataset.style
    this.setData({ 'form.badgeStyle': style })
  },

  chooseLevel(e) {
    const rawIndex = e.currentTarget.dataset.index
    const index = Number(rawIndex)
    const level = this.data.levels[index]
    if (!level) return
    this.setData({
      form: {
        _id: level._id || '',
        name: level.name || '',
        badgeTag: level.badgeTag || '',
        nameColor: level.nameColor || '',
        nameEffect: level.nameEffect || 'none',
        badgeStyle: level.badgeStyle || 'gold',
        minPoints: level.minPoints !== undefined ? level.minPoints : 0,
        icon: level.icon || '',
        pointMultiplier: level.pointMultiplier !== undefined ? Number(level.pointMultiplier) : 1,
        description: level.description || '',
        benefitsText: Array.isArray(level.benefits) ? level.benefits.join('\n') : '',
        sortOrder: level.sortOrder !== undefined ? level.sortOrder : 0
      },
      showFormModal: true
    })
  },

  save() {
    const form = this.data.form
    if (!form.name) return wx.showToast({ title: '请填写等级名称', icon: 'none' })
    const payload = {
      ...form,
      minPoints: Number(form.minPoints || 0),
      pointMultiplier: Number(form.pointMultiplier || 1),
      benefits: String(form.benefitsText || '').split(/\n+/).map((item) => item.trim()).filter(Boolean),
      sortOrder: Number(form.sortOrder || 0)
    }
    if (!payload._id) {
      delete payload._id
    }
    callFunction('admin', 'saveMemberLevel', payload)
      .then(() => {
        wx.showToast({ title: form._id ? '修改已保存' : '新建已保存' })
        this.closeFormModal()
        this.load()
      })
      .catch(showError)
  },

  deleteLevel(e) {
    const rawIndex = e.currentTarget.dataset.index
    const index = Number(rawIndex)
    const level = this.data.levels[index]
    if (!level) return
    wx.showModal({
      title: '确认删除',
      content: `删除等级「${level.name}」？`,
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'deleteMemberLevel', { _id: level._id })
          .then(() => {
            wx.showToast({ title: '已删除' })
            if (this.data.form._id === level._id) {
              this.closeFormModal()
            }
            this.load()
          })
          .catch(showError)
      }
    })
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  }
})
