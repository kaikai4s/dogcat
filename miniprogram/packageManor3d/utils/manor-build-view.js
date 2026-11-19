const RED_VILLA = 'red_tile_villa'
const COURTYARD = 'songying_courtyard'
const rotations = new Set([0, 90, 180, 270])
const finite = Number.isFinite
const yaw = rotation => -rotation * Math.PI / 180
const visualSpecs = {
  [RED_VILLA]: { width: 18.63, depth: 10.851, front: 1 },
  [COURTYARD]: {
    width: 26, depth: 36, front: -1, groundY: 0,
    // The full landscape counts toward placement; leave its paths walkable.
    obstacles: [
      [-.275, 16.275, 0, 14.26], [10.40, 18.70, 16.35, 23.80],
      [-4.94, -4.60, 5.33, 27.21], [20.58, 20.94, -6.1, 27.44],
      [-4.67, 20.67, 27.50, 27.84], [-3.89, .89, -6.38, -6.04],
      [9.21, 19.73, -6.38, -6.04]
    ]
  }
}

function createManorBuildView({ THREE, scene, disposeModel }) {
  const placed = new THREE.Group()
  placed.name = 'Built manor buildings'
  const overlay = new THREE.Group()
  overlay.name = 'Construction preview'
  const regions = new THREE.Group(), direction = new THREE.Group()
  regions.name = 'Buildable lots'
  direction.name = 'Building entrance direction'
  overlay.add(regions, direction)
  const models = new Map(), nodes = new Map(), occupied = new Set()
  let plots = new Map(), records = [], collision = [], preview = null, regionKey = ''
  let ghost = null, ghostModel = null, directionBuilding = ''

  function clearMeshes(parent) {
    for (const mesh of [...parent.children]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
      parent.remove(mesh)
    }
  }

  function quad(vertices, a, b, c, d, y) {
    vertices.push(a,y,c, a,y,d, b,y,c, b,y,c, a,y,d, b,y,d)
  }

  function draw(parent, vertices, color, opacity, order) {
    if (!vertices.length) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
      depthWrite: false, side: THREE.DoubleSide, fog: false })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = order
    parent.add(mesh)
  }

  function showRegions(values) {
    // The highlight covers the lot; aiming inside it still snaps to the legal center range.
    const plotIds = values.map(region => region.plotId)
    const key = JSON.stringify(plotIds)
    if (key === regionKey) return
    regionKey = key
    clearMeshes(regions)
    const fill = []
    for (const plotId of plotIds) {
      const plot = plots.get(plotId)
      if (!plot) continue
      quad(fill, plot.x-plot.width/2, plot.x+plot.width/2,
        plot.z-plot.depth/2, plot.z+plot.depth/2, plot.y+.14)
    }
    draw(regions, fill, 0x38ce90, .39, 3)
  }

  function instantiate(model, name, isPreview = false) {
    const anchor = new THREE.Group(), centered = new THREE.Group()
    const content = model.group.clone(true)
    anchor.name = name
    centered.position.set(-model.center.x, -model.groundY, -model.center.z)
    content.traverse(mesh => {
      if (!mesh.isMesh) return
      mesh.receiveShadow = !isPreview
      mesh.castShadow = !isPreview && (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        .every(material => !material.transparent)
      for (let part = mesh; mesh.castShadow && part && part !== content; part = part.parent) {
        if (part.name === 'Furniture') mesh.castShadow = false
      }
    })
    centered.add(content)
    anchor.add(centered)
    return { anchor, content }
  }

  function transform(node, record, y) {
    node.position.set(record.x, y, record.z)
    node.rotation.y = yaw(record.rotation)
  }

  function showPreview(value) {
    preview = value
    const spec = value && visualSpecs[value.buildingId]
    if (!spec) {
      overlay.removeFromParent()
      clearMeshes(regions)
      clearMeshes(direction)
      ghost?.removeFromParent()
      ghost = ghostModel = null
      regionKey = directionBuilding = ''
      return
    }
    if (!overlay.parent) scene.add(overlay)
    showRegions(value.regions || [])
    const canPreview = value.valid && [value.x, value.z, value.y].every(finite) && rotations.has(value.rotation)
    direction.visible = !!canPreview
    const model = canPreview ? models.get(value.buildingId) || null : null
    if (model !== ghostModel) {
      ghost?.removeFromParent()
      ghost = model ? instantiate(model, 'Building to construct', true).anchor : null
      ghostModel = model
      if (ghost) overlay.add(ghost)
    }
    if (!canPreview) return
    if (value.buildingId !== directionBuilding) {
      directionBuilding = value.buildingId
      clearMeshes(direction)
      const front = spec.front * (spec.depth/2 + .22)
      const pointer = [-.37,.3,front, .37,.3,front, -.37,.3,front + spec.front*.96,
        .37,.3,front, .37,.3,front + spec.front*.96, -.37,.3,front + spec.front*.96,
        -1.13,.3,front + spec.front*.96, 1.13,.3,front + spec.front*.96, 0,.3,front + spec.front*2.35]
      draw(direction, pointer, 0xa0ffc3, .98, 4)
    }
    transform(direction, value, value.y)
    if (ghost) transform(ghost, value, value.y)
  }

  function buildingBounds(model, anchor, spec) {
    anchor.updateMatrixWorld(true)
    const matrix = anchor.children[0].matrixWorld
    if (!spec.obstacles) return [model.bounds.clone().applyMatrix4(matrix)]
    return spec.obstacles.map(([x1, x2, z1, z2]) => new THREE.Box3(
      new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x2, model.bounds.max.y, z2)
    ).applyMatrix4(matrix))
  }

  function reconcile() {
    const remaining = new Set()
    let changed = false
    for (const record of records) {
      const plot = plots.get(record?.plotId), model = models.get(record?.buildingId), spec = visualSpecs[record?.buildingId]
      if (!plot || !model || !spec || record.deleted || ![record.x, record.z].every(finite) || !rotations.has(record.rotation) ||
          remaining.has(record.plotId)) continue
      const quarterTurn = record.rotation % 180 !== 0
      const width = quarterTurn ? spec.depth : spec.width, depth = quarterTurn ? spec.width : spec.depth
      if (Math.abs(record.x-plot.x) + width/2 > plot.width/2+.001 ||
          Math.abs(record.z-plot.z) + depth/2 > plot.depth/2+.001) continue
      remaining.add(record.plotId)
      const current = nodes.get(record.plotId)
      if (current?.model === model && current.x === record.x && current.z === record.z &&
          current.y === plot.y && current.rotation === record.rotation) continue
      current?.anchor.removeFromParent()
      const { anchor, content } = instantiate(model, 'Built building ' + (record.id || record.plotId))
      transform(anchor, record, plot.y)
      placed.add(anchor)
      nodes.set(record.plotId, { model, anchor, content, buildingId: record.buildingId, x: record.x, y: plot.y, z: record.z,
        rotation: record.rotation, bounds: buildingBounds(model, anchor, spec) })
      changed = true
    }
    for (const [id, node] of nodes) {
      if (remaining.has(id)) continue
      node.anchor.removeFromParent()
      nodes.delete(id)
      changed = true
    }
    if (changed) {
      occupied.clear()
      collision = []
      for (const [id, node] of nodes) {
        occupied.add(id)
        collision.push(...node.bounds)
      }
    }
    if (nodes.size && !placed.parent) scene.add(placed)
    if (!nodes.size) placed.removeFromParent()
    return changed
  }

  function setModel(id, group, borrowedBounds) {
    const spec = visualSpecs[id]
    if (!spec || !Object.prototype.hasOwnProperty.call(visualSpecs, id) || !group?.isObject3D || (!borrowedBounds && group.parent)) {
      throw new Error('建筑模型不可用')
    }
    const previous = models.get(id)
    if (previous?.group === group) return false
    const bounds = borrowedBounds ? borrowedBounds.clone() : new THREE.Box3().setFromObject(group)
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    if (![size.x, size.y, size.z].every(n => finite(n) && n > 0)) throw new Error('建筑模型尺寸有误')
    models.set(id, { group, bounds, center, groundY: spec.groundY ?? bounds.min.y, owned: !borrowedBounds })
    const changed = reconcile()
    if (preview) showPreview(preview)
    if (previous?.owned) disposeModel(previous.group)
    return changed
  }

  function forgetBorrowedModel(id, group) {
    const model = models.get(id)
    if (model?.group !== group || model?.owned) return false
    models.delete(id)
    const changed = reconcile()
    if (preview) showPreview(preview)
    return changed
  }

  return {
    hasModel: id => models.has(id), setModel, forgetBorrowedModel,
    placedModels(id) {
      return Array.from(nodes, ([plotId, node]) => node.buildingId === id ? { plotId, model: node.content } : null).filter(Boolean)
    },
    get collision() { return collision }, get occupied() { return occupied },
    setPlots(value, reset = false) {
      if (reset) records = []
      plots = new Map(value.map(plot => [plot.id, plot]))
      regionKey = ''
      return reconcile()
    },
    setPlaced(value) { records = Array.isArray(value) ? value : []; return reconcile() },
    showPreview,
    dispose() {
      showPreview(null)
      records = []
      reconcile()
      for (const model of models.values()) if (model.owned) disposeModel(model.group)
      models.clear()
    }
  }
}

module.exports = { createManorBuildView, RED_VILLA, COURTYARD, visualSpecs }
