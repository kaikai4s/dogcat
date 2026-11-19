function createAnimatedCharacter(THREE) {
  const model = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(.55, 1.6, .4), new THREE.MeshBasicMaterial())
  body.name = 'Body'
  body.position.y = .8
  model.add(body)

  const hips = new THREE.Bone()
  hips.name = 'Hips'
  hips.position.y = .8
  model.add(hips)

  const hipsClip = (name, startHeight, endHeight, startAngle = 0, endAngle = 0) => {
    const startHalfAngle = startAngle / 2
    const endHalfAngle = endAngle / 2
    return new THREE.AnimationClip(name, 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, startHeight, 0, 0, endHeight, 0]),
      new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [
        Math.sin(startHalfAngle), 0, 0, Math.cos(startHalfAngle),
        Math.sin(endHalfAngle), 0, 0, Math.cos(endHalfAngle)
      ])
    ])
  }
  const gaitClip = (name, angle) => new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack('Body.rotation[x]', [0, 1], [angle, angle])
  ])

  model.animations = [
    gaitClip('idle', .01), gaitClip('walk', .3), gaitClip('run', .7),
    hipsClip('sit_down', .8, .62), hipsClip('sit_idle', .62, .62), hipsClip('stand_up', .62, .8),
    hipsClip('lie_down', .8, .84, 0, -Math.PI / 2), hipsClip('lie_idle', .84, .84, -Math.PI / 2, -Math.PI / 2),
    hipsClip('wake_up', .84, .8, -Math.PI / 2, 0), hipsClip('drive_idle', .62, .62)
  ]
  return { model, body, hips }
}

module.exports = { createAnimatedCharacter }
