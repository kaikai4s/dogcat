module.exports = function createHandler(context) {
  const service = require('../services/configMigration')(context)
  return async (openid, action, data = {}) => {
    const admin = await context.requireAdmin(openid)
    if (action === 'export') return service.exportConfig()
    if (action === 'preview') return service.preview(data.snapshot)
    if (action === 'import') return service.apply(admin, data)
    if (action === 'backup') return service.backup(data.id)
    throw new Error('未知配置迁移操作')
  }
}
