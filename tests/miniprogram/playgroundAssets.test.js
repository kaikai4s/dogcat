const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AssetLoader2D
} = require('../../miniprogram/packagePlayground/utils/asset-loader-2d')

test('cloud assets load only requested images, share downloads and recover after network or image failures', async () => {
  const requests = []
  let failNetwork = true
  let failDecode = true
  global.wx = {
    cloud: {
      downloadFile({ fileID, success, fail }) {
        requests.push(fileID)
        if (fileID.includes('cat_run') && failNetwork) {
          failNetwork = false
          fail(new Error('network unavailable'))
        } else success({ tempFilePath: '/tmp/' + fileID.split('/').pop() })
      }
    },
    createOffscreenCanvas({ width, height }) {
      return {
        getContext: () => ({
          save() {},
          restore() {},
          translate() {},
          scale() {},
          drawImage() {},
          getImageData: () => ({
            data: new Uint8ClampedArray(width * height * 4)
          }),
          putImageData() {}
        })
      }
    }
  }
  const canvas = {
    createImage() {
      return {
        width: 2048,
        height: 2048,
        set src(value) {
          queueMicrotask(() => {
            if (value.includes('cat_run') && failDecode) {
              failDecode = false
              this.onerror(new Error('invalid image'))
            } else this.onload()
          })
        }
      }
    }
  }
  try {
    const first = new AssetLoader2D(canvas)
    const result = await first.loadAll(null, [
      'grass_tile',
      'dog_stand',
      'dog_run'
    ])
    assert.equal(Object.keys(result).length, 3)
    assert.equal(requests.length, 3)
    assert.ok(
      requests.every((id) => id.startsWith('cloud://') && !id.includes('house'))
    )
    await new AssetLoader2D(canvas).loadAll(null, [
      'grass_tile',
      'dog_stand',
      'dog_run'
    ])
    assert.equal(requests.length, 3)
    await assert.rejects(() => first.loadImage('cat_run'), /network/)
    await assert.rejects(() => first.loadImage('cat_run'), /invalid image/)
    assert.ok(await first.loadImage('cat_run'))
    assert.equal(requests.filter((id) => id.includes('cat_run')).length, 3)
  } finally {
    delete global.wx
  }
})
