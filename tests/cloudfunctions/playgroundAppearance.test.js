const test=require('node:test')
const assert=require('node:assert/strict')
const {createCollectionStore,loadCloudFunction}=require('./helpers')
const createAppearance=require('../../cloudfunctions/api/services/playground-appearance')
const {inspectAtlas}=require('../../cloudfunctions/api/services/playground-appearance-png')
const world=require('../../cloudfunctions/api/services/playground-world')
const {atlas}=require('../fixtures/appearanceAtlas')
const REQUESTS=createAppearance.REQUESTS,BINDINGS=createAppearance.BINDINGS
const fileID=(path)=>'cloud://test.bucket/'+path
const pid=(openid)=>'presence_'+world.hash(openid)
function requireOrderedTransactions(db) {
  const runTransaction=db.runTransaction.bind(db)
  db.runTransaction=(callback)=>runTransaction((tx)=>{
    let active=0
    return callback({...tx,collection(name) {
      const collection=tx.collection(name),doc=collection.doc.bind(collection)
      collection.doc=(id)=>{
        const document=doc(id)
        for(const method of ['get','set','update','remove']) {
          const operation=document[method].bind(document)
          document[method]=async(...args)=>{
            assert.equal(active,0,'requests on the same transaction must not overlap (TransactionBusy)')
            active++
            try {
              await new Promise((resolve)=>setImmediate(resolve))
              return await operation(...args)
            } finally {active--}
          }
        }
        return document
      }
      return collection
    }})
  })
}
function fixture() {
  let time=1800000000000
  const db=createCollectionStore({users:['a','b','admin'].map((openid)=>({_id:'u_'+openid,openid,status:'active',roles:openid==='admin'?['admin']:['client'],nickname:openid,residentialCommunity:{name:'A小区',address:'路'}})),
    pets:[{_id:'pet_a',openid:'a',name:'豆豆',species:'dog'},{_id:'pet_a2',openid:'a',name:'豆豆',species:'cat'},{_id:'pet_b',openid:'b',name:'豆豆',species:'dog'}]}, {cloudObjectUpdates:true})
  requireOrderedTransactions(db)
  const files=new Map(),uploaded=[],checks=[]
  const cloud={downloadFile:async({fileID})=>{if(!files.has(fileID))throw new Error('file missing');return {fileContent:files.get(fileID)}},
    uploadFile:async({cloudPath,fileContent})=>{const id=fileID(cloudPath);files.set(id,Buffer.from(fileContent));uploaded.push(id);return {fileID:id}},
    getTempFileURL:async({fileList})=>({fileList:fileList.map((p)=>({tempFileURL:'https://private.example/'+encodeURIComponent(p.fileID)}))})}
  const context={db,cloud,nowMs:()=>time,nowText:()=>new Date(time).toISOString(),safeText:(v)=>String(v||''),
    skipEligibilityCheck:true,
    checkTextSecurity:async(...args)=>checks.push(['text',...args]),checkImageSecurity:async(...args)=>checks.push(['image',...args])}
  const service=createAppearance(context)
  const draft=(owner='a',pet='pet_a',type='pet')=>service.createDraft(owner,{targetType:type,petId:pet})
  async function pending(owner='a',pet='pet_a',type='pet') {
    const row=await draft(owner,pet,type),photo=fileID(row.photoPrefix+'reference.jpg')
    files.set(photo,Buffer.from([255,216,255,224,1,2]))
    await service.submit(owner,{requestId:row._id,photos:[photo],remark:'奶油色'})
    return row
  }
  async function batch(row,bytes=atlas(),admin='admin') {
    const ready=await service.prepareUpload(admin,{requestId:row._id})
    const walkFileID=fileID(ready.walkPath);files.set(walkFileID,bytes)
    return {requestId:row._id,token:ready.token,walkFileID}
  }
  return {db,cloud,files,uploaded,checks,context,service,draft,pending,batch,advance:()=>++time,
    entity:(pet)=>db.state.pets.find((p)=>p._id===pet),user:(owner)=>db.state.users.find((p)=>p.openid===owner)}
}

test('24-frame PNG decoder canonicalizes all filters, compression and invisible RGB',()=>{
  const base=inspectAtlas(atlas()).digest
  for(let filter=0;filter<=4;filter++)assert.equal(inspectAtlas(atlas({filter,hidden:99,level:1})).digest,base)
  assert.notEqual(inspectAtlas(atlas({color:101})).digest,base)
  assert.equal(inspectAtlas(atlas()).frames,24)
})
test('invalid art is rejected for wrong grid, missing frames, opaque background and corrupt data',()=>{
  for(const bytes of [atlas({columns:3}),atlas({blank:23}),atlas({opaque:true}),atlas().subarray(0,80),Buffer.from('not a PNG')])assert.throws(()=>inspectAtlas(bytes))
  const corrupt=atlas();corrupt[80]^=1
  assert.throws(()=>inspectAtlas(corrupt),/校验/)
})
test('application target is owned, immutable, and photos belong to the exact request',async()=>{
  const f=fixture()
  await assert.rejects(()=>f.draft('b','pet_a'),/不属于/)
  const row=await f.draft()
  assert.equal((await f.draft())._id,row._id)
  await assert.rejects(()=>f.service.submit('b',{requestId:row._id,photos:[]}),/无权/)
  await assert.rejects(()=>f.service.submit('a',{requestId:row._id,photos:[fileID('other/photo.jpg')]}),/参考照片/)
  await assert.rejects(()=>f.service.submit('a',{requestId:row._id,photos:[]}),/参考照片/)
  const photo=fileID(row.photoPrefix+'one.jpg');f.files.set(photo,Buffer.from([255,216,1,2]))
  await f.service.submit('a',{requestId:row._id,photos:[photo],targetId:'pet_b',targetType:'character',remark:'豆豆'})
  assert.equal(f.db.state[REQUESTS][0].targetId,'pet_a')
  await assert.rejects(()=>f.draft(),/待处理/)
  assert.equal(f.checks.filter((c)=>c[0]==='image').length,1)
  assert.equal((await f.service.list('b',{})).list.length,0)
  await assert.rejects(()=>f.service.detail('b',{requestId:row._id}),/无权/)
  assert.ok((await f.service.detail('admin',{requestId:row._id},true)).photoUrls[0].startsWith('https://'))
})
test('publishing binds only the exact pet, uploads an immutable copy and updates the shared scene without moving it',async()=>{
  const f=fixture(),plots=world.create(f.context),shared=require('../../cloudfunctions/api/services/playground-shared')(f.context)
  await plots.claim('a',f.user('a'),{x:280,z:280})
  const scene=await shared.enter('a',f.user('a'),{},[f.entity('pet_a'),f.entity('pet_a2')])
  const before=structuredClone(f.db.state.pet_playground_plots.find((r)=>r._id==='resident_'+world.hash('a')))
  const actorBefore=structuredClone(f.db.state.pet_playground_plots.find((r)=>r._id===pid('a')))
  const row=await f.pending(),batch=await f.batch(row)
  const result=await f.service.publish('admin',{...batch,targetId:'pet_b',ownerOpenid:'b'})
  assert.equal(result.completed,true);assert.equal(result.syncPending,false)
  assert.equal(f.entity('pet_a').playgroundAppearance.targetId,'pet_a')
  assert.equal(f.entity('pet_a2').playgroundAppearance,undefined)
  assert.equal(f.entity('pet_b').playgroundAppearance,undefined)
  assert.equal(f.user('a').playgroundAppearance,undefined)
  assert.ok(result.appearance.walk.fileID.includes('/packagePlayground/custom/target_'))
  assert.notEqual(result.appearance.walk.fileID,batch.walkFileID)
  const after=f.db.state.pet_playground_plots.find((r)=>r._id===before._id)
  assert.deepEqual(after.pets.map((p)=>p.motion),before.pets.map((p)=>p.motion))
  assert.deepEqual(f.db.state.pet_playground_plots.find((r)=>r._id===pid('a')),actorBefore)
  assert.equal(after.session,before.session);assert.equal(after.petSeq,before.petSeq)
  const records=(await shared.snapshot('a',{sceneId:scene.sceneId,session:scene.session})).records
  assert.equal(records.find((r)=>r.kind==='resident').pets[0].appearance.id,result.appearance.id)
  assert.equal(JSON.stringify(records).includes('reference.jpg'),false)
  const again=await f.service.publish('admin',batch)
  assert.equal(again.appearance.id,result.appearance.id);assert.equal(f.uploaded.length,1)
})
test('identical pixel content cannot be assigned to another pet or a character, even reencoded',async()=>{
  const f=fixture(),first=await f.pending()
  await f.service.publish('admin',await f.batch(first))
  const pet=await f.pending('b','pet_b'),character=await f.pending('a','','character')
  for(const row of [pet,character])await assert.rejects(()=>f.batch(row,atlas({filter:4,hidden:7,level:1})).then((batch)=>f.service.publish('admin',batch)),/专属绑定/)
  assert.equal(f.entity('pet_b').playgroundAppearance,undefined)
  assert.equal(f.user('a').playgroundAppearance,undefined)
  assert.equal(f.db.state[BINDINGS].filter((r)=>r.kind==='image').length,1)
})
test('concurrent publication of the same image has one winner and no partial binding',async()=>{
  const f=fixture(),a=await f.pending(),b=await f.pending('b','pet_b')
  const [ba,bb]=await Promise.all([f.batch(a),f.batch(b)])
  const results=await Promise.allSettled([f.service.publish('admin',ba),f.service.publish('admin',bb)])
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1)
  assert.equal(f.db.state[REQUESTS].filter((r)=>r.status==='completed').length,1)
  assert.equal(f.db.state.pets.filter((p)=>p.playgroundAppearance).length,1)
})
test('cancellation, replacement batch, deleted pet and stolen staging paths prevent publication',async()=>{
  for(const reason of ['cancel','batch','deleted','path']) {
    const f=fixture(),row=await f.pending(),batch=await f.batch(row)
    if(reason==='cancel')await f.service.close('a',{requestId:row._id})
    if(reason==='batch')await f.service.prepareUpload('admin',{requestId:row._id})
    if(reason==='deleted')f.entity('pet_a').deletedAt=Date.now()
    if(reason==='path')batch.walkFileID=fileID('other/walk.png')
    await assert.rejects(()=>f.service.publish('admin',batch))
    assert.equal(f.entity('pet_a').playgroundAppearance,undefined)
    assert.equal(f.db.state[BINDINGS].filter((r)=>r.kind==='image').length,0)
  }
})
test('cancellation during upload and upload failure leave the target unchanged',async()=>{
  const f=fixture(),row=await f.pending(),batch=await f.batch(row),original=f.cloud.uploadFile
  f.cloud.uploadFile=async(options)=>{const result=await original(options);await f.service.close('a',{requestId:row._id});return result}
  await assert.rejects(()=>f.service.publish('admin',batch),/取消/)
  assert.equal(f.entity('pet_a').playgroundAppearance,undefined)
  const next=await f.pending(),nextBatch=await f.batch(next)
  f.cloud.uploadFile=async()=>{throw new Error('storage failure')}
  await assert.rejects(()=>f.service.publish('admin',nextBatch),/storage failure/)
  assert.equal(f.entity('pet_a').playgroundAppearance,undefined)
})
test('character publish preserves live position and session, and stale entry uses current appearances',async()=>{
  const f=fixture(),plots=world.create(f.context),shared=require('../../cloudfunctions/api/services/playground-shared')(f.context)
  await plots.claim('a',f.user('a'),{x:280,z:280})
  const scene=await shared.enter('a',f.user('a'),{},[f.entity('pet_a')])
  const staleUser=structuredClone(f.user('a')),stalePet=structuredClone(f.entity('pet_a'))
  const old=structuredClone(f.db.state.pet_playground_plots.find((r)=>r._id===pid('a')))
  const request=await f.pending('a','','character'),batch=await f.batch(request)
  const readyRun=fileID(batch.walkFileID.replace(/walk\.png$/,'run.png').slice('cloud://test.bucket/'.length))
  f.files.set(readyRun,atlas({color:101}))
  const custom=await f.service.publish('admin',{...batch,runFileID:readyRun})
  assert.equal(custom.syncPending,false)
  const actor=f.db.state.pet_playground_plots.find((r)=>r._id===pid('a'))
  for(const field of ['position','session','seq'])assert.deepEqual(actor[field],old[field])
  assert.ok(actor.sessionStarted>old.sessionStarted)
  assert.equal(custom.appearance.targetId,pid('a'))
  assert.ok(custom.appearance.run)
  const petRequest=await f.pending(),petLook=await f.service.publish('admin',await f.batch(petRequest,atlas({color:102})))
  const returned=await shared.enter('a',staleUser,{},[stalePet])
  assert.equal(returned.appearance.id,custom.appearance.id)
  assert.equal(f.db.state.pet_playground_plots.find((r)=>r.kind==='resident').pets[0].appearance.id,petLook.appearance.id)
  assert.equal(scene.sceneId,returned.sceneId)
})

test('publishing over legacy null appearance fields repairs existing projections and re-entry without resetting positions',async()=>{
  for(const type of ['character','pet']) {
    const f=fixture(),shared=require('../../cloudfunctions/api/services/playground-shared')(f.context)
    await world.create(f.context).claim('a',f.user('a'),{x:280,z:280})
    const scene=await shared.enter('a',f.user('a'),{},[f.entity('pet_a')])
    const before=structuredClone(f.db.state.pet_playground_plots)
    const row=await f.pending('a',type==='pet'?'pet_a':'',type),batch=await f.batch(row)
    f.db.state[REQUESTS].find((r)=>r._id===row._id).appearance=null
    f.db.state[BINDINGS].find((r)=>r.activeRequestId===row._id).appearance=null
    const entity=type==='pet'?f.entity('pet_a'):f.user('a')
    entity.playgroundAppearance=null
    const result=await f.service.publish('admin',batch)
    assert.equal(result.completed,true);assert.equal(result.syncPending,false)
    for(const stored of [(type==='pet'?f.entity('pet_a'):f.user('a')).playgroundAppearance,
      f.db.state[REQUESTS].find((r)=>r._id===row._id).appearance,
      f.db.state[BINDINGS].find((r)=>r.kind==='target').appearance]) {
      assert.equal(stored.id,result.appearance.id)
    }
    const actor=f.db.state.pet_playground_plots.find((r)=>r._id===pid('a'))
    assert.deepEqual(actor.position,before.find((r)=>r._id===pid('a')).position)
    const resident=f.db.state.pet_playground_plots.find((r)=>r.kind==='resident')
    assert.deepEqual(resident.pets.map((p)=>p.motion),before.find((r)=>r.kind==='resident').pets.map((p)=>p.motion))
    const returned=await shared.enter('a',f.user('a'),{},[f.entity('pet_a')])
    await shared.snapshot('a',{sceneId:returned.sceneId,session:returned.session})
    assert.deepEqual(returned.position,scene.position)
    const projected=f.db.state.pet_playground_live.flatMap((r)=>Object.values(r.records||{}))
    const look=type==='character'?projected.find((r)=>r.id===pid('a')).appearance:projected.find((r)=>r.kind==='resident').pets[0].appearance
    assert.equal(look.id,result.appearance.id)
  }
})

test('a walking-only replacement removes the old running atlas from target, binding, request and live scene',async()=>{
  const f=fixture(),shared=require('../../cloudfunctions/api/services/playground-shared')(f.context)
  await world.create(f.context).claim('a',f.user('a'),{x:280,z:280})
  await shared.enter('a',f.user('a'),{},[])
  const first=await f.pending('a','','character'),batch=await f.batch(first)
  const runFileID=batch.walkFileID.replace(/walk\.png$/,'run.png')
  f.files.set(runFileID,atlas({color:101}))
  await f.service.publish('admin',{...batch,runFileID})
  assert.ok(f.user('a').playgroundAppearance.run)
  f.advance()
  const next=await f.pending('a','','character')
  const result=await f.service.publish('admin',await f.batch(next,atlas({color:102})))
  assert.equal(result.syncPending,false)
  const binding=f.db.state[BINDINGS].find((r)=>r.kind==='target')
  const request=f.db.state[REQUESTS].find((r)=>r._id===next._id)
  const actor=f.db.state.pet_playground_plots.find((r)=>r._id===pid('a'))
  const live=f.db.state.pet_playground_live.flatMap((r)=>Object.values(r.records||{})).find((r)=>r.id===pid('a'))
  for(const stored of [f.user('a').playgroundAppearance,binding.appearance,request.appearance,actor.appearance,live.appearance]) {
    assert.equal(stored.id,result.appearance.id)
    assert.ok(!stored.run)
  }
})

test('entry reads multiple current pets in order and excludes missing, deleted or reassigned pets',async()=>{
  const f=fixture(),shared=require('../../cloudfunctions/api/services/playground-shared')(f.context)
  await world.create(f.context).claim('a',f.user('a'),{x:280,z:280})
  const row=await f.pending(),custom=await f.service.publish('admin',await f.batch(row))
  f.db.state.pets.push({_id:'pet_deleted',openid:'a',species:'dog',deletedAt:1})
  const stale=[{...f.entity('pet_a'),playgroundAppearance:null},{...f.entity('pet_a2')},
    {_id:'pet_missing'}, {_id:'pet_deleted'}, {...f.entity('pet_b')}]
  const scene=await shared.enter('a',f.user('a'),{},stale)
  const snapshot=await shared.snapshot('a',{sceneId:scene.sceneId,session:scene.session})
  const pets=snapshot.records.find((r)=>r.kind==='resident').pets
  assert.deepEqual(pets.map((p)=>p.id),['pet_a','pet_a2'])
  assert.equal(pets[0].appearance.id,custom.appearance.id)
  assert.equal(pets[1].appearance,null)
})
test('replacement preserves historical uniqueness, while rejection keeps the published appearance',async()=>{
  const f=fixture(),first=await f.pending()
  const old=await f.service.publish('admin',await f.batch(first))
  f.advance()
  const second=await f.pending(),fresh=await f.service.publish('admin',await f.batch(second,atlas({color:105})))
  assert.ok(fresh.appearance.revision>old.appearance.revision)
  const third=await f.pending()
  await assert.rejects(()=>f.service.close('admin',{requestId:third._id},true),/原因/)
  await f.service.close('admin',{requestId:third._id,reason:'请补充全身照'},true)
  assert.equal(f.entity('pet_a').playgroundAppearance.id,fresh.appearance.id)
  const other=await f.pending('b','pet_b')
  await assert.rejects(()=>f.batch(other).then((batch)=>f.service.publish('admin',batch)),/专属绑定/)
})
test('API denies non-admin and ungranted admin actions; request owner cannot be spoofed',async()=>{
  const f=fixture()
  let api=loadCloudFunction('api',f.db,'b',f.cloud)
  const denied=await api.main({module:'playgroundAppearance',action:'createDraft',data:{ownerOpenid:'a',targetType:'pet',petId:'pet_a'}})
  assert.equal(denied.ok,false)
  for(const action of ['listAdmin','detailAdmin','prepareUpload','publish','reject'])assert.equal((await api.main({module:'playgroundAppearance',action,data:{}})).ok,false)
  f.db.state.admin_access_config=[{_id:'policy',enabled:true,ownerOpenid:'someone-else'}]
  api=loadCloudFunction('api',f.db,'admin',f.cloud)
  const adminDenied=await api.main({module:'playgroundAppearance',action:'listAdmin',data:{}})
  assert.equal(adminDenied.ok,false);assert.equal(adminDenied.code,'ADMIN_FORBIDDEN')
  f.db.state.admin_memberships=[{_id:'u_admin',groupIds:['view-only']}]
  f.db.state.admin_groups=[{_id:'view-only',enabled:true,permissions:['playgroundAppearance.listAdmin']}]
  assert.equal((await api.main({module:'playgroundAppearance',action:'listAdmin',data:{}})).ok,true)
  assert.equal((await api.main({module:'playgroundAppearance',action:'publish',data:{}})).code,'ADMIN_FORBIDDEN')
})

test('an offline owner without a resident record retains its exact customized pet when neighbors enter',async()=>{
  const f=fixture(),shared=require('../../cloudfunctions/api/services/playground-shared')(f.context)
  await world.create(f.context).claim('a',f.user('a'),{x:280,z:280})
  const request=await f.pending(),custom=await f.service.publish('admin',await f.batch(request))
  assert.equal((f.db.state.pet_playground_plots||[]).some((r)=>r.kind==='resident'),false)
  const scene=await shared.enter('b',f.user('b'),{},[f.entity('pet_b')])
  const snapshot=await shared.snapshot('b',{sceneId:scene.sceneId,session:scene.session})
  const pets=snapshot.records.find((r)=>r.kind==='resident').pets
  assert.equal(pets.find((p)=>p.id==='pet_a').appearance.id,custom.appearance.id)
  assert.equal(pets.find((p)=>p.id==='pet_a2').appearance,null)
})

test('private collections and storage rule fragments isolate photos and deny client edits to published art',()=>{
  const fs=require('node:fs'),vm=require('node:vm')
  for(const collection of [REQUESTS,BINDINGS]) {
    const rule=JSON.parse(fs.readFileSync(require.resolve('../../cloudfunctions/api/database-rules/'+collection+'.json'),'utf8'))
    assert.equal(rule.read,false);assert.equal(rule.write,false)
  }
  const rule=JSON.parse(fs.readFileSync(require.resolve('../../cloudfunctions/api/storage-rules/playground-appearance.fragment.json'),'utf8'))
  const check=(operation,path,owner='a',auth={openid:'a'})=>vm.runInNewContext(rule[operation],{auth,resource:{path,openid:owner}})
  assert.equal(check('read','playground-appearance/references/a/request/photo.jpg'),true)
  assert.equal(check('read','playground-appearance/references/b/request/photo.jpg','b'),false)
  assert.equal(check('write','playground-appearance/staging/request/admin/token/walk.png'),true)
  assert.equal(check('write','packagePlayground/custom/target/request/walk.png'),false)
  assert.equal(check('read','packagePlayground/custom/target/request/walk.png','server'),true)
  assert.equal(check('read','packagePlayground/custom/target/request/walk.png','server',null),false)
})
