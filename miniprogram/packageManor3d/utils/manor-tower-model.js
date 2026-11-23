const INVALID_TOWER = '小区住宅楼模型缺少有效的外景'
const EXTERIOR_LAYER = /^(?:Structure|Facade)(?:_\d+)?$/
const EXTERIOR_DOOR = /^(?:SouthEntry_[LR]|S[12]_Discharge|[A-D]_Balcony(?:Fixed|Slider))(?:_\d+)?$/
const MAX_BATCH_VERTICES = 65535
const FLOORS_PER_BATCH = 4

function collectMeshes(root, region = []) {
  root?.traverseVisible(node => {
    if (node.isMesh && node.geometry.attributes.position && node.material) region.push(node)
  })
  return region
}

function floorMeshes(floor) {
  const meshes = []
  for (const layer of floor.children) {
    if (EXTERIOR_LAYER.test(layer.name)) collectMeshes(layer, meshes)
    if (/^Doors(?:_\d+)?$/.test(layer.name)) {
      layer.children.filter(door => EXTERIOR_DOOR.test(door.name)).forEach(door => collectMeshes(door, meshes))
    }
  }
  if (!meshes.length) throw new Error(INVALID_TOWER)
  return meshes
}

// The uploaded model has static vertex-colored exterior meshes. Bake their
// transforms into shared 16-bit batches so nearby phones need no GPU instancing
// or 32-bit index extension to show multiple towers.
function buildBatches(THREE, copies, sharedMaterials, target) {
  const batches = []
  const active = new Map()
  for (const copy of copies) {
    for (const mesh of copy.meshes) {
      const geometry = mesh.geometry
      const material = mesh.material
      const position = geometry.attributes.position
      if (Array.isArray(material) || position.count > MAX_BATCH_VERTICES) throw new Error(INVALID_TOWER)
      let batch = active.get(material)
      if (!batch || batch.vertexCount + position.count > MAX_BATCH_VERTICES) {
        batch = { material, parts: [], vertexCount: 0, indexCount: 0 }
        active.set(material, batch)
        batches.push(batch)
      }
      batch.parts.push({ geometry, transform: new THREE.Matrix4().multiplyMatrices(copy.fromWorld, mesh.matrixWorld) })
      batch.vertexCount += position.count
      batch.indexCount += geometry.index?.count ?? position.count
    }
  }

  const local = new THREE.Vector3()
  const normalMatrix = new THREE.Matrix3()
  for (const batch of batches) {
    const vertices = new Float32Array(batch.vertexCount * 3)
    const normals = new Float32Array(batch.vertexCount * 3)
    const colors = new Float32Array(batch.vertexCount * 3)
    const indices = new Uint16Array(batch.indexCount)
    let vertexBase = 0
    let indexBase = 0
    for (const { geometry, transform } of batch.parts) {
      const { position, normal, color } = geometry.attributes
      if (!normal) throw new Error(INVALID_TOWER)
      normalMatrix.getNormalMatrix(transform)
      const flipped = transform.determinant() < 0
      for (let vertex = 0; vertex < position.count; vertex++) {
        const offset = (vertexBase + vertex) * 3
        local.fromBufferAttribute(position, vertex).applyMatrix4(transform).toArray(vertices, offset)
        local.fromBufferAttribute(normal, vertex).applyNormalMatrix(normalMatrix).toArray(normals, offset)
        if (color) local.fromBufferAttribute(color, vertex).toArray(colors, offset)
        else colors.fill(1, offset, offset + 3)
      }
      const index = geometry.index
      const count = index?.count ?? position.count
      for (let i = 0; i < count; i += 3) {
        const b = i + (flipped ? 2 : 1)
        const c = i + (flipped ? 1 : 2)
        indices[indexBase + i] = vertexBase + (index ? index.getX(i) : i)
        indices[indexBase + i + 1] = vertexBase + (index ? index.getX(b) : b)
        indices[indexBase + i + 2] = vertexBase + (index ? index.getX(c) : c)
      }
      indexBase += count
      vertexBase += position.count
    }
    const geometry = new THREE.BufferGeometry()
    for (const [name, array] of [['position', vertices], ['normal', normals], ['color', colors]]) {
      geometry.setAttribute(name, new THREE.BufferAttribute(array, 3))
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    let material = sharedMaterials.get(batch.material)
    if (!material) {
      material = batch.material.clone()
      material.vertexColors = true
      if (material.name === 'Glazing') {
        // Closed blue-grey window glass keeps the exterior from exposing rooms
        // whose walls and furnishings aren't needed in the outdoor scene.
        material.color.multiplyScalar(.77)
        material.opacity = 1
        material.transparent = false
        material.depthWrite = true
        material.side = THREE.FrontSide
      } else if (material.transparent) {
        material.forceSinglePass = true
      }
      sharedMaterials.set(batch.material, material)
    }
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = material.name
    mesh.receiveShadow = !material.transparent
    mesh.castShadow = !material.transparent
    target.add(mesh)
  }
}

function createManorTowerDisplay(THREE, model) {
  const floors = model.children.filter(node => /^Floor_\d{2}$/.test(node.name)).sort((a, b) => a.name.localeCompare(b.name))
  const site = model.children.find(node => node.name === 'Site')
  const roof = model.children.find(node => node.name === 'Roof')
  if (!site || !roof || floors.length !== 18 || floors.some((floor, i) => Number(floor.name.slice(6)) !== i + 1)) {
    throw new Error(INVALID_TOWER)
  }
  model.updateWorldMatrix(true, true)
  const fromWorld = new THREE.Matrix4().copy(model.matrixWorld).invert()
  const root = new THREE.Group()
  root.name = 'ManorTowerDisplay'
  const sharedMaterials = new Map()
  const translated = new THREE.Matrix4()
  try {
    for (const [name, meshes] of [['Podium', [...floorMeshes(floors[0]), ...collectMeshes(site)]],
      ['Roof', collectMeshes(roof)]]) {
      if (!meshes.length) throw new Error(INVALID_TOWER)
      const group = new THREE.Group()
      group.name = name
      root.add(group)
      buildBatches(THREE, [{ meshes, fromWorld }], sharedMaterials, group)
    }

    // Storeys 2–18 have the same exterior and regular spacing in this GLB.
    // Reuse each set of four floors, keeping lower and upper batches cullable.
    const regular = floorMeshes(floors[1])
    const sourceY = floors[1].position.y
    const templates = new Map()
    for (let index = 1; index < floors.length; index += FLOORS_PER_BATCH) {
      const count = Math.min(FLOORS_PER_BATCH, floors.length - index)
      let group = templates.get(count)?.clone(true)
      if (!group) {
        group = new THREE.Group()
        root.add(group)
        const copies = Array.from({ length: count }, (_, offset) => ({
          meshes: regular,
          fromWorld: translated.makeTranslation(0, floors[index + offset].position.y - floors[index].position.y - sourceY, 0)
            .clone().multiply(fromWorld)
        }))
        buildBatches(THREE, copies, sharedMaterials, group)
        templates.set(count, group)
      } else root.add(group)
      group.name = floors[index].name
      group.position.y = floors[index].position.y
    }
  } catch (error) {
    const geometries = new Set()
    root.traverse(node => { if (node.geometry) geometries.add(node.geometry) })
    geometries.forEach(geometry => geometry.dispose())
    sharedMaterials.forEach(material => material.dispose())
    throw error
  }
  return root
}

module.exports = { createManorTowerDisplay }
