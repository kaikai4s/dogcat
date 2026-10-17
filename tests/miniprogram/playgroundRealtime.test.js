const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {World2D}=require('../../miniprogram/packagePlayground/utils/world2d')
const {sampleMotion}=require('../../miniprogram/packagePlayground/utils/shared-motion')
const settle=()=>new Promise((resolve)=>setImmediate(resolve))
function fixture(call,options={}) {
  let SceneSync,closed=0,nextTimer=1
  const watches=[],timers=new Map(),requests=[],queries=[],databaseOptions=[],connections=[],errors=[]
  const collection={where(query){return {limit(limit){return {watch(callbacks){
    queries.push({query,limit})
    if(options.validateQuery)options.validateQuery(query)
    watches.push(callbacks)
    return {close(){closed++}}
  }}}}}}
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/utils/scene-sync.js'),'utf8'),{
    module:{set exports(value){SceneSync=value.SceneSync}},
    require:()=>({getCloudEnv:()=>options.envId||'test-env',callFunction:async(module,action,data)=>{requests.push({action,data});return call?call(action,data):action==='getScene'?{serverTime:Date.now(),records:[],nextCursor:''}:{accepted:true,serverTime:Date.now()}}}),
    wx:{cloud:{database:(config)=>{databaseOptions.push(config);return {collection:()=>collection}}}},Date,
    setTimeout:(fn,delay)=>{const id=nextTimer++;timers.set(id,{fn,delay});return id},clearTimeout:(id)=>timers.delete(id)
  })
  const page={data:{},setData(v){Object.assign(this.data,v)},fetchRegion:async()=>({plots:[]})}
  const scene={session:'s',sceneId:'A',playerId:'me',realtimeCollection:'pet_playground_live',hasAvatar:true,serverTime:Date.now(),position:{x:100,z:100}}
  const w=new World2D(page,null,{scene,pets:[],world:{width:2240,height:2240}})
  w.buildWorld()
  const sync=new SceneSync(w,scene,(error)=>errors.push(error),(state)=>connections.push(state))
  w.sceneSync=sync
  return {sync,w,watches,timers,requests,queries,databaseOptions,connections,errors,closed:()=>closed}
}
function presence(x,seq) {return {id:'neighbor',ownerId:'other',kind:'presence',name:'凯大大',position:{x,z:100},characterType:'boy',moving:true,online:true,lastSeen:Date.now(),version:{epoch:1,seq}}}

test('presence-only pushes do not rebuild yards, resample pets or send pet UI updates',async()=>{
  const f=fixture();f.sync.start();await settle()
  const pet=f.w.applySharedPet({id:'pet',name:'豆豆',species:'dog',modelScale:1,
    motion:{epoch:Date.now(),approach:[{x:110,z:100}],patrol:[{x:110,z:100}]}},true)
  const position=pet.position,plots=f.w.sharedPlots
  let rebuilt=0,petUpdates=0
  f.w.applySceneRecords=async()=>{rebuilt++}
  f.w.onPetsChange=()=>{petUpdates++}
  for(let seq=1;seq<=4;seq++) {
    f.watches[0].onChange({docChanges:[{doc:{records:{neighbor:presence(110+seq,seq)}}}]})
    await settle()
  }
  assert.equal(rebuilt,0)
  assert.equal(petUpdates,0)
  assert.equal(f.w.pets[0],pet)
  assert.equal(pet.position,position)
  assert.equal(f.w.sharedPlots,plots)
  assert.equal(f.w.remoteCharacters[0].position.x,114)
  await f.sync.stop()
})

test('neighbors move continuously between delayed packets, stop precisely, and prediction does not cross fences',(t)=>{
  let time=100000
  t.mock.method(Date,'now',()=>time)
  const f=fixture()
  f.w.replaceCharacters([presence(110,1)])
  time+=200
  f.w.replaceCharacters([presence(111,2)])
  const person=f.w.remoteCharacters[0]
  time+=100;const a=f.w.neighborPosition(person).x
  time+=150;const b=f.w.neighborPosition(person).x
  time+=100;const c=f.w.neighborPosition(person).x
  assert.ok(a<b && b<=c && c>111 && c<=113.52)
  f.w.replaceCharacters([{...presence(112,3),moving:false}])
  time+=150
  assert.equal(f.w.neighborPosition(f.w.remoteCharacters[0]).x,112)
  time+=5000
  assert.equal(f.w.neighborPosition(f.w.remoteCharacters[0]).x,112)
  f.w.sharedPlots.set('yard',{id:'yard',x:100,z:100,size:48})
  f.w.replaceCharacters([{...presence(80,4),position:{x:80,z:127}}])
  time+=200
  f.w.replaceCharacters([{...presence(80,5),position:{x:80,z:126}}])
  time+=500
  assert.equal(f.w.neighborPosition(f.w.remoteCharacters[0]).z,126)
})

test('pet movement starts before cloud response, ignores old routes and reconciles only the current command',async()=>{
  const pending=[]
  const f=fixture((action)=>new Promise((resolve,reject)=>pending.push({resolve,reject})))
  const original={id:'pet',name:'豆豆',species:'dog',modelScale:1,
    motion:{epoch:Date.now(),approach:[{x:110,z:100}],patrol:[{x:110,z:100}]}}
  f.w.applySharedPet(original,true)
  const first=f.sync.movePet('pet',{x:125,z:100})
  await settle()
  const pet=f.w.pets[0],prediction=pet.sharedMotion
  assert.equal(prediction.approach.at(-1).x,125)
  assert.ok(sampleMotion(prediction,prediction.epoch+500).position.x>110)
  f.w.applySharedPet(original,true)
  assert.equal(pet.sharedMotion,prediction)
  const second=f.sync.movePet('pet',{x:130,z:100})
  await settle()
  pending[0].reject(new Error('旧指令已失效'))
  await assert.rejects(first,/旧指令/)
  assert.equal(pet.sharedMotion.approach.at(-1).x,130)
  const authoritative={...original,commandSeq:2,motion:{...prediction,approach:[{x:110,z:100},{x:130,z:100}],patrol:[{x:130,z:100}]}}
  pending[1].resolve({pet:authoritative})
  await second
  assert.equal(pet.pendingMove,null)
  f.w.applySharedPet({...original,commandSeq:1},true)
  assert.equal(pet.sharedMotion,authoritative.motion)
  const failed=f.sync.movePet('pet',{x:140,z:100})
  await settle()
  pending[2].reject(new Error('不能到达'))
  await assert.rejects(failed,/不能到达/)
  assert.equal(pet.sharedMotion,authoritative.motion)
})

test('small authoritative pet corrections ease in without a one-frame jump',(t)=>{
  let time=100000
  t.mock.method(Date,'now',()=>time)
  const f=fixture()
  const pet={id:'pet',name:'豆豆',species:'dog',modelScale:1,
    motion:{epoch:time,approach:[{x:110,z:100}],patrol:[{x:110,z:100}]}}
  f.w.applySharedPet(pet,true)
  const actor=f.w.pets[0]
  f.w.applySharedPet({...pet,motion:{...pet.motion,approach:[{x:111,z:100}],patrol:[{x:111,z:100}]}},true)
  assert.equal(actor.position.x,110)
  time+=75;f.w.update(.05)
  assert.equal(actor.position.x,110.5)
  time+=75;f.w.update(.05)
  assert.equal(actor.position.x,111)
})
test('watch events move neighboring characters immediately and do not wait for a scene poll',async()=>{
  const f=fixture();f.sync.start();await settle()
  const polls=f.requests.filter((r)=>r.action==='getScene').length
  f.watches[0].onChange({docs:[{records:{neighbor:presence(110,1)}}]})
  await settle()
  assert.equal(f.w.remoteCharacters[0].position.x,110)
  f.watches[0].onChange({docs:[{records:{neighbor:presence(111,2)}}]})
  await settle()
  assert.equal(f.w.remoteCharacters[0].position.x,111)
  assert.equal(f.requests.filter((r)=>r.action==='getScene').length,polls)
  assert.ok([...f.timers.values()].some((t)=>t.delay<=100))
  await f.sync.stop()
  assert.equal(f.closed(),2)
  f.watches[0].onChange({docs:[{records:{neighbor:presence(200,3)}}]})
  await settle()
  assert.equal(f.w.remoteCharacters[0].position.x,111)
})
test('late packets cannot undo motion or resurrect a deleted player; new sessions can appear again',async()=>{
  const f=fixture();f.sync.start();await settle()
  for(const record of [presence(120,2),presence(110,1),{id:'neighbor',kind:'presence',deleted:true,version:{epoch:2,seq:0}},presence(130,3)]) {
    f.watches[0].onChange({docs:[{records:{neighbor:record}}]});await settle()
  }
  assert.equal(f.w.remoteCharacters.length,0)
  const next={...presence(140,1),version:{epoch:3,seq:0}}
  f.watches[0].onChange({docs:[{records:{neighbor:next}}]});await settle()
  assert.equal(f.w.remoteCharacters[0].position.x,140)
  await f.sync.stop()
})
test('pet route pushes are shared immediately and render the owner with the pet name',async()=>{
  const f=fixture();f.sync.start();await settle()
  const motion={epoch:Date.now()-500,approach:[{x:110,z:100},{x:117,z:100}],patrol:[{x:117,z:100}],speed:7,roamSpeed:3,wait:3}
  f.watches[0].onChange({docs:[{records:{resident:{id:'resident',kind:'resident',ownerId:'other',ownerName:'凯大大',pets:[{id:'dog',name:'豆豆',species:'dog',modelScale:1,motion}],version:{epoch:1,seq:1}}}}]})
  await settle()
  assert.equal(f.w.pets[0].mine,false)
  const time=Date.now()+f.w.serverOffset
  const expected=sampleMotion(motion,time)
  assert.ok(Math.abs(f.w.pets[0].position.x-expected.position.x)<.2)
  const labels=[]
  f.w.ctx={save(){},restore(){},measureText:()=>({width:72})}
  f.w.camera={x:110,z:100};f.w.markerLabel=(name)=>labels.push(name);f.w.line=()=>{}
  f.w.drawPetNames()
  assert.deepEqual(labels,['凯大大的豆豆'])
  await f.sync.stop()
})
test('friendship mailbox pushes update collision permissions; strangers remain blocked and expiry closes the gate',async()=>{
  const f=fixture();f.sync.start();await settle()
  const plot={id:'yard',ownerId:'neighbor',instanceId:'v1',mine:false,x:100,z:100,size:48}
  f.w.sharedPlots.set(plot.id,plot)
  const a={x:100,z:126},b={x:100,z:122}
  f.w.character.position={...a}
  assert.equal(f.w.characterNavigation().clearSegment(a,b),false)
  f.watches[1].onChange({docs:[{revision:1,friends:[{id:'neighbor',name:'邻居'}],visits:{},incoming:[{id:'request',type:'friend'}]}]})
  assert.equal(f.w.characterNavigation().clearSegment(a,b),true)
  assert.equal(f.w.page.data.socialRequests.length,1)
  f.watches[1].onChange({docs:[{revision:2,friends:[],visits:{yard:{instanceId:'v1',expiresAt:Date.now()+f.w.serverOffset-1000}},incoming:[]}]})
  assert.equal(f.w.characterNavigation().clearSegment(a,b),false)
  f.watches[1].onChange({docs:[{revision:1,friends:[{id:'neighbor'}],visits:{}}]})
  assert.equal(f.w.characterNavigation().clearSegment(a,b),false)
  await f.sync.stop()
})

test('rejected movement reconciles only the character position and preserves the scene, camera and zoom',async()=>{
  const f=fixture((action,data)=>{
    if(action==='syncScene'&&data.online) throw new Error('移动过远，请重新进入场景')
    if(action==='getScene')return {serverTime:Date.now(),nextCursor:'',records:[{
      ...presence(110,1),id:'me',ownerId:'me',position:{x:110,z:105}
    }]}
    return {accepted:true,serverTime:Date.now()}
  })
  const messages=[]
  f.w.onStatus=(message)=>messages.push(message)
  f.w.character.position={x:180,z:190}
  f.w.sceneTrail=[{x:170,z:180}]
  f.w.camera={x:150,z:160};f.w.zoom=.6
  const assets=f.w.assets,character=f.w.character
  f.sync.start();await settle();await settle()
  assert.equal(f.w.character,character)
  assert.deepEqual({...f.w.character.position},{x:110,z:105})
  assert.equal(f.w.assets,assets)
  assert.deepEqual(f.w.camera,{x:150,z:160})
  assert.equal(f.w.zoom,.6)
  assert.equal(f.w.sceneTrail.length,0)
  assert.equal(f.w.recoveringScene,false)
  assert.ok(messages.some((message)=>message.includes('位置已校准')))
  await f.sync.stop()
})

test('an in-flight snapshot from a stopped generation cannot change the resumed scene',async()=>{
  let resolveSnapshot
  const f=fixture((action)=>action==='getScene'?new Promise((resolve)=>{resolveSnapshot=resolve}):{accepted:true})
  const snapshot=f.sync.snapshot()
  await f.sync.stop()
  resolveSnapshot({records:[presence(999,99)],nextCursor:'',serverTime:Date.now()})
  assert.equal(await snapshot,false)
  assert.equal(f.w.remoteCharacters.length,0)
})

test('reconnection backs off and ignores callbacks from an abandoned listener',async()=>{
  const f=fixture();f.sync.start();await settle()
  const error=new Error('connection closed')
  f.watches[0].onError(error)
  f.watches[0].onError(error)
  assert.equal(f.sync.channels.scene.attempts,1)
  const retry=[...f.timers.values()].find((timer)=>timer.delay===2000)
  assert.ok(retry)
  retry.fn()
  assert.equal(f.watches.length,3)
  f.watches[2].onError(error)
  assert.equal(f.sync.channels.scene.attempts,2)
  assert.ok([...f.timers.values()].some((timer)=>timer.delay===4000))
  f.watches[0].onChange({docs:[{records:{neighbor:presence(999,999)}}]})
  assert.equal(f.sync.records.has('neighbor'),false)
  await f.sync.stop()
})

test('private mailbox query satisfies ownership permissions and both watches use the API environment',async()=>{
  const f=fixture(undefined,{envId:'cloud1-test',validateQuery:(query)=>{
    if(query.kind==='mail'&&query._openid!=='{openid}')throw new Error('permission denied')
  }})
  f.sync.start();await settle()
  assert.equal(f.queries.length,2)
  const mailbox=f.queries.find((entry)=>entry.query.kind==='mail')
  assert.equal(mailbox.query._id,'mail_me')
  assert.equal(mailbox.query._openid,'{openid}')
  assert.equal(mailbox.limit,1)
  assert.ok(f.databaseOptions.every((config)=>config.env==='cloud1-test'))
  f.watches[0].onChange({docs:[]});f.watches[1].onChange({docs:[]})
  assert.equal(f.connections.at(-1).message,'')
  assert.equal(f.connections.at(-1).scene,'已连接')
  assert.equal(f.connections.at(-1).mail,'已连接')
  await f.sync.stop()
})

test('mailbox permission failure leaves scene movement live and clears the message when mailbox recovers',async()=>{
  const f=fixture();f.sync.start();await settle()
  f.watches[0].onChange({docs:[]})
  f.watches[1].onError({errCode:-502003,errMsg:'database permission denied'})
  assert.equal(f.closed(),1)
  assert.equal(f.sync.live,true)
  assert.equal(f.errors.length,0)
  assert.match(f.connections.at(-1).message,/场景已连接/)
  assert.match(f.connections.at(-1).details,/-502003/)
  f.watches[0].onChange({docs:[{records:{neighbor:presence(112,1)}}]})
  await settle()
  assert.equal(f.w.remoteCharacters[0].position.x,112)
  const retry=[...f.timers.values()].find((timer)=>timer.delay===2000)
  retry.fn()
  assert.equal(f.watches.length,3)
  f.watches[2].onChange({docs:[{revision:1,friends:[],incoming:[],outgoing:[],visits:{}}]})
  assert.equal(f.connections.at(-1).message,'')
  assert.equal(f.connections.at(-1).details,'')
  await f.sync.stop()
})

test('a synchronous private watch failure cannot close the public listener or hide its error details',async()=>{
  const f=fixture(undefined,{validateQuery:(query)=>{
    if(query.kind==='mail')throw {errCode:-502003,errMsg:'permission denied'}
  }})
  f.sync.start();await settle()
  assert.equal(f.watches.length,1)
  assert.equal(f.closed(),0)
  f.watches[0].onChange({docs:[{records:{neighbor:presence(113,1)}}]})
  await settle()
  assert.equal(f.w.remoteCharacters[0].position.x,113)
  assert.equal(f.sync.live,true)
  assert.match(f.connections.at(-1).details,/好友消息.*权限/)
  await f.sync.stop()
})

test('failed uploads and snapshots slow down retries rather than hammering the server',async()=>{
  const f=fixture((action,data)=>{
    if(action==='syncScene'&&data.online || action==='getScene')throw new Error('network unavailable')
    return {accepted:true}
  })
  f.sync.start();await settle()
  assert.equal(f.sync.sendFailures,1)
  assert.equal(f.sync.snapshotFailures,1)
  assert.ok([...f.timers.values()].some((timer)=>timer.delay===1000))
  assert.ok([...f.timers.values()].some((timer)=>timer.delay===2000))
  const retry=[...f.timers.values()].find((timer)=>timer.delay===1000)
  await retry.fn()
  assert.equal(f.sync.sendFailures,2)
  await f.sync.stop()
})
