const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ENV_MAP,
  getActiveEnvId,
  setForceEnvId,
  envList
} = require('../../miniprogram/envList')

test('envRouting: ENV_MAP maps environments correctly', () => {
  assert.equal(ENV_MAP.develop, 'cloud1-5gnhqn4t0554c1d9', '开发版应使用 cloud1-5gnhqn4t0554c1d9')
  assert.equal(ENV_MAP.trial, 'cloud1-5gnhqn4t0554c1d9', '体验版应使用 cloud1-5gnhqn4t0554c1d9')
  assert.equal(ENV_MAP.release, 'production-d2g5jx277f41a81a6', '正式版应使用 production-d2g5jx277f41a81a6')
})

test('envRouting: fallback to trial/develop env when wx is undefined', () => {
  const originalWx = global.wx
  try {
    delete global.wx
    setForceEnvId('')
    const env = getActiveEnvId()
    assert.equal(env, 'cloud1-5gnhqn4t0554c1d9')
    assert.equal(envList[0].envId, 'cloud1-5gnhqn4t0554c1d9')
  } finally {
    global.wx = originalWx
  }
})

test('envRouting: routes to trial env when envVersion is develop or trial', () => {
  const originalWx = global.wx
  try {
    setForceEnvId('')
    global.wx = {
      getAccountInfoSync: () => ({
        miniProgram: { envVersion: 'develop' }
      })
    }
    assert.equal(getActiveEnvId(), 'cloud1-5gnhqn4t0554c1d9')
    assert.equal(envList[0].envId, 'cloud1-5gnhqn4t0554c1d9')

    global.wx = {
      getAccountInfoSync: () => ({
        miniProgram: { envVersion: 'trial' }
      })
    }
    assert.equal(getActiveEnvId(), 'cloud1-5gnhqn4t0554c1d9')
    assert.equal(envList[0].envId, 'cloud1-5gnhqn4t0554c1d9')
  } finally {
    global.wx = originalWx
  }
})

test('envRouting: routes to production env when envVersion is release', () => {
  const originalWx = global.wx
  try {
    setForceEnvId('')
    global.wx = {
      getAccountInfoSync: () => ({
        miniProgram: { envVersion: 'release' }
      })
    }
    assert.equal(getActiveEnvId(), 'production-d2g5jx277f41a81a6')
    assert.equal(envList[0].envId, 'production-d2g5jx277f41a81a6')
    assert.equal(envList[0].alias, '正式环境')
  } finally {
    global.wx = originalWx
  }
})

test('envRouting: setForceEnvId overrides runtime routing', () => {
  const originalWx = global.wx
  try {
    global.wx = {
      getAccountInfoSync: () => ({
        miniProgram: { envVersion: 'develop' }
      })
    }
    setForceEnvId('custom-env-123')
    assert.equal(getActiveEnvId(), 'custom-env-123')
    assert.equal(envList[0].envId, 'custom-env-123')

    setForceEnvId('')
    assert.equal(getActiveEnvId(), 'cloud1-5gnhqn4t0554c1d9')
  } finally {
    setForceEnvId('')
    global.wx = originalWx
  }
})

test('envRouting: envList contains both environments and backward compatibility', () => {
  assert.ok(Array.isArray(envList))
  assert.ok(envList.length >= 3)
  const prodEntry = envList.find(e => e.envId === 'production-d2g5jx277f41a81a6')
  const devEntry = envList.find(e => e.envId === 'cloud1-5gnhqn4t0554c1d9')
  assert.ok(prodEntry, 'envList 应包含正式环境')
  assert.ok(devEntry, 'envList 应包含体验/开发环境')
})
