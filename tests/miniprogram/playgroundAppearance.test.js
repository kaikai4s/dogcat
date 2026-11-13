const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {World2D}=require('../../miniprogram/packagePlayground/utils/world2d')
const {AssetLoader2D,prepare}=require('../../miniprogram/packagePlayground/utils/asset-loader-2d')
const {canVisit}=require('../../miniprogram/utils/adminAccess')
const cloudID=(name)=>'cloud://custom.test/packagePlayground/custom/'+name+'.png'
function appearance(type='pet',id='pet-a',ownerId='player-a',file='walk',revision=1) {
  return {id:'look_'+'a'.repeat(32),targetType:type,targetId:id,ownerId,revision,
    walk:{fileID:cloudID(file),frames:24,columns:4,rows:6,frameSize:128,anchor:460/512},run:null}
}
function loadPage(file,{call=async()=>({}),upload=async()=>'',choosePhotos=async()=>[],chooseAtlas=async()=>({}),extraWx={}}={}) {
  let page
  const errors=[],modals=[]
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/'+file),'utf8'),{
    Page(value){page=value},setInterval,clearInterval,
    require:(name)=>name.endsWith('/cloud')?{callFunction:call,ensureLogin:async()=>true,showError:(e)=>errors.push(e.message)}:
      name.includes('playgroundAppearanceUpload')?{choosePhotos,chooseAtlas,uploadFile:upload,STATUS_TEXT:{pending:'等待处理',processing:'制作中',completed:'已生效'}}:
        {formatDateTime:()=>''},
    wx:{showToast(){},showModal(v){modals.push(v)},previewImage(){},...extraWx}
  })
  page.setData=(values)=>Object.assign(page.data,values)
  return {page,errors,modals}
}
test('user chooses a particular same-name pet; upload freezes that target and submits only its reserved photos',async()=>{
  const calls=[],uploads=[]
  let finishUpload
  const f=loadPage('packagePlayground/pages/customize.js',{
    call:async(module,action,data)=>{
      calls.push({module,action,data})
      if(action==='options')return {pets:[{id:'pet-1111',name:'豆豆',species:'cat'},{id:'pet-2222',name:'豆豆',species:'dog'}]}
      if(action==='listMine')return {list:[]}
      if(action==='createDraft')return {_id:'request-a',photoPrefix:'private/request-a/'}
      return {}
    },upload:(local,path)=>{uploads.push(path);return new Promise((resolve)=>{finishUpload=resolve})}
  })
  f.page.onLoad({petId:'pet-2222'});await f.page.load()
  assert.equal(f.page.data.targetIndex,2)
  assert.notEqual(f.page.data.targets[1].label,f.page.data.targets[2].label)
  f.page.setData({photos:[{path:'/tmp/photo.png'}],remark:'蓝项圈'})
  const submitted=f.page.submit();await new Promise(setImmediate)
  f.page.changeTarget({detail:{value:1}})
  await f.page.submit()
  assert.equal(f.page.data.targetIndex,2)
  assert.equal(uploads.length,1);assert.ok(uploads[0].startsWith('private/request-a/'))
  finishUpload(cloudID('photo'));await submitted
  assert.equal(calls.find((c)=>c.action==='createDraft').data.petId,'pet-2222')
  assert.equal(calls.find((c)=>c.action==='submit').data.photos[0],cloudID('photo'))
  assert.equal(f.page.data.photos.length,0);assert.equal(f.page.data.busy,false)
})
test('customization history uses Chinese unknown labels without changing statuses, notes or cancellation rules',()=>{
  const {page}=loadPage('packagePlayground/pages/customize.js')
  const rows=page.decorate([
    {_id:'request-1',status:'pending',remark:'keep_raw_note'},
    {_id:'request-2',status:'future_internal_state',remark:'保留说明'},
    {_id:'request-3',status:'completed'}
  ])
  assert.equal(rows[0].statusText,'等待处理');assert.equal(rows[0].canCancel,true)
  assert.equal(rows[0].remark,'keep_raw_note');assert.equal(rows[0]._id,'request-1')
  assert.equal(rows[1].statusText,'申请状态待确认');assert.equal(rows[1].status,'future_internal_state')
  assert.equal(rows[1].remark,'保留说明');assert.equal(rows[1].canCancel,false)
  assert.equal(rows[2].statusText,'已生效');assert.equal(rows[2].canCancel,false)
})
test('photo validation and failed uploads preserve the form and do not submit an incomplete request',async()=>{
  const calls=[]
  const f=loadPage('packagePlayground/pages/customize.js',{call:async(m,a)=>{calls.push(a);return {_id:'r',photoPrefix:'private/'}},upload:async()=>{throw new Error('网络中断')}})
  f.page.setData({targets:[{id:'pet',targetType:'pet'}]})
  await f.page.submit();assert.equal(calls.length,0)
  f.page.setData({photos:[{path:'/tmp/p.png'}],remark:'保留说明'})
  await f.page.submit()
  assert.equal(calls.join(','),'createDraft');assert.equal(f.page.data.photos.length,1)
  assert.equal(f.page.data.remark,'保留说明');assert.equal(f.page.data.busy,false)
  assert.ok(f.errors.includes('网络中断'))
})
test('admin uploads the chosen sheets to the server batch before publishing the immutable request',async()=>{
  const calls=[],uploads=[]
  const f=loadPage('pages/admin/playground-customizations/index.js',{
    call:async(m,a,d)=>{calls.push({a,d});if(a==='prepareUpload')return {token:'batch1',walkPath:'staging/walk.png',runPath:'staging/run.png'};if(a==='listAdmin')return {list:[]};return {}},
    upload:async(local,path,onProgress)=>{uploads.push({local,path});onProgress(70);return 'cloud://test/'+path}
  })
  f.page.setData({detail:{_id:'request-unique',targetId:'pet-unique',targetType:'pet'},walk:{path:'/walk.png'},run:{path:'/run.png'}})
  await f.page.uploadAndPublish()
  assert.equal(uploads.length,2)
  const pub=calls.find((c)=>c.a==='publish').d
  assert.equal(pub.requestId,'request-unique');assert.equal(pub.token,'batch1')
  assert.equal(pub.walkFileID,'cloud://test/staging/walk.png');assert.equal(pub.runFileID,'cloud://test/staging/run.png')
  assert.equal(pub.targetId,undefined);assert.equal(f.page.data.detail,null)
  assert.equal(f.modals[0].title,'专属形象已生效')
})
test('admin upload failures keep selected art for retry and never publish; routes require a granted permission',async()=>{
  const actions=[]
  const f=loadPage('pages/admin/playground-customizations/index.js',{call:async(m,a)=>{actions.push(a);return {token:'x',walkPath:'staging/walk.png'}},upload:async()=>{throw new Error('上传失败')}})
  f.page.setData({detail:{_id:'request-a'},walk:{path:'/walk.png'}})
  await f.page.uploadAndPublish()
  assert.equal(actions.join(','),'prepareUpload');assert.equal(f.page.data.walk.path,'/walk.png')
  assert.equal(f.page.data.busy,false);assert.ok(f.page.data.detail)
  const url='/pages/admin/playground-customizations/index'
  assert.equal(canVisit({permissions:[]},url),false)
  assert.equal(canVisit({permissions:['playgroundAppearance.listAdmin']},url),true)
})
function world() {
  const page={data:{},setData(v){Object.assign(this.data,v)},fetchRegion:async()=>({plots:[]})}
  const w=new World2D(page,null,{world:{width:224,height:224},plot:{id:'mine',mine:true,x:112,z:112,size:48},scene:{playerId:'player-a',position:{x:112,z:112},serverTime:Date.now()},pets:[{_id:'pet-a',name:'豆豆',species:'cat'}]})
  w.buildWorld();w.zoom=.8;w.manualZoom=true
  const draws=[]
  w.ctx={save(){},restore(){},translate(){},scale(){},drawImage(...args){draws.push(args)}}
  return {w,draws}
}
test('custom character, pet and offline neighbor crop 24 frames and rest on frame zero',()=>{
  const {w,draws}=world(),sheet={width:512,height:768},run={width:512,height:768}
  const char=appearance('character','player-a','player-a')
  char.run={...char.walk,fileID:cloudID('run')}
  w.setOwnAppearance(char);w.customImages.set(char.walk.fileID,sheet);w.customImages.set(char.run.fileID,run)
  w.character.moving=true;w.character.animationPhase=23/24+.001
  w.drawCharacter(false)
  assert.equal(draws.at(-1)[0],sheet);assert.equal(draws.at(-1)[1],384);assert.equal(draws.at(-1)[2],640)
  w.character.runRequested=true;w.drawCharacter(false);assert.equal(draws.at(-1)[0],run)
  w.character.moving=false;w.drawCharacter(false);assert.equal(draws.at(-1)[0],sheet);assert.equal(draws.at(-1)[1],0);assert.equal(draws.at(-1)[2],0)
  const pet=w.pets[0];pet.appearance=appearance();pet.position={x:112,z:112};pet.moving=true
  // Use its configured stride to request the last custom frame.
  pet.walkDistance=23/24*require('../../miniprogram/packagePlayground/utils/pet-assets').PET_ATLASES.cat_walk.stride+.00001
  w.drawPet(pet);assert.equal(draws.at(-1)[2],640)
  w.markerLabel=()=>{}
  const person={id:'neighbor',ownerId:'owner-b',position:{x:112,z:112},online:false,moving:true,lastSeen:Date.now(),appearance:appearance('character','neighbor','owner-b')}
  w.drawNeighbor(person,false);assert.equal(draws.at(-1)[1],0);assert.equal(draws.at(-1)[2],0)
})
test('wrong-owner and same-name sprites use defaults; valid updates preserve commands, selection, position and zoom',()=>{
  const {w,draws}=world(),sheet={width:512,height:768},defaultCat={width:1024,height:1280}
  w.assets.cat_walk=defaultCat;w.customImages.set(cloudID('walk'),sheet)
  const pet=w.pets[0];pet.position={x:112,z:112};pet.appearance=appearance('pet','another-pet','player-a')
  w.drawPet(pet);assert.equal(draws.at(-1)[0],defaultCat)
  pet.appearance=appearance('pet','pet-a','wrong-owner');w.drawPet(pet);assert.equal(draws.at(-1)[0],defaultCat)
  pet.pendingMove={token:5};pet.acceptedCommand=4
  const position={...pet.position};w.selectedPetId=pet.id
  w.applySharedPet({id:pet.id,name:'豆豆',commandSeq:1,appearance:appearance('pet',pet.id,'player-a','new',20)},true,'甲','player-a')
  assert.equal(pet.appearance.revision,20);assert.equal(pet.pendingMove.token,5)
  assert.deepEqual(pet.position,position);assert.equal(w.selectedPetId,pet.id);assert.equal(w.zoom,.8)
  w.applySharedPet({id:pet.id,commandSeq:1,appearance:null},true,'甲','player-a');assert.equal(pet.appearance.revision,20)
  w.setOwnAppearance(appearance('character','player-a','player-a','new',20))
  w.setOwnAppearance(appearance('character','player-a','player-a','old',10));w.setOwnAppearance(null)
  assert.equal(w.characterAppearance.revision,20);assert.equal(w.page.data.hasCustomCharacter,true)
})
test('a slow old image cannot replace newer art, offscreen pets do not load, and custom downloads are bounded',async()=>{
  const {w}=world(),finished=[]
  w.loader={cache:new Map(),loadAtlas:(style)=>new Promise((resolve)=>finished.push(()=>resolve({width:512,height:768,tag:style.fileID})))}
  const pet=w.pets[0];pet.appearance=appearance();pet.position={x:-10000,z:-10000}
  w.drawPet(pet);assert.equal(finished.length,0)
  w.customSprite(appearance(),'pet','pet-a','player-a','walk')
  const newer=appearance('pet','pet-a','player-a','new',2)
  w.customSprite(newer,'pet','pet-a','player-a','walk')
  w.customSprite(appearance('pet','pet-a','player-a','third',3),'pet','pet-a','player-a','walk')
  assert.equal(finished.length,2)
  finished[1]();await new Promise(setImmediate);finished[0]();await new Promise(setImmediate)
  assert.equal(w.customSprite(newer,'pet','pet-a','player-a','walk').image.tag,cloudID('new'))
  assert.equal(w.customSprite({...newer,run:null},'pet','pet-a','player-a','run').image.tag,cloudID('new'))
  w.destroy();assert.equal(w.customImages.size,0)
})
test('cloud atlas loading preserves alpha, validates dimensions and permits retry after a mismatch',async()=>{
  const oldWx=global.wx,style=appearance().walk,requests=[]
  let width=1024
  global.wx={cloud:{downloadFile({fileID,success}){requests.push(fileID);success({tempFilePath:'/tmp/art.png'})}}}
  const loader=new AssetLoader2D({createImage:()=>({width,height:768,set src(v){queueMicrotask(()=>this.onload())}})})
  try {
    await assert.rejects(()=>loader.loadAtlas(style),/尺寸不匹配/)
    width=512
    const image=await loader.loadAtlas(style)
    assert.equal(image.width,512);assert.equal(prepare(image,style.fileID),image)
    assert.equal(requests.length,2)
    assert.equal((await loader.loadAtlas(style)),image)
  }finally {global.wx=oldWx}
})
test('switching to run keeps the custom walking art visible while its running atlas downloads',async()=>{
  const {w}=world(),look=appearance('character','player-a','player-a'),walk={width:512,height:768},run={width:512,height:768}
  look.run={...look.walk,fileID:cloudID('run')}
  w.customImages.set(look.walk.fileID,walk)
  let finish
  w.loader={loadAtlas:()=>new Promise((resolve)=>{finish=resolve})}
  assert.equal(w.customSprite(look,'character','player-a','player-a','run').image,walk)
  finish(run);await new Promise(setImmediate)
  assert.equal(w.customSprite(look,'character','player-a','player-a','run').image,run)
  w.destroy()
})
test('album picker requests original images without file access, validates actual PNG format and uses the current upload environment',async()=>{
  let dimensions={width:512,height:768,type:'png'},helper
  const uploads=[],selections=[]
  let selected={tempFilePath:'/tmp/original.png',size:1000}
  const wx={chooseMedia(o){selections.push(o);o.success({tempFiles:[selected]})},
    getImageInfo(o){o.success(dimensions)},cloud:{uploadFile(o){uploads.push(o);o.success({fileID:cloudID('uploaded')});return {onProgressUpdate(fn){fn({progress:55})}}}}}
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/admin/utils/playgroundAppearanceUpload'),'utf8'),{
    module:{get exports(){return helper},set exports(v){helper=v}},require:()=>({getCloudEnv:()=> 'current-test-env'}),wx
  })
  const atlas=await helper.chooseAtlas()
  assert.equal(atlas.byteLength,1000);assert.equal(atlas.path,'/tmp/original.png');assert.equal(atlas.name,'original.png');assert.equal(atlas.frameSize,128)
  assert.equal(selections[0].count,1)
  assert.equal(Array.from(selections[0].mediaType).join(','),'image')
  assert.equal(Array.from(selections[0].sourceType).join(','),'album')
  assert.equal(Array.from(selections[0].sizeType).join(','),'original')
  dimensions={width:1024,height:768,type:'png'};await assert.rejects(()=>helper.chooseAtlas(),/24帧/)
  const directional=await helper.chooseAtlas(3);assert.equal(directional.frames,12);assert.equal(directional.rows,3)
  dimensions={width:1024,height:1536,type:'png'};await assert.rejects(()=>helper.chooseAtlas(3),/12帧/)
  // A PNG-looking filename must not admit an image converted to JPG by the album.
  dimensions={width:512,height:768,type:'jpeg'};await assert.rejects(()=>helper.chooseAtlas(),/PNG原图/)
  dimensions={width:512,height:768,type:'png'}
  selected={tempFilePath:'/tmp/original.png',size:8*1024*1024+1};await assert.rejects(()=>helper.chooseAtlas(),/8MB/)
  selected=null;await assert.rejects(()=>helper.chooseAtlas(),/PNG原图/)
  let progress=0
  assert.equal(await helper.uploadFile('/tmp/original.png','reserved/walk.png',(v)=>progress=v),cloudID('uploaded'))
  assert.equal(uploads[0].config.env,'current-test-env');assert.equal(uploads[0].filePath,'/tmp/original.png');assert.equal(progress,55)
})

test('admin requires eight directional sheets and uploads each to its reserved action and direction path',async()=>{
  const calls=[],uploads=[],copies=[];let selectedCount=0
  const directions=['sw','se','nw','ne']
  const paths=(action)=>Object.fromEntries(directions.map((d)=>[d,`batch/${action}-${d}.png`]))
  const f=loadPage('pages/admin/playground-customizations/index.js',{
    call:async(m,a,d)=>{calls.push({a,d});return a==='prepareUpload'?{token:'eight',walkPaths:paths('walk'),runPaths:paths('run')}:{}},
    chooseAtlas:async(rows)=>{assert.equal(rows,3);return {path:'/chosen.png',byteLength:1000+(selectedCount++)}},
    upload:async(local,path)=>{uploads.push({local,path});return 'cloud://test/'+path},
    extraWx:{setClipboardData(o){copies.push(o.data);o.success()}}
  })
  f.page.setData({detail:{_id:'character-request',targetType:'character',canProcess:true}})
  await f.page.uploadAndPublish();assert.equal(calls.length,0)
  for(const action of ['walk','run'])for(const direction of directions)await f.page.selectAtlas({currentTarget:{dataset:{action,direction}}})
  f.page.stopPreview()
  assert.equal(f.page.data.allAtlasesReady,true)
  f.page.selectPromptAction({currentTarget:{dataset:{action:'run'}}})
  f.page.selectPromptDirection({currentTarget:{dataset:{direction:'ne'}}})
  f.page.copyPrompt()
  assert.match(copies[0],/奔跑/);assert.match(copies[0],/右后 NE/);assert.match(copies[0],/1024×768/)
  await f.page.uploadAndPublish()
  assert.equal(uploads.length,8)
  const pub=calls.find((c)=>c.a==='publish').d
  for(const action of ['walk','run'])for(const d of directions)assert.equal(pub[action+'FileIDs'][d],'cloud://test/'+paths(action)[d])
  assert.deepEqual({...pub.atlasByteLengths},{'walk-sw':1000,'walk-se':1001,'walk-nw':1002,'walk-ne':1003,'run-sw':1004,'run-se':1005,'run-nw':1006,'run-ne':1007})
  assert.equal(pub.requestId,'character-request');assert.equal(pub.token,'eight')
  assert.equal(f.page.data.detail,null);assert.equal(f.page.data.allAtlasesReady,false)
})
test('default and customized characters render all directions for self and neighbors without double mirroring',()=>{
  const {w,draws}=world(),directions=['sw','se','nw','ne'],scales=[]
  w.ctx.scale=(...v)=>scales.push(v);w.markerLabel=()=>{};w.drawOfflineBadge=()=>{}
  const look=appearance('character','player-a','player-a')
  look.walk={};look.run={}
  for(const d of directions) {
    for(const action of ['idle','walk','run'])w.assets[`boy_${action}_${d}`]={width:action==='idle'?512:1024,height:action==='idle'?512:768,tag:action+d}
    for(const action of ['walk','run']) {
      const style={fileID:cloudID(action+d),frames:12,columns:4,rows:3,frameSize:256}
      look[action][d]=style;w.customImages.set(style.fileID,{width:1024,height:768,tag:'custom'+action+d})
    }
  }
  for(const custom of [false,true]) {
    w.characterAppearance=custom?look:null
    for(const d of directions)for(const action of ['idle','walk','run']) {
      Object.assign(w.character,{facing:d,mirrored:d==='se'||d==='ne',moving:action!=='idle',runRequested:action==='run',animationPhase:11/12+.001})
      w.drawCharacter(false)
      const draw=draws.at(-1),selectedAction=custom&&action==='idle'?'walk':action
      assert.equal(draw[0].tag,(custom?'custom':'')+selectedAction+d)
      if(action!=='idle'){assert.equal(draw[1],768);assert.equal(draw[2],512)}
      else if(custom){assert.equal(draw[1],0);assert.equal(draw[2],0)}
      else assert.equal(draw.length,5)
      w.drawNeighbor({id:'player-a',ownerId:'player-a',appearance:custom?look:null,characterType:'boy',position:{x:112,z:112},facing:d,mirrored:true,online:true,lastSeen:Date.now(),moving:action!=='idle',running:action==='run'},false)
      assert.equal(draws.at(-1)[0].tag,(custom?'custom':'')+selectedAction+d)
    }
  }
  assert.equal(scales.length,0)
})

test('initial custom character sheets are loaded before the scene draws any default character frames',async()=>{
  const {w,draws}=world(),directions=['sw','se','nw','ne'],loaded=[]
  const look=appearance('character','player-a','player-a')
  look.walk=Object.fromEntries(directions.map((direction)=>[direction,{
    fileID:cloudID('walk-'+direction),frames:12,columns:4,rows:3,frameSize:256
  }]))
  w.setOwnAppearance(look)
  w.loader={loadAtlas:async(style)=>{loaded.push(style.fileID);return {width:1024,height:768,tag:style.fileID}}}
  await w.preloadInitialCharacterAppearance()
  assert.equal(loaded.length,4)
  assert.equal(w.customImages.size,4)
  w.assets.boy_idle_sw={width:512,height:512,tag:'default-idle'}
  w.character.facing='sw'
  w.drawCharacter(false)
  assert.equal(draws.at(-1)[0].tag,cloudID('walk-sw'))
})

test('scene snapshots and changes load every direction for a neighbor of another character type',async()=>{
  const {w}=world(),loads=[]
  w.loader={loadAll:async(progress,names)=>{loads.push(...names);return Object.fromEntries(names.map((name)=>[name,{}]))}}
  const record={id:'neighbor',ownerId:'other',kind:'presence',characterType:'girl',position:{x:112,z:112},online:true,lastSeen:Date.now(),facing:'ne'}
  await w.applySceneRecords([record])
  for(const action of ['idle','walk','run'])for(const d of ['sw','se','nw','ne'])assert.ok(loads.includes(`girl_${action}_${d}`))
  loads.length=0;w.assets={}
  await w.applySceneChanges([{...record,lastSeen:Date.now()+100}])
  for(const action of ['idle','walk','run'])for(const d of ['sw','se','nw','ne'])assert.ok(loads.includes(`girl_${action}_${d}`))
})

test('directional PNG errors reach the admin with all eight selected sheets preserved for retry',async()=>{
  const error='run-ne.png校验失败：上传前522069字节，云端读取80字节，文件大小不一致，请重试上传'
  const f=loadPage('pages/admin/playground-customizations/index.js',{
    call:async(m,a)=>{
      if(a==='prepareUpload')return {token:'batch',walkPaths:{},runPaths:{}}
      if(a==='publish')throw new Error(error)
    },upload:async()=>cloudID('uploaded')
  })
  const detail={_id:'character-request',targetType:'character',canProcess:true}
  f.page.setData({detail,allAtlasesReady:true})
  for(const action of ['walk','run'])for(const slot of f.page.data[action+'Atlases'])slot.atlas={path:action+'-'+slot.key+'.png',byteLength:522069}
  const selected=JSON.stringify([f.page.data.walkAtlases,f.page.data.runAtlases])
  await f.page.uploadAndPublish()
  assert.deepEqual(f.errors,[error])
  assert.equal(f.page.data.detail,detail)
  assert.equal(f.page.data.busy,false)
  assert.equal(f.page.data.allAtlasesReady,true)
  assert.equal(JSON.stringify([f.page.data.walkAtlases,f.page.data.runAtlases]),selected)
})
