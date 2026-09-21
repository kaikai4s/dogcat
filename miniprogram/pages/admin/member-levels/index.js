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
  { name: '典雅黑', hex: '#333333' },
  { name: '终极彩虹', hex: '#7c3cff' }
]

const EFFECT_OPTIONS = [
  { key: 'none', name: '无特效' },
  { key: 'gold_shine', name: '金光流耀' },
  { key: 'silver_shine', name: '银辉流光' },
  { key: 'bronze_shine', name: '青铜流光' },
  { key: 'pink_dream', name: '粉梦流光' },
  { key: 'blue_diamond', name: '蓝钻流光' },
  { key: 'emerald_glow', name: '翡翠流光' },
  { key: 'fire_glow', name: '烈焰流金' },
  { key: 'purple_neon', name: '紫金流光' },
  { key: 'dark_gold', name: '黑金流光' },
  { key: 'gradient_rainbow', name: '霓虹彩虹' },
  { key: '3d_emboss', name: '3D浮雕' }
]

const BADGE_STYLES = [
  { key: 'gold', name: '金质' },
  { key: 'silver', name: '银光' },
  { key: 'bronze', name: '青铜' },
  { key: 'purple', name: '紫光' },
  { key: 'pink', name: '粉梦' },
  { key: 'blue', name: '蓝钻' },
  { key: 'green', name: '翡翠' },
  { key: 'red', name: '赤焰' },
  { key: 'dark', name: '黑金' },
  { key: 'rainbow', name: '终极彩虹' }
]

const LEVEL_THEME_PRESETS = [
  { key: 'gold', name: '黄金等级', badgeStyle: 'gold', nameColor: '#d99200', nameEffect: 'gold_shine', badgeTag: 'V1' },
  { key: 'silver', name: '白银等级', badgeStyle: 'silver', nameColor: '#8e9aaf', nameEffect: 'silver_shine', badgeTag: 'V2' },
  { key: 'bronze', name: '青铜等级', badgeStyle: 'bronze', nameColor: '#b87333', nameEffect: 'bronze_shine', badgeTag: 'V3' },
  { key: 'pink', name: '粉梦等级', badgeStyle: 'pink', nameColor: '#ff4d6d', nameEffect: 'pink_dream', badgeTag: 'V4' },
  { key: 'blue', name: '蓝钻等级', badgeStyle: 'blue', nameColor: '#409eff', nameEffect: 'blue_diamond', badgeTag: 'V5' },
  { key: 'green', name: '翡翠等级', badgeStyle: 'green', nameColor: '#67c23a', nameEffect: 'emerald_glow', badgeTag: 'V6' },
  { key: 'red', name: '赤焰等级', badgeStyle: 'red', nameColor: '#ff3300', nameEffect: 'fire_glow', badgeTag: 'V7' },
  { key: 'purple', name: '紫金等级', badgeStyle: 'purple', nameColor: '#b5179e', nameEffect: 'purple_neon', badgeTag: 'V8' },
  { key: 'dark', name: '黑金等级', badgeStyle: 'dark', nameColor: '#333333', nameEffect: 'dark_gold', badgeTag: 'V9' },
  { key: 'rainbow', name: '最终等级 · 霓虹彩虹', badgeStyle: 'rainbow', nameColor: '#7c3cff', nameEffect: 'gradient_rainbow', badgeTag: 'MAX' }
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
    saving: false,
    form: emptyLevel(),
    colorPalette: COLOR_PALETTE,
    effectOptions: EFFECT_OPTIONS,
    badgeStyles: BADGE_STYLES,
    levelThemePresets: LEVEL_THEME_PRESETS
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
      saving: false,
      form: emptyLevel()
    })
  },

  noop() {},

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

  applyThemePreset(e) {
    const preset = this.data.levelThemePresets.find((item) => item.key === e.currentTarget.dataset.preset)
    if (!preset) return
    this.setData({
      'form.badgeStyle': preset.badgeStyle,
      'form.nameColor': preset.nameColor,
      'form.nameEffect': preset.nameEffect,
      'form.badgeTag': this.data.form.badgeTag || preset.badgeTag
    })
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
    if (this.data.saving) return
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
    this.setData({ saving: true })
    callFunction('admin', 'saveMemberLevel', payload)
      .then((savedLevel) => {
        if (payload.nameEffect && savedLevel && savedLevel.nameEffect !== payload.nameEffect) {
          wx.showModal({
            title: '特效保存异常',
            content: '云函数返回的特效与选择不一致，请重新上传部署 api 云函数后再保存。',
            showCancel: false
          })
          return
        }
        wx.showToast({ title: form._id ? '修改已保存' : '新建已保存' })
        this.closeFormModal()
        this.load()
      })
      .catch(showError)
      .finally(() => this.setData({ saving: false }))
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
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/coupons/index', '/pages/admin/member-levels/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
