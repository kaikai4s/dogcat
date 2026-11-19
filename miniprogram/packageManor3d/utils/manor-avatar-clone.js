function cloneAvatarModel(model) {
  const cloned = model.clone(true)
  cloned.animations = model.animations || []
  const nodeCopies = new Map()
  function index(source, copy) {
    nodeCopies.set(source, copy)
    source.children.forEach((child, i) => index(child, copy.children[i]))
  }
  index(model, cloned)
  const skeletons = new Map()
  for (const [source, copy] of nodeCopies) {
    if (!source.isSkinnedMesh) continue
    let skeleton = skeletons.get(source.skeleton)
    if (!skeleton) {
      skeleton = source.skeleton.clone()
      skeleton.bones = source.skeleton.bones.map(bone => nodeCopies.get(bone))
      skeletons.set(source.skeleton, skeleton)
    }
    copy.bind(skeleton, source.bindMatrix)
  }
  return cloned
}

function disposeAvatarSkeletons(model) {
  const skeletons = new Set()
  model.traverse(node => { if (node.isSkinnedMesh) skeletons.add(node.skeleton) })
  skeletons.forEach(skeleton => skeleton.dispose())
}

module.exports = { cloneAvatarModel, disposeAvatarSkeletons }
