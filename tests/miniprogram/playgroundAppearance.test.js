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
  f.page.setData({detail:{_id:'request-unique',targetId:'pet-unique',targetType:'character'},walk:{path:'/walk.png'},run:{path:'/run.png'}})
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
  assert.equal(atlas.path,'/tmp/original.png');assert.equal(atlas.name,'original.png');assert.equal(atlas.frameSize,128)
  assert.equal(selections[0].count,1)
  assert.equal(Array.from(selections[0].mediaType).join(','),'image')
  assert.equal(Array.from(selections[0].sourceType).join(','),'album')
  assert.equal(Array.from(selections[0].sizeType).join(','),'original')
  dimensions={width:1024,height:768,type:'png'};await assert.rejects(()=>helper.chooseAtlas(),/24帧/)
  // A PNG-looking filename must not admit an image converted to JPG by the album.
  dimensions={width:512,height:768,type:'jpeg'};await assert.rejects(()=>helper.chooseAtlas(),/PNG原图/)
  dimensions={width:512,height:768,type:'png'}
  selected={tempFilePath:'/tmp/original.png',size:8*1024*1024+1};await assert.rejects(()=>helper.chooseAtlas(),/8MB/)
  selected=null;await assert.rejects(()=>helper.chooseAtlas(),/PNG原图/)
  let progress=0
  assert.equal(await helper.uploadFile('/tmp/original.png','reserved/walk.png',(v)=>progress=v),cloudID('uploaded'))
  assert.equal(uploads[0].config.env,'current-test-env');assert.equal(uploads[0].filePath,'/tmp/original.png');assert.equal(progress,55)
})
