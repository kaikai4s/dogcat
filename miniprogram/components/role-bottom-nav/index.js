const { navigateRoleRoute } = require('../../utils/nav')

const CLIENT_ITEMS = [
  { url: '/pages/client/home/index', label: '首页', icon: 'ri-home-5-line', activeIcon: 'ri-home-5-fill', protected: false },
  { url: '/pages/client/sitters/list/index', label: '宠托师', icon: 'ri-team-line', activeIcon: 'ri-team-fill', protected: false },
  { url: '/pages/client/orders/list/index', label: '订单', icon: 'ri-file-list-3-line', activeIcon: 'ri-file-list-3-fill', protected: true },
  { url: '/pages/client/messages/index', label: '消息', icon: 'ri-message-3-line', activeIcon: 'ri-message-3-fill', protected: true, hasUnread: true },
  { url: '/pages/client/profile/index', label: '我的', icon: 'ri-user-3-line', activeIcon: 'ri-user-3-fill', protected: false }
]

const STAFF_ITEMS = [
  { url: '/pages/staff/home/index', label: '工作台', icon: 'ri-home-5-line', activeIcon: 'ri-home-5-fill' },
  { url: '/pages/staff/orders/list/index', label: '任务', icon: 'ri-file-list-3-line', activeIcon: 'ri-file-list-3-fill' },
  { url: '/pages/staff/messages/index', label: '消息', icon: 'ri-message-3-line', activeIcon: 'ri-message-3-fill', hasUnread: true },
  { url: '/pages/staff/certification/index', label: '认证', icon: 'ri-checkbox-circle-line', activeIcon: 'ri-checkbox-circle-fill' },
  { url: '/pages/staff/profile/index', label: '我的', icon: 'ri-user-3-line', activeIcon: 'ri-user-3-fill' }
]

const ADMIN_VARIANTS = {
  default: [
    { url: '/pages/admin/home/index', label: '控制台', icon: 'ri-dashboard-3-line', activeIcon: 'ri-dashboard-3-fill' },
    { url: '/pages/admin/orders/list/index', label: '订单', icon: 'ri-file-list-3-line', activeIcon: 'ri-file-list-3-fill' },
    { url: '/pages/admin/staff-audit/list/index', label: '审核', icon: 'ri-shield-check-line', activeIcon: 'ri-shield-check-fill' },
    { url: '/pages/admin/incidents/list/index', label: '异常', icon: 'ri-alarm-warning-line', activeIcon: 'ri-alarm-warning-fill' }
  ],
  loyalty: [
    { url: '/pages/admin/home/index', label: '控制台', icon: 'ri-dashboard-3-line', activeIcon: 'ri-dashboard-3-fill' },
    { url: '/pages/admin/coupons/index', label: '优惠券', icon: 'ri-coupon-3-line', activeIcon: 'ri-coupon-3-fill' },
    { url: '/pages/admin/member-levels/index', label: '等级', icon: 'ri-vip-crown-line', activeIcon: 'ri-vip-crown-fill' },
    { url: '/pages/admin/points/index', label: '积分', icon: 'ri-coins-line', activeIcon: 'ri-coins-fill' }
  ],
  pets: [
    { url: '/pages/admin/home/index', label: '控制台', icon: 'ri-dashboard-3-line', activeIcon: 'ri-dashboard-3-fill' },
    { url: '/pages/admin/users/list/index', label: '用户', icon: 'ri-user-3-line', activeIcon: 'ri-user-3-fill' },
    { url: '/pages/admin/pets/list/index', label: '宠物', icon: 'ri-paw-print-line', activeIcon: 'ri-paw-print-fill' },
    { url: '/pages/admin/orders/list/index', label: '订单', icon: 'ri-file-list-3-line', activeIcon: 'ri-file-list-3-fill' }
  ],
  settings: [
    { url: '/pages/admin/home/index', label: '控制台', icon: 'ri-dashboard-3-line', activeIcon: 'ri-dashboard-3-fill' },
    { url: '/pages/admin/coupons/index', label: '优惠券', icon: 'ri-coupon-3-line', activeIcon: 'ri-coupon-3-fill' },
    { url: '/pages/admin/member-levels/index', label: '等级', icon: 'ri-vip-crown-line', activeIcon: 'ri-vip-crown-fill' },
    { url: '/pages/admin/settings/index', label: '设置', icon: 'ri-settings-3-line', activeIcon: 'ri-settings-3-fill' }
  ]
}

function getNavItems(role, variant) {
  if (role === 'staff') return STAFF_ITEMS
  if (role === 'admin') return ADMIN_VARIANTS[variant] || ADMIN_VARIANTS.default
  return CLIENT_ITEMS
}

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  properties: {
    role: { type: String, value: 'client' },
    variant: { type: String, value: 'default' },
    active: { type: String, value: '' },
    unreadCount: { type: Number, value: 0 },
    unreadText: { type: String, value: '' },
    delegateNav: { type: Boolean, value: false }
  },
  data: {
    navItems: CLIENT_ITEMS
  },
  lifetimes: {
    attached() {
      this.syncNavItems()
    }
  },
  observers: {
    'role, variant': function () {
      this.syncNavItems()
    }
  },
  methods: {
    syncNavItems() {
      const navItems = getNavItems(this.data.role, this.data.variant)
      if (this.data.navItems !== navItems) {
        this.setData({ navItems })
      }
    },
    onTapItem(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
      const url = ds.url
      if (!url || url === this.data.active) return
      if (this.data.delegateNav) {
        this.triggerEvent('navigate', { url, protected: Boolean(ds.protect) })
        return
      }
      navigateRoleRoute(url, this.data.role)
    }
  }
})
