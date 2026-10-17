const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { World2D, yardObstacles } = require('../../miniprogram/packagePlayground/utils/world2d')
const { PlayerCharacter, screenMovement } = require('../../miniprogram/packagePlayground/utils/player-character')
const { createNavigation } = require('../../miniprogram/packagePlayground/utils/navigation')
const { yardLayout } = require('../../miniprogram/packagePlayground/utils/yard-layout')
const { prepare } = require('../../miniprogram/packagePlayground/utils/asset-loader-2d')

function world(extra = {}) {
  const page = { data: {}, setData(v) { Object.assign(this.data, v) }, fetchRegion: async () => ({ plots: [] }) }
  const w = new World2D(page, null, {
    world: { width: 224, height: 224 },
    pets: [{ _id: 'dog', name: '豆豆', species: 'dog' }], ...extra
  })
  w.buildWorld()
  return w
}

test('joystick directions follow the screen projection with equal radial speed and a dead zone', () => {
  for (const [x,y] of [[1,0],[0,1],[-1,0],[0,-1],[1,1]]) {
    const v = screenMovement(x,y)
    const px = v.x-v.z, py=(v.x+v.z)*0.52
    assert.ok(Math.abs(px*y-py*x)<1e-8)
    assert.equal(v.strength,1)
    assert.ok(Math.abs(Math.hypot(v.x,v.z)-1)<1e-8)
  }
  assert.equal(screenMovement(0.05,0).strength,0)
  assert.equal(screenMovement(NaN,0).strength,0)
  assert.equal(screenMovement(0.5,0).strength,0.5)
})

test('character cannot tunnel through a fence and can cross the open gate', () => {
  const nav=createNavigation({minX:0,maxX:200,minZ:0,maxZ:200},yardObstacles({x:100,z:100,size:48}),0.8,1.5)
  const blocked=new PlayerCharacter({x:86,z:122})
  const gate=new PlayerCharacter({x:100,z:122})
  for(const player of [blocked,gate]) {
    player.setInput(-1,0.52)
    for(let i=0;i<20;i++) player.update(0.1,nav,()=>true)
  }
  assert.ok(blocked.position.z<122.6)
  assert.ok(gate.position.z>130)
  const edge=new PlayerCharacter({x:1,z:10})
  edge.setInput(-1,-0.52)
  for(let i=0;i<50;i++) edge.update(0.1,nav,()=>true)
  assert.ok(edge.position.x>=0.8)
})

test('unloaded terrain prevents motion; release stops immediately and preserves facing', () => {
  const nav=createNavigation({minX:0,maxX:200,minZ:0,maxZ:200},[],0.8)
  const p=new PlayerCharacter({x:100,z:100})
  p.setInput(1,0)
  p.update(0.1,nav,()=>false)
  assert.deepEqual(p.position,{x:100,z:100})
  assert.equal(p.moving,false)
  p.update(0.1,nav,()=>true)
  assert.equal(p.moving,true)
  const stopped={...p.position}
  p.setInput(0,0)
  assert.equal(p.moving,false)
  p.update(0.1,nav,()=>true)
  assert.deepEqual(p.position,stopped)
  assert.equal(p.mirrored,true)
})

test('pet interaction requires proximity and clear line of sight and pauses roaming', async () => {
  const w=world({plot:{id:'mine',mine:true,x:84,z:84,size:48}})
  w.selectPet('dog')
  w.character.position={x:58,z:84}
  w.pets[0].position={x:62,z:84}
  await w.prepareCharacterArea()
  assert.equal(w.nearbyInteractions().pet,null)
  assert.equal(w.interactPet('dog'),false)
  w.character.position={x:75,z:103}
  w.pets[0].position={x:77,z:103}
  await w.prepareCharacterArea()
  assert.equal(w.nearbyInteractions().pet.id,'dog')
  assert.equal(w.interactPet('dog'),true)
  assert.equal(w.interactPet('dog'),false)
  w.update(0.1)
  assert.equal(w.pets[0].route.length,0)
  assert.ok(w.pets[0].interactingUntil>w.elapsed)
})

test('food changes apply only to the current own bowl, with no distant interaction', async () => {
  const w=world({plot:{id:'mine',mine:true,x:84,z:84,size:48},foodBowls:{dog:0}})
  w.character.position={...yardLayout(w.ownPlot).stations.dog.eat}
  await w.prepareCharacterArea()
  assert.deepEqual(w.nearbyInteractions().bowl,{plotId:'mine',food:0})
  assert.equal(w.applyBowlFood({plotId:'old',food:100}),false)
  assert.equal(w.foodBowls.dog,0)
  assert.equal(w.applyBowlFood({plotId:'mine',food:100}),true)
  assert.equal(w.nearbyInteractions().bowl.food,100)
  w.character.position={x:150,z:150}
  assert.equal(w.nearbyInteractions().bowl,null)
})

test('failed navigation preload keeps the character blocked and retries after a delay', async () => {
  const w=world()
  w.page.fetchRegion=async()=>{throw new Error('offline')}
  w.character.setInput(1,0)
  await assert.rejects(w.prepareCharacterArea(),/offline/)
  const start={...w.character.position}
  w.update(0.1)
  assert.deepEqual(w.character.position,start)
  w.page.fetchRegion=async()=>({plots:[]})
  w.elapsed=3
  await w.prepareCharacterArea()
  w.update(0.1)
  assert.notDeepEqual(w.character.position,start)
})

test('prepared character images keep their original alpha and atlas dimensions', () => {
  const idle={width:512,height:512}
  const atlas={width:1024,height:768}
  assert.equal(prepare(idle,'boy_idle_sw'),idle)
  assert.equal(prepare(atlas,'boy_walk_sw'),atlas)
})

test('evicted navigation chunks block movement until they are loaded again', async () => {
  const w=world()
  await w.prepareCharacterArea()
  w.chunks.clear()
  w.character.setInput(1,0)
  let done
  w.page.fetchRegion=()=>new Promise(resolve=>{done=resolve})
  const start={...w.character.position}
  w.update(0.1)
  assert.deepEqual(w.character.position,start)
  assert.equal(w.nearbyInteractions().pet,null)
  w.destroy()
  if(done)done({plots:[]})
})

test('pet name labels avoid the character face and body', () => {
  const w=world()
  w.assets.boy_idle_sw={width:512,height:512}
  w.pets[0].position={...w.character.position}
  const labels=[]
  w.ctx={save(){},restore(){},measureText:()=>({width:24})}
  w.markerLabel=(name,x,y)=>labels.push({name,y})
  w.line=()=>{}
  w.drawPetNames()
  const feet=w.project(w.character.position.x,w.character.position.z)
  const head=feet.y-12*w.scale*w.zoom*0.9
  assert.ok(labels[0].y+11<head)
})

function pageFixture(save = async()=>({plotId:'mine',food:100})) {
  let page
  let time = 0, nextTimer = 1
  const timers = new Map()
  const toasts=[]
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../miniprogram/packagePlayground/pages/world.js'),'utf8'),{
    Page(p){page=p},
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, {fn, at:time+delay}); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name){return name.includes('world2d')?{}:{callFunction:save}},
    wx:{showToast(v){toasts.push(v)}}
  })
  page.setData=v=>Object.assign(page.data,v)
  page.world=world({plot:{id:'mine',mine:true,x:84,z:84,size:48}})
  page.data.loading=false
  page.data.joystickMode='hold'
  return {page,toasts, tick(ms) {
    time += ms
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() }
  }, timers}
}

test('floating joystick waits a full second, uses the press origin and release hides it without a pet command', () => {
  const {page,tick}=pageFixture()
  page.world.focusCharacter=()=>{}
  const input=[]
  page.world.setCharacterInput=(x,y)=>input.push([x,y])
  let taps=0
  page.world.moveTo=()=>{taps++}
  const touch={identifier:8,clientX:193,clientY:251}
  page.touchStart({touches:[touch]})
  tick(999)
  assert.equal(page.data.joystickActive,false)
  tick(1)
  assert.equal(page.joystickHeld,true)
  assert.equal(page.data.joystickActive,true)
  assert.equal(page.data.joystickLeft,121)
  assert.equal(page.data.joystickTop,179)
  page.touchMove({touches:[{...touch,clientX:205}]})
  assert.equal(input.at(-1)[0],0.25)
  page.touchMove({touches:[{...touch,clientX:500}]})
  assert.ok(Math.abs(input.at(-1)[0]-1)<1e-12)
  assert.equal(input.at(-1)[1],0)
  page.touchEnd({touches:[],changedTouches:[touch]})
  assert.equal(page.joystickHeld,false)
  assert.equal(page.data.joystickActive,false)
  assert.deepEqual(input.at(-1),[0,0])
  assert.equal(taps,0)
})

test('short taps, early drags, pinch, cancellation and page exit cannot leave or resurrect a joystick', () => {
  const touch={identifier:1,clientX:120,clientY:260}
  const other={identifier:2,clientX:220,clientY:260}
  for (const mode of ['tap','drag','pinch','cancel','hide']) {
    const {page,tick,timers}=pageFixture()
    page.world.focusCharacter=()=>{}
    let taps=0
    page.world.moveTo=()=>{taps++}
    page.touchStart({touches:[touch]})
    const stale=[...timers.values()][0].fn
    tick(500)
    if(mode==='tap') page.touchEnd({touches:[],changedTouches:[touch]})
    if(mode==='drag') page.touchMove({touches:[{...touch,clientX:132}]})
    if(mode==='pinch') page.touchStart({touches:[touch,other]})
    if(mode==='cancel') page.touchCancel()
    if(mode==='hide') page.stop()
    tick(1000)
    stale() // Simulate an already queued callback after clearTimeout.
    assert.equal(page.data.joystickActive,false,mode)
    assert.equal(taps,0,mode)
    assert.equal(timers.size,0,mode)
  }
})

test('second finger cancels an active joystick; remaining finger continues panning with no tap', () => {
  const {page,tick}=pageFixture()
  page.world.focusCharacter=()=>{}
  const a={identifier:1,clientX:120,clientY:260},b={identifier:2,clientX:220,clientY:260}
  let taps=0
  page.world.moveTo=()=>{taps++}
  page.touchStart({touches:[a]});tick(1000)
  page.touchMove({touches:[{...a,clientX:170}]})
  assert.equal(page.world.character.runRequested,true)
  page.touchStart({touches:[a,b]})
  assert.equal(page.data.joystickActive,false)
  assert.equal(page.world.character.moving,false)
  assert.ok(page.world.gesture.distance)
  page.touchEnd({touches:[a],changedTouches:[b]})
  assert.equal(page.world.gesture.moved,true)
  page.touchEnd({touches:[],changedTouches:[a]})
  assert.equal(taps,0)
})

test('native Canvas local x/y touches place the floating joystick correctly with an offset canvas', () => {
  const {page,tick}=pageFixture()
  page.world.canvasRect={left:20,top:40}
  page.world.focusCharacter=()=>{}
  const touch={identifier:3,x:110,y:240}
  page.touchStart({touches:[touch]});tick(1000)
  assert.equal(page.data.joystickLeft+72,130)
  assert.equal(page.data.joystickTop+72,280)
  page.touchMove({touches:[{...touch,x:158}]})
  assert.equal(page.world.character.runRequested,true)
  page.touchCancel()
  assert.equal(page.world.character.input.x,0)
})

test('analog distance selects walk or run with hysteresis, double maximum speed and distance-driven cadence', () => {
  const nav={clearSegment:()=>true}
  const p=new PlayerCharacter({x:100,z:100})
  p.setInput(0.5,0)
  p.update(0.1,nav,()=>true)
  const walkDistance=p.walkDistance
  assert.equal(p.runRequested,false)
  p.setInput(0.73,0);assert.equal(p.runRequested,true)
  p.setInput(0.68,0);assert.equal(p.runRequested,true)
  p.setInput(0.61,0);assert.equal(p.runRequested,false)
  p.setInput(1,0)
  const before=p.walkDistance
  p.update(0.1,nav,()=>true)
  assert.ok(Math.abs(p.walkDistance-before-1.4)<1e-8)
  assert.ok(p.walkDistance-before > walkDistance*2)
  const phase=p.animationPhase
  p.update(0.1,{clearSegment:()=>false},()=>true)
  assert.equal(p.moving,false)
  assert.equal(p.animationPhase,phase)
  p.setInput(0,0)
  assert.equal(p.runRequested,false)
})

test('renderer switches separate run and walk atlases and returns to idle when blocked', () => {
  const w=world()
  const calls=[]
  w.ctx={save(){},restore(){},translate(){},scale(){},drawImage(...args){calls.push(args)}}
  for(const name of ['boy_idle_sw','boy_walk_sw','boy_run_sw']) w.assets[name]={name,width:1024,height:768}
  w.camera={...w.character.position}
  w.character.moving=true
  w.character.animationPhase=0.5
  w.drawCharacter(false)
  assert.equal(calls.at(-1)[0].name,'boy_walk_sw')
  w.character.runRequested=true
  w.drawCharacter(false)
  assert.equal(calls.at(-1)[0].name,'boy_run_sw')
  assert.deepEqual(calls.at(-1).slice(1,5),[512,256,256,256])
  w.character.moving=false
  w.drawCharacter(false)
  assert.equal(calls.at(-1)[0].name,'boy_idle_sw')
  w.characterType='girl'
  for(const action of ['idle','walk','run']) w.assets['girl_'+action+'_sw']={name:action,width:1024,height:768}
  w.drawCharacter(false)
  assert.equal(calls.at(-1)[0].name,'idle')
  w.character.moving=true
  w.drawCharacter(false)
  assert.equal(calls.at(-1)[0].name,'run')
  w.character.runRequested=false
  w.drawCharacter(false)
  assert.equal(calls.at(-1)[0].name,'walk')
})

test('character changes preserve current images on failure and ignore late downloads', async () => {
  const w=world()
  const pending=[]
  w.loader={loadAll(_, names){return new Promise((resolve,reject)=>pending.push({names,resolve,reject}))}}
  const failed=w.setCharacterType('girl')
  pending[0].reject(new Error('offline'))
  await assert.rejects(failed,/offline/)
  assert.equal(w.characterType,'boy')
  const girl=w.setCharacterType('girl')
  const boy=w.setCharacterType('boy')
  assert.deepEqual(pending[1].names,['girl_idle_sw','girl_walk_sw','girl_run_sw'])
  pending[2].resolve({boy_idle_sw:{name:'boy'}})
  assert.equal(await boy,true)
  pending[1].resolve({girl_idle_sw:{name:'girl'}})
  assert.equal(await girl,false)
  assert.equal(w.characterType,'boy')
  const exiting=w.setCharacterType('girl')
  w.destroyed=true
  pending[3].resolve({girl_idle_sw:{}})
  assert.equal(await exiting,false)
  assert.equal(w.characterType,'boy')
})

test('feeding locks repeated taps, leaves food unchanged on failure and ignores completion after scene exit', async () => {
  let resolve, calls=0
  const {page}=pageFixture(()=>{calls++;return new Promise(done=>{resolve=done})})
  const w=page.world
  w.character.position={...yardLayout(w.ownPlot).stations.dog.eat}
  await w.prepareCharacterArea()
  const pending=page.fillBowl()
  await page.fillBowl()
  assert.equal(calls,1)
  page.world=world()
  resolve({plotId:'mine',food:100})
  await pending
  assert.equal(w.foodBowls.dog,0)
  const failed=pageFixture(async()=>{throw new Error('offline')})
  const next=failed.page.world
  next.character.position={...yardLayout(next.ownPlot).stations.dog.eat}
  await next.prepareCharacterArea()
  await failed.page.fillBowl()
  assert.equal(next.foodBowls.dog,0)
  assert.equal(failed.page.data.feeding,false)
  assert.equal(failed.toasts[0].title,'offline')
})
