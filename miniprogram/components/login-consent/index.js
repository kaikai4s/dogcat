Component({
  properties: { agreed: { type: Boolean, value: false } },
  methods: {
    change(e) {
      const agreed = (e.detail.value || []).includes('agree')
      this.setData({ agreed })
      this.triggerEvent('change', { agreed })
    },
    open(e) {
      const type = e.currentTarget.dataset.type
      if (['user_service', 'privacy'].includes(type)) wx.navigateTo({ url: `/pages/common/agreement/index?type=${type}&mode=view` })
    }
  }
})
