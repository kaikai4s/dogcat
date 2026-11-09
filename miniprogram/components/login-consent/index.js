Component({
  options: {
    addGlobalClass: true
  },
  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    agreed: {
      type: Boolean,
      value: false
    },
    themeClass: {
      type: String,
      value: ''
    }
  },
  methods: {
    // 兼容现有单元测试与底层 checkbox-group 变更
    change(e) {
      const agreed = (e && e.detail && e.detail.value || []).includes('agree')
      this.setData({ agreed })
      this.triggerEvent('change', { agreed })
    },
    // 点击勾选行切换勾选状态
    toggleCheck() {
      const nextAgreed = !this.data.agreed
      this.setData({ agreed: nextAgreed })
      this.triggerEvent('change', { agreed: nextAgreed })
    },
    // 查看协议详情
    open(e) {
      const type = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.type
      if (['user_service', 'privacy'].includes(type)) {
        wx.navigateTo({ url: `/pages/common/agreement/index?type=${type}&mode=view` })
      }
    },
    // 点击“同意并继续登录”
    onConfirm() {
      if (!this.data.agreed) {
        this.setData({ agreed: true })
        this.triggerEvent('change', { agreed: true })
      }
      this.triggerEvent('confirm', { agreed: true })
    },
    // 点击“暂不登录”或关闭
    onCancel() {
      this.triggerEvent('cancel')
    },
    // 阻止遮罩滚动穿透
    preventTouchMove() {}
  }
})
