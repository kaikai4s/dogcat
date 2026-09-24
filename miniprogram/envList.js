/**
 * 微信云开发多环境配置文件
 * 
 * 路由规则：
 * - release（正式版）：production-d2g5jx277f41a81a6
 * - trial（体验版）：cloud1-5gnhqn4t0554c1d9
 * - develop（开发版/开发者工具）：cloud1-5gnhqn4t0554c1d9
 */

const ENV_MAP = {
  develop: 'cloud1-5gnhqn4t0554c1d9',   // 微信开发者工具 / 真机调试 / 开发版
  trial: 'cloud1-5gnhqn4t0554c1d9',     // 微信公众平台发布的体验版
  release: 'production-d2g5jx277f41a81a6' // 微信审核发布的正式生产版
}

// 强制指定环境 ID（空字符串表示根据小程序版本自动路由；若需临时在工具中调试特定环境可填入环境ID）
let FORCE_ENV_ID = ''

function setForceEnvId(id) {
  FORCE_ENV_ID = typeof id === 'string' ? id.trim() : ''
}

function getActiveEnvId() {
  if (typeof FORCE_ENV_ID === 'string' && FORCE_ENV_ID.trim()) {
    return FORCE_ENV_ID.trim()
  }

  try {
    if (typeof wx !== 'undefined' && typeof wx.getAccountInfoSync === 'function') {
      const accountInfo = wx.getAccountInfoSync()
      const envVersion = accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion
      if (envVersion && ENV_MAP[envVersion]) {
        return ENV_MAP[envVersion]
      }
    }
  } catch (err) {
    console.warn('[envList] 获取小程序环境版本失败，降级使用默认体验/开发环境:', err)
  }

  return ENV_MAP.trial || 'cloud1-5gnhqn4t0554c1d9'
}

// 动态环境对象，确保通过 envList[0].envId 访问也能始终拿到当前生效的环境 ID
const activeEnvEntry = {
  get envId() {
    return getActiveEnvId()
  },
  set envId(val) {
    setForceEnvId(val)
  },
  get alias() {
    const active = getActiveEnvId()
    return active === 'production-d2g5jx277f41a81a6' ? '正式环境' : '体验/开发环境'
  }
}

const envList = [
  activeEnvEntry,
  { envId: 'cloud1-5gnhqn4t0554c1d9', alias: '体验/开发环境' },
  { envId: 'production-d2g5jx277f41a81a6', alias: '正式环境' }
]

const isMac = false

module.exports = {
  ENV_MAP,
  FORCE_ENV_ID,
  setForceEnvId,
  getActiveEnvId,
  envList,
  isMac
}
