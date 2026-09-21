module.exports = function initializeDatabase(cloud) {
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  return { cloud, db: cloud.database() }
}
