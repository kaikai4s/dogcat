const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { decorateListing } = require('../utils/community-group-buy')
Page({
  data: { loading: true, loadError: false, groups: [], myGroups: [], communityName: '', rules: null },
  onShow() { return this.load() },
  async load() {
    const request = this._request = (this._request || 0) + 1
    this.setData({ loading: true, loadError: false })
    try {
      await ensureLogin({ content: '登录后查看本小区拼单。' })
      const result = await callFunction('playground', 'listCommunityGroupBuys')
      if (request === this._request) this.setData(decorateListing(result))
    } catch (error) { if (request === this._request) { this.setData({ loadError: true }); showError(error) } }
    finally { if (request === this._request) this.setData({ loading: false }) }
  },
  onHide() { this._request = (this._request || 0) + 1 },
  onUnload() { this._request = (this._request || 0) + 1 },
  openProfile() { wx.switchTab({ url: '/pages/client/profile/index' }) },
  start() { wx.navigateTo({ url: '/pages/client/orders/create/index?source=community_groupbuy' }) },
  join(e) { wx.navigateTo({ url: '/pages/client/orders/create/index?source=community_groupbuy&groupBuyId=' + encodeURIComponent(e.currentTarget.dataset.id) }) },
  detail(e) { wx.navigateTo({ url: '/pages/client/orders/detail/index?id=' + encodeURIComponent(e.currentTarget.dataset.id) }) },
  async onPullDownRefresh() { try { await this.load() } finally { wx.stopPullDownRefresh() } }
})
