const { THREE, GLTFLoader } = require('../vendor/three-runtime')

const devices = new WeakMap()
const COMPONENT_ARRAYS = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
}
const ITEM_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const MAX_TEXTURE_SIDE = 2048
const SUPPORTED_EXTENSIONS = new Set([
  'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization', 'EXT_mesh_gpu_instancing'
])

function isWebGL2(gl) {
  return typeof gl.texStorage2D === 'function' && typeof gl.createVertexArray === 'function' &&
    typeof gl.drawElementsInstanced === 'function'
}

function createRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('无法获取 3D 庄园画布')
  const attributes = { alpha: false, antialias: !!options.antialias, stencil: false, preserveDrawingBuffer: false }
  let gl
  for (const name of ['webgl2', 'webgl', 'experimental-webgl']) {
    try { gl = canvas.getContext(name, attributes) } catch (_) { /* Try the next context. */ }
    if (gl) break
  }
  if (!gl) throw new Error('当前设备无法开启 3D 渲染')

  // WebGLRenderer needs DOM-shaped sizing and listeners; WeChat Canvas only
  // guarantees the node's width, height and context. Keep the native node intact.
  const listeners = (method, args) => {
    if (typeof canvas[method] === 'function') canvas[method](...args)
  }
  const adapter = {
    get width() { return canvas.width },
    set width(value) { canvas.width = value },
    get height() { return canvas.height },
    set height(value) { canvas.height = value },
    style: {},
    getContext() { return gl },
    addEventListener(...args) { listeners('addEventListener', args) },
    removeEventListener(...args) { listeners('removeEventListener', args) }
  }
  const renderer = new THREE.WebGLRenderer({ canvas: adapter, ...attributes })
  const webgl2 = isWebGL2(gl)
  devices.set(canvas, {
    webgl2,
    uint32: webgl2 || !!gl.getExtension('OES_element_index_uint'),
    floatVertexTextures: renderer.capabilities.floatVertexTextures,
    maxTextureSize: Math.min(MAX_TEXTURE_SIDE, renderer.capabilities.maxTextureSize || MAX_TEXTURE_SIDE)
  })
  return renderer
}

function decodeJson(bytes) {
  if (typeof TextDecoder === 'function') return JSON.parse(new TextDecoder().decode(bytes))
  // WeChat's service runtime may not expose TextDecoder. Convert short chunks
  // to an escaped UTF-8 string while keeping multi-byte characters intact.
  const parts = []
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 8192, bytes.length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++
    let part = ''
    for (let i = start; i < end; i++) {
      const b = bytes[i]
      part += b < 128 && b !== 37 ? String.fromCharCode(b) : '%' + b.toString(16).padStart(2, '0')
    }
    parts.push(decodeURIComponent(part))
    start = end
  }
  return JSON.parse(parts.join('').replace(/^﻿/, ''))
}

function readGlb(input) {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 28 || view.getUint32(0, true) !== GLB_MAGIC ||
      view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== view.byteLength) {
    throw new Error('3D 模型文件不完整')
  }
  const jsonEnd = 20 + view.getUint32(12, true)
  if (jsonEnd % 4 || jsonEnd + 8 > view.byteLength || view.getUint32(16, true) !== JSON_CHUNK ||
      view.getUint32(jsonEnd + 4, true) !== BIN_CHUNK) throw new Error('3D 模型没有有效的几何数据')
  const json = decodeJson(bytes.subarray(20, jsonEnd))
  const payloadLength = view.getUint32(jsonEnd, true)
  const payloadStart = jsonEnd + 8
  const buffers = json.buffers || []
  if (payloadStart + payloadLength !== bytes.length || json.asset?.version !== '2.0' ||
      buffers.length !== 1 || buffers[0].uri || !Number.isSafeInteger(buffers[0].byteLength) ||
      buffers[0].byteLength < 0 || buffers[0].byteLength > payloadLength ||
      (json.extensionsRequired || []).some((ext) => !SUPPORTED_EXTENSIONS.has(ext))) {
    throw new Error('3D 模型使用了当前庄园不支持的格式')
  }
  const buffer = bytes.buffer
  const offset = bytes.byteOffset + payloadStart
  const bufferViews = (json.bufferViews || []).map((definition) => {
    const { byteOffset = 0, byteLength, byteStride } = definition
    if (definition.buffer !== 0 || !Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
        !Number.isSafeInteger(byteLength) || byteLength < 0 || byteOffset + byteLength > buffers[0].byteLength) {
      throw new Error('3D 模型包含无效的数据块')
    }
    return { offset: offset + byteOffset, length: byteLength, byteStride }
  })
  return { json, buffer, bufferViews }
}

function checkedView(buffer, Type, view, offset, count) {
  const start = view.offset + offset
  const size = Type.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0 ||
      offset + count * size > view.length) throw new Error('3D 模型的顶点数据不完整')
  if (start % size === 0) return new Type(buffer, start, count)
  return new Type(buffer.slice(start, start + count * size))
}

function accessorReader({ json, buffer, bufferViews }) {
  const interleaved = new Map()
  return (index) => {
    const accessor = json.accessors[index]
    const { bufferView, componentType, type, normalized = false, byteOffset = 0, count } = accessor
    const Type = COMPONENT_ARRAYS[componentType]
    const itemSize = ITEM_SIZES[type]
    const view = bufferViews[bufferView]
    if (!Type || !itemSize || !view || accessor.sparse || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('3D 模型包含不兼容的顶点格式')
    }
    const size = Type.BYTES_PER_ELEMENT
    const stride = view.byteStride
    if (stride && stride !== size * itemSize) {
      const within = byteOffset % stride
      if (stride % size || within % size || within + size * itemSize > stride) {
        throw new Error('3D 模型包含无效的顶点布局')
      }
      const start = byteOffset - within
      const key = [bufferView, componentType, start, count].join(':')
      let data = interleaved.get(key)
      if (!data) {
        data = new THREE.InterleavedBuffer(checkedView(buffer, Type, view, start, count * stride / size), stride / size)
        interleaved.set(key, data)
      }
      return new THREE.InterleavedBufferAttribute(data, itemSize, within / size, normalized)
    }
    return new THREE.BufferAttribute(checkedView(buffer, Type, view, byteOffset, count * itemSize), itemSize, normalized)
  }
}

function fsCall(fs, method, args) {
  return new Promise((resolve, reject) => fs[method]({ ...args, success: resolve, fail: reject }))
}

function readImage(canvas, path) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage()
    const finish = (error) => {
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      if (error) reject(error)
      else resolve(image)
    }
    const timer = setTimeout(() => finish(new Error('贴图解码超时')), 15000)
    image.onload = () => finish()
    image.onerror = () => finish(new Error('贴图无法解码'))
    try { image.src = path } catch (error) { finish(error) }
  })
}

function verifyActive(isCancelled) {
  if (isCancelled && isCancelled()) {
    const error = new Error('已取消加载 3D 庄园')
    error.name = 'AbortError'
    throw error
  }
}

async function decodeImages(asset, wx, device, options) {
  const { json, buffer, bufferViews } = asset
  const definitions = json.images || []
  if (!definitions.length) return []
  const fs = wx?.getFileSystemManager?.()
  const dir = wx?.env?.USER_DATA_PATH
  if (!dir || !fs || typeof fs.writeFile !== 'function' || typeof fs.unlink !== 'function' ||
      typeof wx.createOffscreenCanvas !== 'function') throw new Error('当前微信版本无法解码 3D 贴图')

  const surface = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 })
  const context = surface?.getContext?.('2d')
  if (!context || typeof surface.createImage !== 'function') throw new Error('当前设备无法创建贴图画布')
  const paths = dir + '/dogcat_manor_texture_' + Date.now() + '_' + Math.random().toString(36).slice(2)
  const images = new Array(definitions.length)
  const repeating = new Set((json.textures || []).filter((texture) => {
    const sampler = (json.samplers || [])[texture.sampler] || {}
    return sampler.wrapS !== 33071 || sampler.wrapT !== 33071
  }).map((texture) => texture.source))
  let next = 0
  let failure

  async function worker() {
    while (!failure && next < definitions.length) {
      const i = next++
      const def = definitions[i]
      const view = bufferViews[def.bufferView]
      const extension = def.mimeType === 'image/png' ? '.png' : def.mimeType === 'image/jpeg' ? '.jpg' : ''
      const path = paths + '_' + i + extension
      try {
        verifyActive(options.isCancelled)
        if (!extension || !view || !view.length || def.uri) throw new Error('无法读取内嵌的 PNG 或 JPEG')
        await fsCall(fs, 'writeFile', { filePath: path, data: buffer.slice(view.offset, view.offset + view.length) })
        if (failure) return
        verifyActive(options.isCancelled)
        const image = await readImage(surface, path)
        verifyActive(options.isCancelled)
        if (!(image.width > 0 && image.height > 0)) throw new Error('贴图尺寸不正确')
        const scale = Math.min(1, device.maxTextureSize / Math.max(image.width, image.height))
        let width = Math.max(1, Math.floor(image.width * scale))
        let height = Math.max(1, Math.floor(image.height * scale))
        if (!device.webgl2 && repeating.has(i)) {
          width = THREE.MathUtils.floorPowerOfTwo(width)
          height = THREE.MathUtils.floorPowerOfTwo(height)
        }
        surface.width = width
        surface.height = height
        context.clearRect(0, 0, width, height)
        context.drawImage(image, 0, 0, width, height)
        const rgba = context.getImageData(0, 0, width, height).data
        images[i] = { data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height }
      } catch (error) {
        if (!failure) {
          failure = error?.name === 'AbortError' ? error : new Error('3D 贴图读取失败：' + (def.name || i + 1))
          if (failure !== error) failure.cause = error
        }
      } finally {
        try { await fsCall(fs, 'unlink', { filePath: path }) } catch (_) { /* A failed write may leave no file. */ }
      }
    }
  }

  try {
    await Promise.all([worker(), worker()])
    if (failure) throw failure
    return images
  } finally {
    surface.width = 1
    surface.height = 1
  }
}

function collectModelResources(root) {
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  const skeletons = new Set()
  root.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry)
    if (node.material) (Array.isArray(node.material) ? node.material : [node.material]).forEach((material) => materials.add(material))
    if (node.isSkinnedMesh && node.skeleton) skeletons.add(node.skeleton)
  })
  materials.forEach((material) => {
    Object.keys(material).forEach((key) => {
      if (material[key]?.isTexture) textures.add(material[key])
    })
  })
  return { geometries, materials, textures, skeletons }
}

function prepareTextures(root, device) {
  const converted = new WeakMap()
  let linearLookup
  collectModelResources(root).textures.forEach((texture) => {
    const image = texture.image
    const mipAllowed = device.webgl2 || (THREE.MathUtils.isPowerOfTwo(image.width) && THREE.MathUtils.isPowerOfTwo(image.height))
    if (!mipAllowed) {
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
      if (texture.minFilter !== THREE.NearestFilter) texture.minFilter = THREE.LinearFilter
    }
    texture.generateMipmaps = mipAllowed && texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter
    if (!device.webgl2 && texture.colorSpace === THREE.SRGBColorSpace) {
      // Keep mipmaps and the original alpha channel on WebGL 1 devices. Three's
      // automatic EXT_sRGB path disables mipmaps, important for the vast meadow.
      let source = converted.get(image)
      if (!source) {
        if (!linearLookup) {
          linearLookup = Uint8Array.from({ length: 256 }, (_, i) => {
            const c = i / 255
            return Math.round(255 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          })
        }
        const data = image.data.slice()
        for (let i = 0; i < data.length; i += 4) {
          data[i] = linearLookup[data[i]]
          data[i + 1] = linearLookup[data[i + 1]]
          data[i + 2] = linearLookup[data[i + 2]]
        }
        source = new THREE.Source({ ...image, data })
        converted.set(image, source)
      }
      texture.source = source
      texture.colorSpace = THREE.LinearSRGBColorSpace
    }
    texture.needsUpdate = true
  })
}

async function loadGlb(input, canvas, wx, options = {}) {
  verifyActive(options.isCancelled)
  const asset = readGlb(input)
  const device = devices.get(canvas) || { webgl2: true, uint32: true, floatVertexTextures: true, maxTextureSize: MAX_TEXTURE_SIDE }
  if (!device.uint32 && asset.json.meshes.some((mesh) => mesh.primitives.some((p) => asset.json.accessors[p.indices]?.componentType === 5125))) {
    throw new Error('当前设备的图形能力不足，无法显示 3D 庄园地形')
  }
  if (!device.floatVertexTextures && asset.json.skins?.length) {
    throw new Error('当前设备的图形能力不足，无法显示 3D 庄园角色')
  }
  const images = await decodeImages(asset, wx, device, options)
  verifyActive(options.isCancelled)
  const loader = new GLTFLoader().register((parser) => {
    // Preserve the GLB's typed views instead of making a second copy of the
    // ~56 MiB terrain buffer. Let upstream Three interpret nodes and materials.
    const readAccessor = accessorReader(asset)
    parser.loadAccessor = (index) => Promise.resolve(readAccessor(index))
    parser.loadImageSource = async (index) => {
      const image = images[index]
      if (!image) throw new Error('3D 模型缺少贴图')
      return new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat)
    }
    return { name: 'DOGCAT_manor_embedded_glb' }
  })
  const { scene, animations } = await loader.parseAsync(asset.json, '')
  try {
    verifyActive(options.isCancelled)
    prepareTextures(scene, device)
    scene.animations = animations
    return scene
  } catch (error) {
    disposeModel(scene)
    throw error
  }
}

function disposeModel(root) {
  if (!root) return
  const { geometries, materials, textures, skeletons } = collectModelResources(root)
  geometries.forEach((geometry) => geometry.dispose())
  materials.forEach((material) => material.dispose())
  textures.forEach((texture) => texture.dispose())
  skeletons.forEach((skeleton) => skeleton.dispose())
}

module.exports = { THREE, createRenderer, loadGlb, disposeModel }
