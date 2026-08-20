const roleMeta = {
  client: {
    value: 'client',
    label: '毛孩家庭端',
    icon: '🐾',
    tip: '预约喂猫遛狗，查看订单报告',
    homeUrl: '/pages/client/home/index'
  },
  staff: {
    value: 'staff',
    label: '安心宠护端',
    icon: '😺',
    tip: '查看任务，上传打卡证据',
    homeUrl: '/pages/staff/home/index'
  },
  admin: {
    value: 'admin',
    label: '平台管家端',
    icon: '🛠',
    tip: '管理订单、用户、宠护师和平台配置',
    homeUrl: '/pages/admin/home/index'
  }
}

const publicRoles = ['client', 'staff']

function getRoleMeta(role) {
  return roleMeta[role] || roleMeta.client
}

function getRoleHome(role) {
  return getRoleMeta(role).homeUrl
}

function decorateRoles(roles = []) {
  return roles.filter((role) => roleMeta[role]).map((role) => getRoleMeta(role))
}

module.exports = {
  roleMeta,
  publicRoles,
  getRoleMeta,
  getRoleHome,
  decorateRoles
}
