const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

// Mock wx environment
let savedFiles = {}
let downloadedCloudFiles = []
let downloadedHttpFiles = []

const realShibaGlb = fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/assets/shiba.glb'))

global.wx = {
  env: {
    USER_DATA_PATH: '/mock/user/data'
  },
  getFileSystemManager() {
    return {
      accessSync(filePath) {
        if (!savedFiles[filePath] && !filePath.includes('shiba.glb')) {
          const err = new Error('ENOENT')
          err.code = 'ENOENT'
          throw err
        }
      },
      mkdirSync(dirPath) {
        savedFiles[dirPath] = true
      },
      readFile({ filePath, success, fail }) {
        if (filePath.includes('shiba.glb') || savedFiles[filePath]) {
          const ab = realShibaGlb.buffer.slice(realShibaGlb.byteOffset, realShibaGlb.byteOffset + realShibaGlb.byteLength)
          success({ data: ab })
        } else {
          fail(new Error(`File not found: ${filePath}`))
        }
      },
      copyFile({ srcPath, destPath, success, fail }) {
        savedFiles[destPath] = true
        success()
      },
      readdirSync(dirPath) {
        return Object.keys(savedFiles).filter(f => f.startsWith(dirPath))
      },
      unlinkSync(filePath) {
        delete savedFiles[filePath]
      },
      statSync(filePath) {
        return { size: 1024 }
      }
    }
  },
  cloud: {
    downloadFile({ fileID, success, fail }) {
      downloadedCloudFiles.push(fileID)
      if (fileID.includes('fail')) {
        fail(new Error('Cloud download failed'))
      } else {
        const tempPath = `/tmp/temp_${Date.now()}.glb`
        savedFiles[tempPath] = true
        success({ tempFilePath: tempPath })
      }
    }
  },
  downloadFile({ url, success, fail }) {
    downloadedHttpFiles.push(url)
    if (url.includes('fail')) {
      fail(new Error('HTTP download failed'))
    } else {
      const tempPath = `/tmp/http_${Date.now()}.glb`
      savedFiles[tempPath] = true
      success({ statusCode: 200, tempFilePath: tempPath })
    }
  }
}

const {
  hashString,
  getCacheFilePath,
  ensureModelCacheDir,
  clearModelCache,
  getModelCacheInfo,
  loadModel
} = require('../../miniprogram/packagePlayground/utils/model-loader')

test('hashString generates deterministic hash for URLs', () => {
  const url1 = 'cloud://cloud1.123/playground/models/pet1.glb'
  const url2 = 'cloud://cloud1.123/playground/models/pet1.glb'
  const url3 = 'cloud://cloud1.123/playground/models/pet2.glb'
  assert.equal(hashString(url1), hashString(url2))
  assert.notEqual(hashString(url1), hashString(url3))
})

test('getCacheFilePath resolves path under USER_DATA_PATH with .glb extension', () => {
  const fileId = 'cloud://env-123/custom_models/dog_golden.glb'
  const cachePath = getCacheFilePath(fileId)
  assert.ok(cachePath.startsWith('/mock/user/data/playground_models/model_'))
  assert.ok(cachePath.endsWith('.glb'))
})

test('ensureModelCacheDir creates cache folder', () => {
  savedFiles = {}
  const ok = ensureModelCacheDir()
  assert.equal(ok, true)
  assert.ok(savedFiles['/mock/user/data/playground_models'])
})

test('loadModel downloads and caches cloud:// model when not cached', async () => {
  savedFiles = {}
  downloadedCloudFiles = []
  const fileId = 'cloud://env-123/custom_models/pet_corgi.glb'
  const cachePath = getCacheFilePath(fileId)

  assert.equal(savedFiles[cachePath], undefined)
  const result = await loadModel(fileId)
  assert.ok(result)
  assert.equal(downloadedCloudFiles.includes(fileId), true)
  assert.equal(savedFiles[cachePath], true)
})

test('loadModel hits local cache directly without network download', async () => {
  const fileId = 'cloud://env-123/custom_models/pet_corgi.glb'
  const cachePath = getCacheFilePath(fileId)
  savedFiles[cachePath] = true
  downloadedCloudFiles = []

  const result = await loadModel(fileId)
  assert.ok(result)
  assert.equal(downloadedCloudFiles.length, 0, 'Should not download when cache exists')
})

test('loadModel falls back to default model if custom model download fails', async () => {
  const failFileId = 'cloud://env-123/custom_models/fail_dog.glb'
  const result = await loadModel(failFileId, { fallback: 'shiba' })
  assert.ok(result)
})

test('cache stats and clearModelCache work correctly', () => {
  const info = getModelCacheInfo()
  assert.ok(typeof info.count === 'number')
  assert.ok(typeof info.size === 'number')
  clearModelCache()
})
