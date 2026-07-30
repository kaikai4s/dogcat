const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('auth login creates a new user with client role only', async () => {
  const db = createCollectionStore({ users: [] })
  const fn = loadCloudFunction('auth', db, 'openid_1')

  const result = await fn.main({ action: 'login' })

  assert.equal(result.ok, true)
  assert.equal(result.data.openid, 'openid_1')
  assert.deepEqual(result.data.roles, ['client'])
  assert.equal(db.state.users.length, 1)
})

test('auth switchRole rejects roles not assigned to user', async () => {
  const db = createCollectionStore({ users: [{ _id: 'u1', openid: 'openid_1', roles: ['client'], status: 'active' }] })
  const fn = loadCloudFunction('auth', db, 'openid_1')

  const result = await fn.main({ action: 'switchRole', data: { role: 'admin' } })

  assert.equal(result.ok, false)
  assert.equal(result.message, '当前账号无此角色权限')
})
