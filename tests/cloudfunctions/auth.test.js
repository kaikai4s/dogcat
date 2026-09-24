const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('auth checkSession validates the account without running title grants', async () => {
  const db = createCollectionStore({ users: [{ _id: 'u', openid: 'owner', roles: ['client'], status: 'active' }] })
  const collection = db.collection
  db.collection = (name) => {
    assert.ok(['users', 'member_levels'].includes(name), `session check must not touch ${name}`)
    return collection(name)
  }
  const fn = loadCloudFunction('api', db, 'owner')
  const response = await fn.main({ module: 'auth', action: 'checkSession' })
  assert.equal(response.ok, true, response.message)
  assert.equal(response.data._id, 'u')
  db.state.users[0].status = 'disabled'
  assert.equal((await fn.main({ module: 'auth', action: 'checkSession' })).ok, false)
})

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
