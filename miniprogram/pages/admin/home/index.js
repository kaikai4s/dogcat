const { callFunction, showError } = require('../../../utils/cloud')

const adminSections = [
  {
    title: '运营与订单',
    desc: '派单、服务履约、异常处理',
    items: [
      { icon: '单', title: '订单管理', desc: '派单与监控', url: '/pages/admin/orders/list/index' },
      { icon: '警', title: '异常事件', desc: 'SOS 与客诉', url: '/pages/admin/incidents/list/index' }
    ]
  },
  {
    title: '人员管理',
    desc: '用户、宠托师、后台权限',
    items: [
      { icon: '客', title: '用户管理', desc: '资料与筛选', url: '/pages/admin/users/list/index' },
      { icon: '托', title: '宠托师管理', desc: '资料与状态', url: '/pages/admin/sitters/list/index' },
      { icon: '审', title: '员工审核', desc: '资质与权限', url: '/pages/admin/staff-audit/list/index' },
      { icon: '管', title: '管理员管理', desc: '后台权限', url: '/pages/admin/admins/list/index' }
    ]
  },
  {
    title: '营销与会员',
    desc: '优惠、积分、签到和抽奖',
    items: [
      { icon: '券', title: '优惠券管理', desc: '模板与发券', url: '/pages/admin/coupons/index' },
      { icon: '级', title: '会员等级', desc: '积分升级规则', url: '/pages/admin/member-levels/index' },
      { icon: '签', title: '签到奖励', desc: '月度每日奖励配置', url: '/pages/admin/checkin-config/index' },
      { icon: '分', title: '积分管理', desc: '手动增减与流水', url: '/pages/admin/points/index' },
      { icon: '抽', title: '抽奖活动', desc: '开关与奖品设置', url: '/pages/admin/lottery/index' }
    ]
  },
  {
    title: '平台配置',
    desc: '价格、测试模式和平台参数',
    items: [
      { icon: '价', title: '价格配置', desc: '服务项目与收费', url: '/pages/admin/service-prices/index' },
      { icon: '设', title: '系统设置', desc: '测试模式与平台参数', url: '/pages/admin/settings/index' }
    ]
  }
]

function moneyText(value) {
  return `¥${Number(value || 0).toLocaleString()}`
}

function buildOverviewStats(dashboard = {}) {
  const orders = dashboard.orders || {}
  const monthly = dashboard.monthly || { totals: {} }
  return [
    { value: orders.paid || 0, label: '待派单订单' },
    { value: orders.in_service || 0, label: '进行中订单' },
    { value: dashboard.staffPending || 0, label: '待审核宠托师' },
    { value: dashboard.incidentsOpen || 0, label: '待处理异常' },
    { value: (monthly.totals && monthly.totals.orders) || 0, label: '本月订单' },
    { value: (monthly.totals && monthly.totals.registrations) || 0, label: '本月新用户' }
  ]
}

function buildRevenueStats(dashboard = {}) {
  const totals = (dashboard.monthly && dashboard.monthly.totals) || {}
  return [
    { value: moneyText(totals.revenue), label: '本月收入', highlight: true },
    { value: totals.paidOrders || 0, label: '已支付订单' },
    { value: moneyText(totals.averageOrderValue), label: '平均客单价' }
  ]
}

Page({
  data: {
    dashboard: null,
    overviewStats: [],
    revenueStats: [],
    adminSections
  },

  onShow() {
    this.loadDashboard()
  },

  loadDashboard() {
    callFunction('admin', 'dashboard')
      .then((dashboard) => {
        this.setData({
          dashboard,
          overviewStats: buildOverviewStats(dashboard),
          revenueStats: buildRevenueStats(dashboard)
        })
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  }
})
