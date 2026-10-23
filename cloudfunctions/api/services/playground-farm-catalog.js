const { resolveEnvironmentAsset } = require('./playground-shared/asset-environment')
const crypto=require('crypto')
const {transaction}=require('./playground-transaction')
const {readDocument}=require('./playground-world')
const {inspectAtlas}=require('./playground-appearance-png')
const {levelIds,validateLevels}=require('./playground-access')
const {CROPS,SOILS}=require('./playground-shared/farm-model')
const COLLECTION='platform_configs',ID='playground_farm_catalog_v1'
const UPLOAD_PATH='packagePlayground/2d/baseImage/farm/custom/'
const validId=(id)=>typeof id==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)
async function readCatalog(db) {
  const row=await readDocument(db,COLLECTION,ID,'读取农作物配置',true)
  const crops=(row?row.crops:CROPS).map(({price,sell,yield:oldYield,xp,level,...crop})=>({...crop,unlockLevelIds:crop.unlockLevelIds||[],...(crop.atlas?{atlas:{...crop.atlas,fileID:resolveEnvironmentAsset(crop.atlas.fileID)}}:{})}))
  return {revision:row?row.revision:0,crops,soils:SOILS}
}
function normalizeCrop(value) {
  if(!value||!validId(value.id))throw new Error('作物编号须以小写字母开头，最多40位字母、数字、横线或下划线')
  const name=typeof value.name==='string'?value.name.trim():''
  if(!name||name.length>24)throw new Error('作物名称须为1至24个字符')
  const crop={id:value.id,name,enabled:value.enabled!==false,unlockLevelIds:levelIds(value.unlockLevelIds)}
  for(const [key,min,max] of [['minutes',1,525600]]) {
    if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)throw new Error(`${key}须为${min}至${max}之间的整数`)
    crop[key]=value[key]
  }
  crop.color=/^#[0-9a-f]{6}$/i.test(value.color||'')?value.color:'#7ca557'
  const stages=value.stages
  if(!Array.isArray(stages)||stages.length<2||stages.length>8||stages[0]!==0||stages[stages.length-1]!==100||
    stages.some((n,i)=>!Number.isInteger(n)||n<0||n>100||i>0&&n<=stages[i-1]))throw new Error('生长阶段须为2至8个递增整数百分比，从0开始、100成熟')
  const a=value.atlas
  if(!a||typeof a.fileID!=='string'||!a.fileID.startsWith('cloud://')||a.columns!==stages.length||a.rows!==1||![128,256,512].includes(a.frameSize)||a.anchorX!==.5||a.anchorY!==.75)throw new Error('请配置单行阶段PNG图集，落脚点为每格的50%、75%')
  crop.stages=stages.slice()
  crop.atlas={fileID:a.fileID,columns:a.columns,rows:1,frameSize:a.frameSize,anchorX:.5,anchorY:.75}
  return crop
}
module.exports=function createCatalog(context) {
  const {db,cloud}=context
  async function prepareUpload(openid,data) {
    if(!validId(data.id))throw new Error('请先填写有效的作物编号')
    return {cloudPath:UPLOAD_PATH+data.id+'/'+crypto.randomBytes(16).toString('hex')+'.png'}
  }
  async function save(openid,data) {
    const crop=normalizeCrop(data.crop),catalog=await readCatalog(db)
    await validateLevels(db,crop.unlockLevelIds)
    const old=catalog.crops.find((c)=>c.id===crop.id)
    if(!old||JSON.stringify(old.atlas)!==JSON.stringify(crop.atlas)) {
      const path=crop.atlas.fileID.slice(crop.atlas.fileID.indexOf('/',8)+1)
      const builtIn=CROPS.find((c)=>c.id===crop.id&&JSON.stringify(c.atlas)===JSON.stringify(crop.atlas))
      const env=typeof cloud.getWXContext==='function'?cloud.getWXContext().ENV:''
      const authority=crop.atlas.fileID.slice(8,crop.atlas.fileID.indexOf('/',8))
      if(!builtIn&&(!path.startsWith(UPLOAD_PATH+crop.id+'/')||!env||!authority.startsWith(env+'.')||!/^.+\/[a-f0-9]{32}\.png$/.test(path)))throw new Error('请使用本后台上传的PNG素材')
      const file=await cloud.downloadFile({fileID:crop.atlas.fileID})
      const info=inspectAtlas(file.fileContent,{columns:crop.atlas.columns,rows:1})
      if(info.frameSize!==crop.atlas.frameSize)throw new Error('阶段图每格尺寸与配置不一致')
    }
    return transaction(db,async(tx)=>{
      const current=await readCatalog(tx)
      if(current.revision!==data.revision)throw new Error('配置已被其他管理员修改，请刷新后重新编辑')
      const exists=current.crops.some((c)=>c.id===crop.id)
      const crops=exists?current.crops.map((c)=>c.id===crop.id?crop:c):current.crops.concat(crop)
      const next={revision:current.revision+1,crops,updatedBy:openid,updatedAt:context.nowMs?context.nowMs():Date.now()}
      await tx.collection(COLLECTION).doc(ID).set({data:next})
      return {revision:next.revision,crops,soils:SOILS}
    })
  }
  async function remove(openid,data) {
    if(!validId(data.id))throw new Error('请选择有效的植物')
    return transaction(db,async(tx)=>{
      const current=await readCatalog(tx)
      if(current.revision!==data.revision)throw new Error('配置已被其他管理员修改，请刷新后重新编辑')
      const next={revision:current.revision+1,crops:current.crops.filter((c)=>c.id!==data.id),updatedBy:openid,updatedAt:context.nowMs?context.nowMs():Date.now()}
      await tx.collection(COLLECTION).doc(ID).set({data:next})
      return {...next,soils:SOILS}
    })
  }
  return {list:async()=>({...await readCatalog(db),levels:(await db.collection('member_levels').orderBy('minPoints','asc').get()).data||[]}),prepareUpload,save,remove}
}
module.exports.readCatalog=readCatalog
module.exports.normalizeCrop=normalizeCrop
module.exports.UPLOAD_PATH=UPLOAD_PATH
