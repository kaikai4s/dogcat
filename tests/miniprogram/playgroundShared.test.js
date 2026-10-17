const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {World2D}=require('../../miniprogram/packagePlayground/utils/world2d')

test('backgrounding keeps the same scene and position; foreground resumes without initialization',async()=>{
  let page,paused=0,resumed=0,sent=0,started=0,initialized=0
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/pages/world.js'),'utf8'),{
    Page:(p)=>{page=p},wx:{},require:(name)=>name.includes('utils/cloud')?{ensureLogin:async()=>{}}:{},setTimeout,clearTimeout
  })
  page.setData=(v)=>Object.assign(page.data,v)
  const world={character:{position:{x:500,z:600}},setCharacterInput(){},pause(){paused++;this.paused=true},resume(){resumed++;this.paused=false},sceneSync:{stop:async()=>{sent++},start(){started++}}}
  page.world=world
  page.data.loading=false
  page.ready=true
  page.initialize=()=>{initialized++}
  page.onHide()
  assert.equal(page.world,world)
  assert.equal(paused,1)
  assert.equal(sent,1)
  assert.deepEqual(world.character.position,{x:500,z:600})
  page.onShow()
  await new Promise((resolve)=>setImmediate(resolve))
  assert.equal(resumed,1)
  assert.equal(started,1)
  assert.equal(initialized,0)
  assert.equal(page.world,world)
})

test('shared snapshot shows neighboring pets but only own pets are selectable or mutable',async()=>{
  const page={data:{},setData(v){Object.assign(this.data,v)},fetchRegion:async()=>({plots:[]})}
  const w=new World2D(page,null,{scene:{position:{x:100,z:100},serverTime:Date.now()},world:{width:224,height:224},pets:[]})
  w.buildWorld()
  const position={...w.character.position}
  const motion={epoch:Date.now()-4000,approach:[{x:110,z:110}],patrol:[{x:110,z:110},{x:116,z:110},{x:110,z:110}],wait:3}
  await w.applySceneRecords([
    {kind:'resident',mine:true,pets:[{id:'own',name:'我的猫',species:'cat',modelScale:1,motion}]},
    {kind:'resident',mine:false,pets:[{id:'other',name:'邻居的狗',species:'dog',modelScale:1,motion}]},
    {kind:'presence',id:'neighbor',name:'邻居',position:{x:120,z:120},online:false,characterType:'girl',lastSeen:0}
  ])
  assert.deepEqual(w.character.position,position)
  assert.equal(w.pets.length,2)
  assert.equal(w.remoteCharacters.length,1)
  assert.equal(w.selectPet('other'),false)
  assert.equal(w.setPetScale('other',2),false)
  assert.equal(w.selectPet('own'),true)
  w.update(0.1)
  assert.ok(w.pets.every((p)=>p.position.x>110))
  const before={...w.pets[0].position}
  w.pause()
  assert.deepEqual(w.pets[0].position,before)
  await w.applySceneRecords([])
  assert.equal(w.pets.length,0)
})

test('queued heartbeats acknowledge only the captured trail and departure is last',async()=>{
  let SceneSync
  const requests=[],pending=[]
  const sandbox={module:{exports:{}},exports:{},require:()=>({callFunction:(module,action,data)=>{
    requests.push(data)
    return new Promise((resolve)=>pending.push(resolve))
  }}),setTimeout,clearTimeout,Date}
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/utils/scene-sync.js'),'utf8'),sandbox)
  SceneSync=sandbox.module.exports.SceneSync
  const trail=[{x:1,z:1}],world={sceneState:()=>({trail:[...trail]}),ackSceneTrail:(count)=>trail.splice(0,count)}
  const sync=new SceneSync(world,{session:'session',sceneId:'a'})
  const online=sync.send(true)
  await new Promise((resolve)=>setImmediate(resolve))
  trail.push({x:2,z:2})
  const offline=sync.stop()
  pending[0]({accepted:true})
  await online
  await new Promise((resolve)=>setImmediate(resolve))
  assert.equal(requests[1].online,false)
  assert.equal(requests[1].trail.length,1)
  assert.equal(requests[1].trail[0].x,2)
  pending[1]({accepted:true})
  await offline
  assert.equal(trail.length,0)
})
