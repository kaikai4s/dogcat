const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const modulePath = path.join(__dirname, '../../miniprogram/pages/client/profile/display-cache.js')

function setupWx() {
  const storage = new Map()
  const files = new Set()
  const calls = { getTempFileURL: 0, getImageInfo: 0 }
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))),
    cloud: {
      getTempFileURL: ({ fileList, success }) => {
        calls.getTempFileURL += 1
        success({ fileList: [{ fileID: fileList[0], tempFileURL: 'https://tmp.example.com/a.jpg' }] })
      }
    },
    getImageInfo: ({ success }) => {
      calls.getImageInfo += 1
      files.add('http://tmp/a.jpg')
      success({ path: 'http://tmp/a.jpg' })
    },
    getFileSystemManager: () => ({
      accessSync: p => { if (!files.has(p)) throw new Error('no such file') },
      unlinkSync: p => { if (!files.delete(p)) throw new Error('no such file') },
      saveFile: ({ tempFilePath, filePath, success }) => {
        files.add(filePath)
        files.delete(tempFilePath)
        success({ savedFilePath: filePath })
      }
    })
  }
  return { storage, files, calls }
}

function freshModule() {
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

test('profile avatar is persisted to USER_DATA_PATH and served synchronously after reload', async () => {
  const { files, calls } = setupWx()
  const scope = JSON.stringify(['env', 'user_1'])
  const source = 'cloud://env.bucket/avatars/u1.jpg'

  const cache = freshModule()
  assert.equal(cache.getAvatar(scope, source), '')
  const resolved = await cache.resolveAvatar(scope, source)
  assert.match(resolved, /^wxfile:\/\/usr\/profile-avatar-.+\.jpg$/)
  assert.ok(files.has(resolved))

  // Simulate a new app session: memory cache is gone, persisted file is used without network.
  const reloaded = freshModule()
  assert.equal(reloaded.getAvatar(scope, source), resolved)
  assert.equal(calls.getTempFileURL, 1)
  assert.equal(calls.getImageInfo, 1)

  // A missing local file is dropped instead of being rendered broken.
  reloaded.invalidateAvatar(scope, source)
  assert.equal(files.has(resolved), false)
  assert.equal(freshModule().getAvatar(scope, source), '')
  delete global.wx
})
