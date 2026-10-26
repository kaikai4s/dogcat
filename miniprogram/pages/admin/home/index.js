const { callFunction, showError } = require('../../../utils/cloud')
const { can, canVisit } = require('../../../utils/adminAccess')

const adminSections = [
  {
    title: '运营与订单',
    desc: '派单、服务履约、异常处理',
    items: [
      { icon: 'ri-file-list-3-line', title: '订单管理', desc: '派单与监控', url: '/pages/admin/orders/list/index' },
      { icon: 'ri-notification-3-line', title: '系统通知', desc: '异常告警与待办', url: '/pages/admin/notifications/index' },
      { icon: 'ri-shopping-bag-3-line', title: '商城订单', desc: '发货与售后', url: '/pages/admin/mall/orders/index' },
      { icon: 'ri-alarm-warning-line', title: '异常事件', desc: 'SOS 与客诉', url: '/pages/admin/incidents/list/index' },
      { icon: 'ri-wallet-3-line', title: '财务提现', desc: '收益与打款审核', url: '/pages/admin/finance/index' }
    ]
  },
  {
    title: '人员管理',
    desc: '用户、宠托师、后台权限',
    items: [
      { icon: 'ri-user-heart-line', title: '用户管理', desc: '资料与筛选', url: '/pages/admin/users/list/index' },
      { icon: 'ri-user-follow-line', title: '宠托师管理', desc: '资料与状态', url: '/pages/admin/sitters/list/index' },
      { icon: 'ri-shield-check-line', title: '员工审核', desc: '资质与权限', url: '/pages/admin/staff-audit/list/index' },
      { icon: 'ri-graduation-cap-line', title: '培训视频审核', desc: '微信视频审核', url: '/pages/admin/staff-training/list/index' },
      { icon: 'ri-award-line', title: '实习转正审核', desc: '三单报告质量', url: '/pages/admin/staff-promotion/list/index' },
      { icon: 'ri-admin-line', title: '管理员管理', desc: '后台人员', url: '/pages/admin/admins/list/index' },
      { icon: 'ri-shield-keyhole-line', title: '用户组与权限', desc: '权限树与人员分组', url: '/pages/admin/permissions/index' },
      { icon: 'ri-history-line', title: '后台操作日志', desc: '按人员查看记录', url: '/pages/admin/operation-logs/index' }
    ]
  },
  {
    title: '营销与会员',
    desc: '优惠、积分、签到和抽奖',
    items: [
      { icon: 'ri-coupon-3-line', title: '优惠券管理', desc: '模板与发券', url: '/pages/admin/coupons/index' },
      { icon: 'ri-survey-line', title: '问卷调查', desc: '发布调研与AI分析', url: '/pages/admin/questionnaires/list/index' },
      { icon: 'ri-store-2-line', title: '商城商品', desc: '分类与商品', url: '/pages/admin/mall/products/index' },
      { icon: 'ri-vip-crown-line', title: '会员等级', desc: '积分升级规则', url: '/pages/admin/member-levels/index' },
      { icon: 'ri-medal-line', title: '宠物头衔', desc: '称号与自动发放', url: '/pages/admin/pet-titles/index' },
      { icon: 'ri-shield-check-line', title: '宠物疫苗审核', desc: '接种认证材料审核', url: '/pages/admin/pet-vaccine/list/index' },
      { icon: 'ri-calendar-check-line', title: '签到奖励', desc: '月度每日奖励配置', url: '/pages/admin/checkin-config/index' },
      { icon: 'ri-coins-line', title: '积分管理', desc: '手动增减与流水', url: '/pages/admin/points/index' },
      { icon: 'ri-gift-line', title: '抽奖活动', desc: '开关与奖品设置', url: '/pages/admin/lottery/index' }
    ]
  },
  {
    title: '宠物庄园',
    desc: '拼单、宠物状态、地面与庄园素材',
    items: [
      { icon: 'ri-home-heart-line', title: '庄园规则与配置', desc: '拼单优惠、猫狗状态与排泄规则', url: '/pages/admin/playground/index' },
      { icon: 'ri-palette-line', title: '乐园形象定制', desc: '照片申请与专属形象发布', url: '/pages/admin/playground-customizations/index' },
      { icon: 'ri-plant-line', title: '农作物管理', desc: '装饰素材、生长阶段与会员解锁', url: '/pages/admin/playground-crops/index' },
      { icon: 'ri-building-line', title: '乐园建筑管理', desc: '建筑素材、土地会员解锁与积分配置', url: '/pages/admin/playground-buildings/index' },
    ]
  },
  {
    title: '平台配置',
    desc: '价格、测试模式和平台参数',
    items: [
      { icon: 'ri-map-pin-line', title: '小区地图管理', desc: '公共小区、别名与地图位置', url: '/pages/admin/community-map/index' },
      { icon: 'ri-price-tag-3-line', title: '价格配置', desc: '服务项目与收费', url: '/pages/admin/service-prices/index' },
      { icon: 'ri-settings-4-line', title: '系统设置', desc: '测试模式与平台参数', url: '/pages/admin/settings/index' }
    ]
  }
]

function moneyText(value) {
  const num = Number(value || 0)
  const parts = num.toFixed(2).split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `¥${parts.join('.')}`
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

function pendingCountForUrl(url, pending = {}) {
  const map = {
    '/pages/admin/staff-audit/list/index': pending.staffAudit,
    '/pages/admin/staff-training/list/index': pending.training,
    '/pages/admin/staff-promotion/list/index': pending.promotion,
    '/pages/admin/pet-vaccine/list/index': pending.petVaccine,
    '/pages/admin/finance/index': pending.finance,
    '/pages/admin/playground-customizations/index': pending.playgroundCustomizations,
    '/pages/admin/community-map/index': pending.communityApplications,
    '/pages/admin/mall/orders/index': pending.mallOrders,
    '/pages/admin/incidents/list/index': pending.incidents
  }
  return Number(map[url] || 0)
}

function buildAdminSections(access, dashboard = null, mallPendingCount = null, communityPendingCount = null) {
  const pending = { ...((dashboard && dashboard.pendingReviews) || {}),
    ...(mallPendingCount !== null ? { mallOrders: mallPendingCount } : {}),
    ...(communityPendingCount !== null ? { communityApplications: communityPendingCount } : {}) }
  return adminSections
    .map(section => ({
      ...section,
      items: section.items
        .filter(item => canVisit(access, item.url))
        .map(item => ({ ...item, pendingCount: pendingCountForUrl(item.url, pending) }))
    }))
    .filter(section => section.items.length)
}

Page({
  data: {
    mallPendingCount: null,
    communityPendingCount: null,
    dashboard: null,
    overviewStats: [],
    revenueStats: [],
    adminSections: [],
    urgentNotice: null,
    unreadNotificationCount: 0,
    staffAuditTodo: null
  },

  onShow() {
    return this.refreshHome()
  },

  onHide() {
    this.invalidateRequests()
  },

  onUnload() {
    this.invalidateRequests()
  },

  invalidateRequests() {
    this._dashboardRequest = (this._dashboardRequest || 0) + 1
    this._mallRequest = (this._mallRequest || 0) + 1
    this._communityRequest = (this._communityRequest || 0) + 1
    this._notificationRequest = (this._notificationRequest || 0) + 1
  },

  onPullDownRefresh() {
    return this.refreshHome().finally(() => wx.stopPullDownRefresh())
  },

  refreshHome() {
    this.invalidateRequests()
    const access = this.data.adminAccess
    this.setData({ adminSections: buildAdminSections(access, null, null, null), dashboard: null, mallPendingCount: null, communityPendingCount: null, urgentNotice: null, unreadNotificationCount: 0, staffAuditTodo: null })
    const requests = []
    if (can(access, 'adminMall.listOrders')) requests.push(this.loadMallPending())
    if (can(access, 'communityMap.listAdmin')) requests.push(this.loadCommunityPending())
    if (can(access, 'admin.dashboard')) requests.push(this.loadDashboard())
    if (can(access, 'admin.getAdminNotificationBadge')) requests.push(this.loadNotifications())
    return Promise.all(requests)
  },

  loadMallPending() {
    const requestId = this._mallRequest = (this._mallRequest || 0) + 1
    return callFunction('adminMall', 'listOrders', { pendingCountsOnly: true }).then(result => {
      if (requestId !== this._mallRequest) return
      const count = Number(result.pendingCount || 0)
      this.setData({ mallPendingCount: count, adminSections: buildAdminSections(this.data.adminAccess, this.data.dashboard, count, this.data.communityPendingCount) })
    }).catch(error => { if (requestId === this._mallRequest) showError(error) })
  },

  loadCommunityPending() {
    const requestId = this._communityRequest = (this._communityRequest || 0) + 1
    return callFunction('communityMap', 'listAdmin', { pendingCountsOnly: true }).then(result => {
      if (requestId !== this._communityRequest) return
      const count = Number(result.pendingApplicationCount || 0)
      this.setData({ communityPendingCount: count,
        adminSections: buildAdminSections(this.data.adminAccess, this.data.dashboard, this.data.mallPendingCount, count) })
    }).catch(error => { if (requestId === this._communityRequest) showError(error) })
  },

  loadDashboard() {
    const requestId = this._dashboardRequest = (this._dashboardRequest || 0) + 1
    return callFunction('admin', 'dashboard')
      .then((dashboard) => {
        if (requestId !== this._dashboardRequest) return
        const staffPending = Number(dashboard.staffPending || 0)
        const staffAuditUrl = '/pages/admin/staff-audit/list/index'
        this.setData({
          dashboard,
          overviewStats: buildOverviewStats(dashboard),
          revenueStats: buildRevenueStats(dashboard),
          adminSections: buildAdminSections(this.data.adminAccess, dashboard, this.data.mallPendingCount, this.data.communityPendingCount),
          staffAuditTodo: staffPending > 0 && canVisit(this.data.adminAccess, staffAuditUrl)
            ? { count: staffPending, url: staffAuditUrl }
            : null
        })
      })
      .catch((err) => { if (requestId === this._dashboardRequest) showError(err) })
  },

  loadNotifications() {
    const requestId = this._notificationRequest = (this._notificationRequest || 0) + 1
    this.setData({ urgentNotice: null, unreadNotificationCount: 0 })
    return callFunction('admin', 'getAdminNotificationBadge')
      .then((res) => {
        if (requestId !== this._notificationRequest) return
        this.setData({
          unreadNotificationCount: res.unreadCount || 0,
          urgentNotice: res.latestUrgent && !res.latestUrgent.isResolved && !res.latestUrgent.resolved
            ? { ...res.latestUrgent,
                actionText: ['order_start_overdue', 'order_urgent_republished'].includes(res.latestUrgent.type) ? '去调度' : '去查看',
                tip: res.latestUrgent.type === 'order_start_overdue'
                  ? '宠托师超时未到场，点击立即核实或转加急单 ➔'
                  : res.latestUrgent.type === 'order_urgent_republished'
                    ? '订单已转加急公共单，点击查看接单进展 ➔'
                    : res.latestUrgent.type === 'order_finish_overdue'
                      ? '服务超时未完成，点击立即核实处理 ➔'
                      : '点击查看通知详情 ➔' }
            : null
        })
      })
      .catch(() => {})
  },

  tapUrgentNotice() {
    const notice = this.data.urgentNotice
    if (!notice) return
    const url = notice.actionUrl || (notice.orderId ? `/pages/admin/orders/detail/index?id=${notice.orderId}` : '')
    if (url) wx.navigateTo({ url })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
