const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')

function world() {
  const w = new World2D({ data: {}, setData() {} }, null, {
    pets: [{ _id: 'dog', name: '豆豆', playgroundScale: 1.5 }, { _id: 'cat', name: '团团', species: 'cat' }]
  })
  w.buildWorld()
  return w
}

test('pet size changes only that sprite and moves its name above the larger model', () => {
  const w = world()
  assert.equal(w.pets[0].modelScale, 1.5)
  assert.equal(w.pets[1].modelScale, 1)
  const position = { ...w.pets[0].position }
  const camera = { ...w.camera }
  const labels = []
  w.ctx = { save() {}, restore() {}, measureText: () => ({ width: 24 }) }
  w.markerLabel = (name, x, y) => labels.push({ name, y })
  w.line = () => {}
  w.pets[1].position.x += 100
  w.drawPetNames()
  const before = labels[0].y
  labels.length = 0
  w.setPetScale('dog', 2)
  w.drawPetNames()
  assert.ok(labels[0].y < before)
  assert.equal(w.pets[1].modelScale, 1)
  assert.deepEqual(w.pets[0].position, position)
  assert.deepEqual(w.camera, camera)
  assert.equal(w.pets[0].savedModelScale, 1.5)
  w.setPetScale('dog', 1, true)
  assert.equal(w.pets[0].savedModelScale, 1)
})

test('both standing and running sprites use the pet scale without resizing other pets', () => {
  const w = world()
  const calls = []
  w.ctx = new Proxy({}, { get: () => () => {} })
  w.sprite = (name, x, z, size) => calls.push({ name, size })
  w.drawPetNames = () => {}
  w.drawDestination = () => {}
  w.setPetScale('dog', 2)
  w.draw()
  assert.deepEqual(calls.map((v) => v.size), [14, 7])
  assert.equal(calls[0].name, 'dog_stand')
  calls.length = 0
  w.pets[0].moving = true
  w.draw()
  assert.equal(calls[0].name, 'dog_run')
  assert.equal(calls[0].size, 14)
})

function pageFixture(save) {
  let page
  const toasts = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page: (p) => { page = p },
    require: (name) => name.includes('world2d') ? {} : { callFunction: save },
    wx: { showToast: (v) => toasts.push(v) }
  })
  page.setData = (v) => Object.assign(page.data, v)
  page.world = world()
  page.world.selectPet('dog')
  page.data.selectedPetId = 'dog'
  return { page, toasts }
}

test('cat atlas crops all 20 frames across five rows, loops, holds first pose when idle and mirrors left', () => {
  const w=world(), calls=[], scales=[]
  w.assets.cat_walk={width:1024,height:1280}
  w.ctx={save(){},restore(){},translate(){},scale(...args){scales.push(args)},drawImage(...args){calls.push(args)}}
  const cat=w.pets[1]
  w.camera={...cat.position}
  cat.moving=true
  for(let index=0;index<21;index++) {
    cat.walkDistance=(index+0.01)*6/20
    w.drawPet(cat)
    const frame=index%20
    assert.deepEqual(calls.at(-1).slice(1,5),[frame%4*256,Math.floor(frame/4)*256,256,256])
  }
  cat.walkFacingLeft=true
  cat.modelScale=2
  cat.moving=false
  w.drawPet(cat)
  assert.deepEqual(calls.at(-1).slice(1,5),[0,0,256,256])
  assert.equal(calls.at(-1)[7],14*w.scale*w.zoom)
  assert.deepEqual(scales.at(-1),[-1,1])
})

test('dog atlas crops all six rows, loops after frame 24 and holds first frame while idle', () => {
  const w=world(), calls=[], scales=[]
  w.assets.dog_walk={width:1024,height:1536}
  w.ctx={save(){},restore(){},translate(){},scale(...args){scales.push(args)},drawImage(...args){calls.push(args)}}
  const dog=w.pets[0]
  w.camera={...dog.position}
  dog.moving=true
  for(let index=0;index<25;index++) {
    dog.walkDistance=(index+0.01)*7.2/24
    w.drawPet(dog)
    const frame=index%24
    assert.deepEqual(calls.at(-1).slice(1,5),[frame%4*256,Math.floor(frame/4)*256,256,256])
  }
  dog.walkFacingLeft=true
  dog.modelScale=2
  dog.moving=false
  w.drawPet(dog)
  assert.deepEqual(calls.at(-1).slice(1,5),[0,0,256,256])
  assert.equal(calls.at(-1)[7],14*w.scale*w.zoom)
  assert.deepEqual(scales.at(-1),[-1,1])
})

test('cat walking cadence follows traveled distance and stops while resting', () => {
  const w=world(), cat=w.pets[1]
  w.updateCharacter=()=>{}
  w.emitNearby=()=>{}
  const start={...cat.position}
  cat.route=[{x:start.x-2,z:start.z}]
  cat.mode='manual'
  w.update(0.1)
  assert.ok(Math.abs(cat.walkDistance-0.7)<1e-8)
  assert.equal(cat.walkFacingLeft,true)
  cat.route=[]
  const before=cat.walkDistance
  w.update(0.1)
  assert.equal(cat.walkDistance,before)
  assert.equal(cat.moving,false)
})

test('slider previews locally and saves once on release; failure restores the saved size', async () => {
  let calls = 0
  let fail = false
  const { page, toasts } = pageFixture(async (module, action, data) => {
    calls++
    assert.equal(action, 'setPetScale')
    assert.equal(data.petId, 'dog')
    if (fail) throw new Error('网络异常')
    return { scale: data.scale }
  })
  page.previewPetScale({ detail: { value: 175 } })
  assert.equal(calls, 0)
  assert.equal(page.world.pets[0].modelScale, 1.75)
  await page.savePetScale({ detail: { value: 175 } })
  assert.equal(calls, 1)
  assert.equal(page.world.pets[0].savedModelScale, 1.75)
  fail = true
  page.previewPetScale({ detail: { value: 200 } })
  await page.savePetScale({ detail: { value: 200 } })
  assert.equal(page.world.pets[0].modelScale, 1.75)
  assert.equal(page.data.petScaleSaving, false)
  assert.equal(toasts[0].title, '网络异常')
})

test('save completion after leaving the scene does not change its replacement', async () => {
  let resolve
  const { page } = pageFixture(() => new Promise((done) => { resolve = done }))
  const pending = page.savePetScale({ detail: { value: 200 } })
  page.world = world()
  resolve({ scale: 2 })
  await pending
  assert.equal(page.world.pets[0].modelScale, 1.5)
})
