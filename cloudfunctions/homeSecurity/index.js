delete require.cache[require.resolve('../api/index')]
const api = require('../api/index')

exports.main = async (event = {}) => api.main({
  module: 'homeSecurity',
  action: event.action,
  data: event.data || {}
})
