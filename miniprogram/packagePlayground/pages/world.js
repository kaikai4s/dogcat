const { ensureLogin, callFunction } = require('../../utils/cloud')
const { World3D } = require('../utils/world3d')

Page({
  data: { loading: true, error: '', status: '准备庄园…', top: 48, bottom: 20, pets: [], selectedPetId: '' },
  onLoad() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const menu = wx.getMenuButtonBoundingClientRect()
    this.setData({ top: menu.bottom + 12, bottom: Math.max(16, info.screenHeight - (info.safeArea ? info.safeArea.bottom : info.screenHeight) + 12) })
  },
  onShow() {
    this.visible = true
    const version = this.version = (this.version || 0) + 1
    ensureLogin({ content: '登录后进入全屏庄园。' }).then(() => {
      if (this.visible && version === this.version && this.ready) this.initialize()
      else if (version === this.version) this.authorized = true
    }).catch((error) => {
      if (this.visible && version === this.version) this.setData({ loading: false, error: error.message || '请先登录' })
    })
  },
  onReady() {
    this.ready = true
    if (this.visible && this.authorized) this.initialize()
  },
  onHide() { this.stop() },
  onUnload() { this.stop() },
  stop() {
    this.visible = false
    this.authorized = false
    this.version = (this.version || 0) + 1
    if (this.world) this.world.destroy()
    this.world = null
  },
  initialize() {
    if (this.world) this.world.destroy()
    const version = this.version = (this.version || 0) + 1
    this.setData({ loading: true, error: '', status: '读取宠物档案…', pets: [], selectedPetId: '' }, () => {
      if (!this.visible || version !== this.version) return
      callFunction('playground', 'getOverview').then((overview) => {
        if (!this.visible || version !== this.version) return
        const world = new World3D(this, (status) => {
          if (version === this.version && this.visible) this.setData({ status })
        }, overview, (pets) => {
          if (version !== this.version || !this.visible) return
          const selected = pets.find((pet) => pet.selected)
          this.setData({ pets, selectedPetId: selected ? selected.id : '' })
        })
        this.world = world
        return world.init()
      }).then(() => {
        if (version === this.version && this.visible) this.setData({ loading: false })
        else if (this.world) this.world.destroy()
      }).catch((error) => {
        if (this.world) this.world.destroy()
        if (version === this.version && this.visible) this.setData({ loading: false, error: error.message || error.errMsg || '场景加载失败' })
      })
    })
  },
  onResize() {
    if (!this.world) return
    this.createSelectorQuery().select('#worldCanvas').boundingClientRect((rect) => {
      if (rect && this.world) this.world.resize(rect.width, rect.height)
    }).exec()
  },
  touchStart(e) { if (this.world) this.world.touchStart(e.touches) },
  touchMove(e) { if (this.world) this.world.touchMove(e.touches) },
  touchEnd() { if (this.world) this.world.touchEnd() },
  touchCancel() { if (this.world) this.world.gesture = null },
  overview() { if (this.world) this.world.overview() },
  follow() { if (this.world) this.world.followPet() },
  selectPet(e) {
    const id = e.currentTarget.dataset.id
    if (this.world && !this.world.selectPet(id)) wx.showToast({ title: '该宠物模型待接入', icon: 'none' })
  },
  activity(e) {
    if (this.world && !this.world.request(e.currentTarget.dataset.action)) wx.showToast({ title: '暂时无法到达，请稍后再试', icon: 'none' })
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.redirectTo({ url: '/packagePlayground/pages/index' })
  }
})
