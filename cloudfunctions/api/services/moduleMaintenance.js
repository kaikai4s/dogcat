const labels = Object.freeze({ petRanking: '宠物排行榜', booking: '预约下单', invitation: '分享赚取佣金' })

async function assertModuleAvailable(getSystemSettings, module) {
  const settings = await getSystemSettings()
  if (settings.maintenance?.[module] === true) {
    const error = new Error(`${labels[module]}功能暂时不可使用，正在维护中`)
    error.code = 'MODULE_MAINTENANCE'
    throw error
  }
  return settings
}

module.exports = { assertModuleAvailable }
