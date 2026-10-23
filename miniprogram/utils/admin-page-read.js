const { can } = require('./adminAccess')
// Optional reference data must not make an otherwise authorized page fail to load.
function optionalAdminRead(page, module, action, data = {}, fallback = []) {
  if (!can(page.data.adminAccess, `${module}.${action}`)) return Promise.resolve(fallback)
  return require('./cloud').callFunction(module, action, data)
}
module.exports = { optionalAdminRead }
