delete require.cache[require.resolve('../api/index')]
const api = require('../api/index')

exports.main = async (event = {}) => api.main({
  module: 'auth',
  action: event.action,
  data: event.data || {}
})
