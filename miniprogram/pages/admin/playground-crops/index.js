const {callFunction,showError}=require('../../../utils/cloud')
const {uploadFile}=require('../utils/playgroundAppearanceUpload')
const {can}=require('../../../utils/adminAccess')
const fields=[{key:'minutes',label:'生长时间（分钟）',min:1,max:525600}]
const stageValues=(text)=>String(text).split(/[,，\s]+/).filter(Boolean).map(Number)
function choosePng(source) {
  return new Promise((resolve,reject)=>{
    const success=(result)=>{
      const file=(result.tempFiles||[])[0],path=file&&(file.path||file.tempFilePath)
      if(!path||!file.size||file.size>8*1024*1024)return reject(new Error('请选择不超过8MB的透明PNG原图'))
      wx.getImageInfo({src:path,success:(info)=>{
        if(String(info.type).toLowerCase()!=='png')return reject(new Error('请选择透明PNG原图'))
        resolve({path,width:info.width,height:info.height})
      },fail:reject})
    }
    if(source===0)wx.chooseMessageFile({count:1,type:'file',extension:['png'],success,fail:reject})
    else wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album'],sizeType:['original'],success,fail:reject})
  })
}
Page({
  data:{levels:[],levelChoices:[],crops:[],revision:0,loading:false,busy:false,error:'',form:null,isNew:false,fields,stagesText:'0,20,65,100',previewStage:0,progress:0},
  onShow(){this.closed=false;if(!this.data.form)this.load()},
  onUnload(){this.closed=true;this.loadToken=(this.loadToken||0)+1},
  async load() {
    const token=this.loadToken=(this.loadToken||0)+1
    this.setData({loading:true,error:''})
    try {
      const result=await callFunction('playgroundFarm','list')
      if(!this.closed&&token===this.loadToken)this.setData({crops:result.crops,revision:result.revision,levels:result.levels||[]})
    }catch(error){if(!this.closed&&token===this.loadToken)this.setData({error:error.message||'加载失败'})}
    finally{if(!this.closed&&token===this.loadToken)this.setData({loading:false})}
  },
  edit(e) {
    if(this.data.busy||!can(this.data.adminAccess,'playgroundFarm.save'))return
    const crop=this.data.crops.find((c)=>c.id===e.currentTarget.dataset.id)
    this.setData({form:JSON.parse(JSON.stringify(crop||{id:'',name:'',minutes:5,unlockLevelIds:[],color:'#7ca557',enabled:true,stages:[0,20,65,100],atlas:null})),
      levelChoices:this.data.levels.map((l)=>({...l,checked:!!crop&&(crop.unlockLevelIds||[]).includes(l._id)})),isNew:!crop,previewStage:0,stagesText:(crop&&crop.stages||[0,20,65,100]).join(',')})
  },
  close(){if(!this.data.busy){this.setData({form:null});this.load()}},
  input(e){const key=e.currentTarget.dataset.key;if(['id','name'].includes(key))this.setData({['form.'+key]:e.detail.value});else if(fields.some((f)=>f.key===key))this.setData({['form.'+key]:e.detail.value})},
  levelsChange(e){this.setData({'form.unlockLevelIds':e.detail.value})},
  async removeCrop() {
    if(this.data.busy||this.data.isNew||!can(this.data.adminAccess,'playgroundFarm.remove'))return
    const confirmed=await new Promise((resolve)=>wx.showModal({title:'删除作物',content:'删除后不能再种植，已经种植的装饰会保留。',success:(r)=>resolve(r.confirm),fail:()=>resolve(false)}))
    if(!confirmed)return
    this.setData({busy:true})
    try{const result=await callFunction('playgroundFarm','remove',{id:this.data.form.id,revision:this.data.revision});if(!this.closed)this.setData({crops:result.crops,revision:result.revision,form:null})}
    catch(error){showError(error)}finally{if(!this.closed)this.setData({busy:false})}
  },
  stagesInput(e){this.setData({stagesText:e.detail.value,previewStage:0})},
  enabledChange(e){this.setData({'form.enabled':e.detail.value})},
  preview(e){this.setData({previewStage:Number(e.currentTarget.dataset.index)})},
  async upload() {
    if(this.data.busy||!can(this.data.adminAccess,'playgroundFarm.prepareUpload'))return
    this.setData({busy:true,progress:0})
    try {
      const selection=await new Promise((resolve,reject)=>wx.showActionSheet({itemList:['从聊天文件选择PNG','从相册选择原图'],success:resolve,fail:reject}))
      const file=await choosePng(selection.tapIndex),stages=stageValues(this.data.stagesText)
      if(stages.length<2||stages.length>8||file.width!==file.height*stages.length||![128,256,512].includes(file.height))throw new Error('阶段图须为单行，每格128、256或512像素；列数须与阶段数量一致')
      const {cloudPath}=await callFunction('playgroundFarm','prepareUpload',{id:this.data.form.id})
      const fileID=await uploadFile(file.path,cloudPath,(progress)=>{if(!this.closed)this.setData({progress})})
      if(!this.closed)this.setData({'form.atlas':{fileID,frameSize:file.height,columns:stages.length,rows:1,anchorX:.5,anchorY:.75},'form.stages':stages,previewStage:0})
    }catch(error){if(!/cancel/i.test(error.errMsg||'')&&!this.closed)showError(error)}
    finally{if(!this.closed)this.setData({busy:false,progress:0})}
  },
  async save() {
    if(this.data.busy||!can(this.data.adminAccess,'playgroundFarm.save'))return
    const crop={...this.data.form,stages:stageValues(this.data.stagesText)}
    for(const f of fields) {
      crop[f.key]=Number(crop[f.key])
      if(String(this.data.form[f.key]).trim()===''||!Number.isInteger(crop[f.key])||crop[f.key]<f.min||crop[f.key]>f.max)return showError(new Error(`${f.label}须为${f.min}至${f.max}之间的整数`))
    }
    this.setData({busy:true})
    try {
      const result=await callFunction('playgroundFarm','save',{revision:this.data.revision,crop})
      if(!this.closed){this.setData({crops:result.crops,revision:result.revision,form:null});wx.showToast({title:'配置已发布',icon:'success'})}
    }catch(error){if(!this.closed)showError(error)}
    finally{if(!this.closed)this.setData({busy:false})}
  }
})
