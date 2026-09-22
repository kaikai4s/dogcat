const routes = {
  'users/list/index': ['admin.listUsers'], 'users/edit/index': ['admin.getUserDetail'],
  'sitters/list/index': ['admin.listStaffProfiles'], 'admins/list/index': ['owner'],
  'permissions/index': ['owner'], 'operation-logs/index': ['admin.listOperationLogs'],
  'orders/list/index': ['admin.listOrders'], 'orders/detail/index': ['admin.getOrderDetail'],
  'orders/assign/index': ['admin.assignOrder'], 'evidence/detail/index': ['admin.getEvidence'],
  'notifications/index': ['admin.listAdminNotifications'],
  'staff-audit/list/index': ['admin.listStaffAudits'], 'staff-audit/detail/index': ['admin.listStaffAudits'],
  'staff-training/list/index': ['admin.listTrainingAudits'], 'staff-training/detail/index': ['admin.listTrainingAudits'],
  'staff-promotion/list/index': ['admin.listPromotionApplications'], 'staff-promotion/detail/index': ['admin.getPromotionApplicationDetail'],
  'incidents/list/index': ['incident.listIncidents'], 'incidents/detail/index': ['incident.getIncidentDetail'],
  'mall/products/index': ['adminMall.listProducts'], 'mall/orders/index': ['adminMall.listOrders'],
  'finance/index': ['admin.financeDashboard', 'admin.listWithdrawRequests', 'admin.listPayments', 'admin.listRefunds', 'admin.listStaffEarnings', 'admin.listFinanceLogs', 'admin.listStaffDeposits', 'admin.listSupplyReimbursements'],
  'service-prices/index': ['admin.listServicePrices'], 'prices/index': ['admin.listServicePrices'],
  'coupons/index': ['admin.listCouponTemplates'], 'member-levels/index': ['admin.listMemberLevels'],
  'pet-titles/index': ['admin.listPetTitles'], 'checkin-config/index': ['admin.getCheckinMonthConfig'],
  'points/index': ['admin.listPointLogs'], 'lottery/index': ['admin.listLotteryActivities'],
  'settings/index': ['admin.getSystemSettings']
}
function can(access, permission) { return !!access && (access.superAdmin || (access.permissions || []).includes(permission)) }
function canVisit(access, url) {
  const route = String(url || '').split('?')[0].replace(/^\//, '').replace(/^pages\/admin\//, '')
  if (route === 'home/index') return !!access
  return !!routes[route] && routes[route].some(key => can(access, key))
}
function installAdminPageGuard() {
  if (typeof Page !== 'function' || Page.__adminGuard) return
  const originalPage = Page
  Page = function guardedPage(options) {
    const load = options.onLoad, show = options.onShow
    options.onLoad = function (...args) {
      if (!String(this.route || '').startsWith('pages/admin/')) return load && load.apply(this, args)
      this._adminLoadArgs = args
    }
    options.onShow = function (...args) {
      if (!String(this.route || '').startsWith('pages/admin/')) return show && show.apply(this, args)
      const { callFunction, showError } = require('./cloud')
      return callFunction('admin', 'getMyAdminAccess').then(async access => {
        if (!canVisit(access, this.route)) {
          wx.showToast({ title: '没有该页面的访问权限', icon: 'none' })
          wx.redirectTo({ url: '/pages/admin/home/index' })
          return
        }
        const adminPermissions = {}
        for (const key of access.permissions || []) adminPermissions[key.replace(/\./g, '_')] = true
        this.setData({ adminAccess: access, adminPermissions, adminSuper: access.superAdmin })
        if (this._adminLoadArgs) {
          const loadArgs = this._adminLoadArgs
          delete this._adminLoadArgs
          if (load) await load.apply(this, loadArgs)
        }
        return show && show.apply(this, args)
      }).catch(error => { showError(error); wx.redirectTo({ url: '/pages/role-select/index' }) })
    }
    return originalPage(options)
  }
  Page.__adminGuard = true
}
module.exports = { can, canVisit, routes, installAdminPageGuard }
