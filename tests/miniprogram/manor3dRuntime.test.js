const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE, loadGlb, disposeModel } = require('../../miniprogram/packageManor3d/utils/model-runtime')

function texturedTriangle() {
  const extras = { title: '晴溪庄园 % / 🐾' }
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength: 64 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 60, byteStride: 20 },
      { buffer: 0, byteOffset: 60, byteLength: 4 }
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 0, 1] },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC2' }
    ],
    images: [{ bufferView: 1, mimeType: 'image/png', name: 'meadow.png' }],
    textures: [{ source: 0 }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    nodes: [{ mesh: 0, translation: [12, 0, -3], extras }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    scenes: [{ nodes: [0] }], scene: 0
  }
  const metadata = Buffer.from(JSON.stringify(json))
  const jsonSize = Math.ceil(metadata.length / 4) * 4
  const result = new ArrayBuffer(28 + jsonSize + 64)
  const header = new DataView(result)
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, result.byteLength], [12, jsonSize], [16, 0x4e4f534a],
    [20 + jsonSize, 64], [24 + jsonSize, 0x004e4942]]) header.setUint32(offset, value, true)
  const jsonBytes = new Uint8Array(result, 20, jsonSize)
  jsonBytes.fill(32)
  jsonBytes.set(metadata)
  const binaryStart = 28 + jsonSize
  new Float32Array(result, binaryStart, 15).set([0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1, 0, 1])
  new Uint8Array(result, binaryStart + 60, 4).set([137, 80, 78, 71])
  return result
}

function wxFixture({ failDecode = false, onImageLoad = () => {} } = {}) {
  const files = new Map()
  const createImage = () => ({
    width: 3, height: 2,
    set src(path) {
      assert.ok(files.has(path), 'the embedded image file exists until it decodes')
      queueMicrotask(() => {
        onImageLoad()
        if (failDecode) this.onerror()
        else this.onload()
      })
    }
  })
  const context = {
    clearRect() {}, drawImage() {},
    getImageData() { return { data: new Uint8ClampedArray(24).fill(128) } }
  }
  const fs = {
    writeFile({ filePath, data, success }) {
      assert.deepEqual([...new Uint8Array(data)], [137, 80, 78, 71])
      files.set(filePath, data)
      success()
    },
    unlink({ filePath, success }) { files.delete(filePath); success() }
  }
  const wx = { env: { USER_DATA_PATH: 'wxfile://usr' }, getFileSystemManager: () => fs,
    createOffscreenCanvas: () => ({ createImage, getContext: () => context }) }
  return { wx, files }
}

test('loads cloud GLB geometry and embedded pixels without browser APIs or copying vertex data', async () => {
  const buffer = texturedTriangle()
  const { wx, files } = wxFixture()
  const originalTextDecoder = global.TextDecoder
  try {
    global.TextDecoder = undefined
    const root = await loadGlb(buffer, {}, wx)
    const mesh = root.children[0]
    const { position, uv } = mesh.geometry.attributes
    assert.equal(position.data, uv.data)
    assert.equal(position.data.array.buffer, buffer)
    assert.deepEqual([position.getX(1), position.getZ(2), uv.getX(1)], [2, 1, 1])
    assert.deepEqual(mesh.position.toArray(), [12, 0, -3])
    assert.equal(mesh.userData.title, '晴溪庄园 % / 🐾')
    assert.equal(mesh.material.map.colorSpace, THREE.SRGBColorSpace)
    assert.equal(mesh.material.map.flipY, false)
    assert.deepEqual([mesh.material.map.image.width, mesh.material.map.image.height], [3, 2])
    assert.equal(files.size, 0)
    let disposals = 0
    for (const resource of [mesh.geometry, mesh.material, mesh.material.map]) resource.addEventListener('dispose', () => disposals++)
    disposeModel(root)
    assert.equal(disposals, 3)
  } finally {
    global.TextDecoder = originalTextDecoder
  }
})

test('fails corrupt or cancelled loads and clears temporary texture files', async () => {
  const invalid = texturedTriangle()
  await assert.rejects(loadGlb(invalid.slice(0, -1), {}, null), /文件不完整/)
  const failed = wxFixture({ failDecode: true })
  await assert.rejects(loadGlb(invalid, {}, failed.wx), /3D 贴图读取失败：meadow.png/)
  assert.equal(failed.files.size, 0)
  let cancelled = false
  const stopped = wxFixture({ onImageLoad: () => { cancelled = true } })
  await assert.rejects(loadGlb(invalid, {}, stopped.wx, { isCancelled: () => cancelled }), { name: 'AbortError' })
  assert.equal(stopped.files.size, 0)
})
