const test=require('node:test')
const assert=require('node:assert/strict')
const {createCollectionStore}=require('./helpers')
const {fixture}=require('../fixtures/playgroundLife')
const {atlas}=require('../fixtures/appearanceAtlas')
const createCatalog=require('../../cloudfunctions/api/services/playground-farm-catalog')
const {CROPS,farmLayout}=require('../../cloudfunctions/api/services/playground-shared/farm-model')
const clone=(value)=>JSON.parse(JSON.stringify(value))
function setup(db=createCollectionStore({})) {
  const files=new Map(),downloads=[]
  const cloud={getWXContext:()=>({ENV:'test'}),downloadFile:async({fileID})=>{
    downloads.push(fileID)
    if(!files.has(fileID))throw new Error('missing file')
    return {fileContent:files.get(fileID)}
  }}
  const service=createCatalog({db,cloud,nowMs:()=>1800000000000})
  async function custom(id='tomato',bytes=atlas({rows:1})) {
    const path=(await service.prepareUpload('admin',{id})).cloudPath
    const crop={...clone(CROPS[0]),id,name:'番茄',atlas:{...CROPS[0].atlas,fileID:'cloud://test.bucket/'+path,frameSize:128}}
    files.set(crop.atlas.fileID,bytes)
    return crop
  }
  return {db,service,files,downloads,custom}
}
test('catalog defaults match uploaded soil and stage PNGs, saves validate all cells and protect revisions',async()=>{
  const f=setup(),initial=await f.service.list()
  assert.equal(initial.revision,0);assert.equal(initial.crops.length,6)
  assert.match(initial.soils.watered,/\/farm\/soil-watered\.png$/)
  const crop=await f.custom()
  const saved=await f.service.save('admin',{revision:0,crop})
  assert.equal(saved.revision,1);assert.equal(saved.crops.at(-1).id,'tomato')
  assert.equal(f.downloads.length,1)
  const updated=await f.service.save('admin',{revision:1,crop:{...crop,price:17}})
  assert.equal(updated.crops.at(-1).price,17);assert.equal(f.downloads.length,1)
  await assert.rejects(()=>f.service.save('other',{revision:1,crop}),/其他管理员/)
  assert.equal((await f.service.list()).revision,2)
})
test('catalog rejects malformed stages, unsafe IDs and invalid economy values',()=>{
  const base=clone(CROPS[0])
  for(const patch of [{id:'__proto__'},{id:'constructor'},{id:'x/y'},{name:' '},{minutes:0},{price:-1},{sell:1.5},
    {yield:101},{xp:Infinity},{level:11},{stages:[0,30,20,100]},{stages:[0,20,65,99]},
    {stages:[0,100]},{atlas:{...base.atlas,anchorY:1}},{atlas:{...base.atlas,fileID:'https://example.com/a.png'}}]) {
    assert.throws(()=>createCatalog.normalizeCrop({...base,...patch}),JSON.stringify(patch))
  }
})
test('catalog accepts only current environment upload paths and nonempty transparent PNGs of the exact grid',async()=>{
  const f=setup(),crop=await f.custom()
  for(const fileID of [crop.atlas.fileID.replace('test.bucket','other.bucket'),crop.atlas.fileID.replace('/tomato/','/corn/'),
    'cloud://test.bucket/arbitrary/image.png',crop.atlas.fileID.replace(/\/[a-f0-9]{32}\.png$/,'/preview.gif')]) {
    await assert.rejects(()=>f.service.save('admin',{revision:0,crop:{...crop,atlas:{...crop.atlas,fileID}}}),/本后台上传/)
  }
  assert.equal(f.downloads.length,0)
  for(const bytes of [atlas({rows:1,blank:3}),atlas({rows:1,opaque:true}),atlas({rows:2}),Buffer.from('not a png')]) {
    f.files.set(crop.atlas.fileID,bytes)
    await assert.rejects(()=>f.service.save('admin',{revision:0,crop}))
  }
  f.files.set(crop.atlas.fileID,atlas({rows:1}))
  await assert.rejects(()=>f.service.save('admin',{revision:0,crop:{...crop,atlas:{...crop.atlas,frameSize:256}}}),/尺寸/)
  assert.equal((await f.service.list()).revision,0)
})
test('concurrent admin saves cannot overwrite each other',async()=>{
  const f=setup(),a=await f.custom('tomato'),b=await f.custom('beans')
  const results=await Promise.allSettled([f.service.save('a',{revision:0,crop:a}),f.service.save('b',{revision:0,crop:b})])
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1)
  assert.equal((await f.service.list()).crops.length,7)
})
test('custom crops use server prices, preserve the planted harvest, and allow delisted stock to be sold',async()=>{
  const f=fixture(),a=await f.build(),catalog=setup(f.db),crop=await catalog.custom()
  await catalog.service.save('admin',{revision:0,crop:{...crop,price:7,minutes:10,yield:4,xp:20,sell:11}})
  f.place('a',farmLayout(a.plot)[0])
  await f.farmAction('a',a,'till',{bedId:0})
  let state=await f.farmAction('a',a,'buySeeds',{cropId:'tomato',quantity:2,price:0})
  assert.equal(state.coins,96);assert.equal(state.crops.at(-1).name,'番茄')
  state=await f.farmAction('a',a,'plant',{bedId:0,cropId:'tomato',minutes:1})
  assert.equal(state.beds[0].readyAt-f.now(),600000)
  await catalog.service.save('admin',{revision:1,crop:{...crop,minutes:1,yield:99,xp:999,sell:13,enabled:false}})
  await assert.rejects(()=>f.farmAction('a',a,'buySeeds',{cropId:'tomato'}),/下架/)
  await f.farmAction('a',a,'water',{bedId:0})
  state=await f.shared.farm.state('a',f.auth(a))
  assert.equal(state.beds[0].readyAt-f.now(),510000)
  assert.equal(state.crops.at(-1).unlocked,false)
  f.advance(510000)
  state=await f.farmAction('a',a,'harvest',{bedId:0})
  assert.equal(state.produce.tomato,5);assert.equal(state.xp,20)
  await assert.rejects(()=>f.farmAction('a',a,'plant',{bedId:0,cropId:'tomato'}),/下架/)
  state=await f.farmAction('a',a,'sell',{cropId:'tomato',quantity:5,sell:999})
  assert.equal(state.coins,161)
})
test('legacy planted crops retain the original growth and yield after default crop edits',async()=>{
  const f=fixture(),a=await f.build(),catalog=setup(f.db)
  f.place('a',farmLayout(a.plot)[0])
  await f.farmAction('a',a,'till',{bedId:0})
  await f.farmAction('a',a,'plant',{bedId:0,cropId:'carrot'})
  for(const row of f.db.state.pet_playground_plots)if(row.farm&&row.farm.beds[0])delete row.farm.beds[0].parameters
  await catalog.service.save('admin',{revision:0,crop:{...clone(CROPS[0]),minutes:1,yield:99,xp:999}})
  const water=await f.farmAction('a',a,'water',{bedId:0})
  assert.equal(water.beds[0].readyAt-f.now(),255000)
  f.advance(300000)
  const state=await f.farmAction('a',a,'harvest',{bedId:0})
  assert.equal(state.produce.carrot,4);assert.equal(state.xp,12)
})
test('farm admin handler requires an administrator even for listing and upload paths',async()=>{
  const actions=[],context={db:createCollectionStore({}),getUser:async()=>actions.push('user'),requireAdmin:async()=>{throw new Error('无权')}}
  const handler=require('../../cloudfunctions/api/handlers/playgroundFarm')(context)
  for(const action of ['list','prepareUpload','save'])await assert.rejects(()=>handler('client',action,{}),/无权/)
  assert.equal(actions.length,3)
})
