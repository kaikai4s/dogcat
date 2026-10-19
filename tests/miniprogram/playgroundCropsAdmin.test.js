const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {CROPS}=require('../../miniprogram/packagePlayground/utils/farm-model')

function fixture({wx={},uploadFile=async()=>'',callFunction=async()=>({crops:[],revision:1})}={}) {
  let page
  const calls=[],errors=[]
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/admin/playground-crops/index'),'utf8'),{
    Page(options){page=options},wx:{showToast(){},...wx},
    require(name){
      if(name.endsWith('adminAccess'))return {can:require('../../miniprogram/utils/adminAccess').can}
      if(name.endsWith('playgroundAppearanceUpload'))return {uploadFile}
      return {callFunction:async(module,action,data)=>{calls.push({module,action,data});return callFunction(module,action,data)},showError:(error)=>errors.push(error)}
    }
  })
  page.data={...page.data,adminAccess:{superAdmin:true},crops:CROPS}
  page.setData=(updates)=>{for(const [key,value]of Object.entries(updates)){
    const parts=key.split('.');let target=page.data
    for(const part of parts.slice(0,-1))target=target[part]
    target[parts.at(-1)]=value
  }}
  page.edit({currentTarget:{dataset:{id:'carrot'}}})
  return {page,calls,errors}
}

test('crop editor serializes numeric input and stage thresholds when publishing',async()=>{
  const {page,calls,errors}=fixture()
  page.levelsChange({detail:{value:['gold']}})
  page.input({currentTarget:{dataset:{key:'minutes'}},detail:{value:'90'}})
  page.stagesInput({detail:{value:'0， 25,70,100'}})
  await page.save()
  assert.equal(errors.length,0);assert.equal(calls.length,1)
  const request=calls[0]
  assert.equal(request.module,'playgroundFarm');assert.equal(request.action,'save');assert.equal(request.data.revision,0)
  assert.deepEqual(Array.from(request.data.crop.unlockLevelIds),['gold']);assert.equal(request.data.crop.price,undefined);assert.equal(request.data.crop.minutes,90)
  assert.deepEqual(Array.from(request.data.crop.stages),[0,25,70,100])
  assert.equal(page.data.form,null);assert.equal(page.data.revision,1)
})

test('crop editor rejects blank durations and respects read-only admin access',async()=>{
  const {page,calls,errors}=fixture()
  page.data.form.minutes=''
  await page.save()
  assert.equal(calls.length,0);assert.match(errors[0].message,/生长时间/)
  page.data.form.minutes=5;page.data.adminAccess={permissions:['playgroundFarm.list']}
  await page.save();await page.upload()
  assert.equal(calls.length,0)
})

test('chat-file uploads keep PNG dimensions and use the server-generated storage path',async()=>{
  const uploads=[],fileID='cloud://env.bucket/farm/custom/test.png'
  const {page,calls,errors}=fixture({
    wx:{showActionSheet(options){options.success({tapIndex:0})},
      chooseMessageFile(options){assert.equal(options.extension[0],'png');options.success({tempFiles:[{path:'/tmp/crop.png',size:12000}]})},
      getImageInfo(options){options.success({type:'png',width:1024,height:256})}},
    callFunction:async()=>({cloudPath:'packagePlayground/2d/baseImage/farm/custom/carrot/server.png'}),
    uploadFile:async(...args)=>{uploads.push(args);return fileID}
  })
  await page.upload()
  assert.equal(errors.length,0);assert.equal(calls[0].action,'prepareUpload');assert.equal(calls[0].data.id,'carrot')
  assert.equal(uploads[0][0],'/tmp/crop.png');assert.equal(uploads[0][1],'packagePlayground/2d/baseImage/farm/custom/carrot/server.png')
  assert.equal(page.data.form.atlas.fileID,fileID);assert.equal(page.data.form.atlas.frameSize,256)
  assert.equal(page.data.form.atlas.columns,4);assert.equal(page.data.form.atlas.anchorY,.75)
  assert.equal(page.data.busy,false)
})
