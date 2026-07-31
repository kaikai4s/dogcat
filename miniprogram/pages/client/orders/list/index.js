const { callFunction, showError } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待支付', value: 'pending_pay' },
  { label: '待派单', value: 'paid' },
  { label: '待服务', value: 'waiting_service' },
  { label: '已完成', value: 'completed' }
]

Page({
  data: {
    tabs,
    activeStatus: 'all',
    allOrders: [],
    orders: []
  },
  onShow() {
    ensureLogin({ content: '登录后可查看订单。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() {
    callFunction('order', 'listOrders', { role: 'client' })
      .then((orders) => this.setData({ allOrders: orders.map(withOrderText) }, this.filterOrders))
      .catch(showError)
  },
  filterOrders() {
    const { activeStatus, allOrders } = this.data
    const orders = activeStatus === 'all'
      ? allOrders
      : allOrders.filter((order) => {
        if (activeStatus === 'waiting_service') return ['assigned', 'in_service'].includes(order.status)
        return order.status === activeStatus
      })
    this.setData({ orders })
  },
  chooseStatus(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status }, this.filterOrders)
  },
  detail(e) { wx.navigateTo({ url: '/pages/client/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
