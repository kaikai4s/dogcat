const {callFunction,ensureLogin,showError}=require('../../utils/cloud')
const {choosePhotos,uploadFile,STATUS_TEXT}=require('../utils/playgroundAppearanceUpload')
const {formatDateTime}=require('../../utils/format')
Page({
  data:{loading:true,busy:false,progress:'',targets:[],targetIndex:0,photos:[],remark:'',applications:[],cursor:'',hasMore:false,error:''},
  onLoad(query={}) {this.initialPetId=query.petId||''},
  onShow() {this.closed=false;ensureLogin({content:'登录后申请专属形象。'}).then(()=>this.load()).catch(showError)},
  onUnload() {this.closed=true;this.loadToken=(this.loadToken||0)+1},
  async load() {
    const token=this.loadToken=(this.loadToken||0)+1
    this.setData({loading:true,error:''})
    try {
      const [options,requests]=await Promise.all([callFunction('playgroundAppearance','options'),callFunction('playgroundAppearance','listMine')])
      if(this.closed||token!==this.loadToken)return
      const targets=[{id:'character',targetType:'character',name:'我的角色',label:'我的角色'},...(options.pets||[]).map((pet)=>({...pet,targetType:'pet',label:`宠物 · ${pet.name}（${pet.species==='cat'?'猫咪':'狗狗'} · ${pet.id.slice(-4)}）`}))]
      const previous=this.data.targets[this.data.targetIndex]
      const selected=targets.findIndex((t)=>t.id===(previous?previous.id:this.initialPetId))
      this.setData({targets,targetIndex:Math.max(0,selected),applications:this.decorate(requests.list),cursor:requests.nextCursor,hasMore:!!requests.nextCursor})
    } catch(error) {if(!this.closed&&token===this.loadToken)this.setData({error:error.message||'申请加载失败'})}
    finally {if(!this.closed&&token===this.loadToken)this.setData({loading:false})}
  },
  decorate(rows=[]) {return rows.map((row)=>({...row,statusText:STATUS_TEXT[row.status]||row.status,timeText:formatDateTime(row.createdAt),canCancel:['draft','pending','processing'].includes(row.status)}))},
  async loadMore() {
    if(this.data.loading||!this.data.hasMore)return
    const token=this.loadToken
    this.setData({loading:true})
    try {
      const result=await callFunction('playgroundAppearance','listMine',{cursor:this.data.cursor})
      if(!this.closed&&token===this.loadToken)this.setData({applications:this.data.applications.concat(this.decorate(result.list)),cursor:result.nextCursor,hasMore:!!result.nextCursor})
    } catch(error) {showError(error)}
    finally {if(!this.closed&&token===this.loadToken)this.setData({loading:false})}
  },
  changeTarget(e) {if(!this.data.busy)this.setData({targetIndex:Number(e.detail.value)||0})},
  inputRemark(e) {this.setData({remark:e.detail.value})},
  async addPhotos() {
    if(this.data.busy||this.data.photos.length>=6)return
    try {
      const photos=await choosePhotos(6-this.data.photos.length)
      if(!this.closed)this.setData({photos:this.data.photos.concat(photos).slice(0,6)})
    } catch(error) {showError(error)}
  },
  removePhoto(e) {if(!this.data.busy)this.setData({photos:this.data.photos.filter((_,i)=>i!==Number(e.currentTarget.dataset.index))})},
  previewPhoto(e) {wx.previewImage({current:e.currentTarget.dataset.path,urls:this.data.photos.map((p)=>p.path)})},
  async submit() {
    if(this.data.busy)return
    const choice=this.data.targets[this.data.targetIndex],photos=[...this.data.photos],remark=this.data.remark
    if(!choice||!photos.length)return showError(new Error('请选择定制对象，并至少上传一张清晰照片'))
    this.setData({busy:true,progress:'正在创建申请…'})
    try {
      const draft=await callFunction('playgroundAppearance','createDraft',{targetType:choice.targetType,petId:choice.targetType==='pet'?choice.id:''})
      const uploaded=[]
      for(let i=0;i<photos.length;i++) {
        const extension=/\.png$/i.test(photos[i].path)?'png':'jpg'
        const path=draft.photoPrefix+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2)+'.'+extension
        uploaded.push(await uploadFile(photos[i].path,path,(value)=>{
          if(!this.closed)this.setData({progress:`上传照片 ${i+1}/${photos.length} · ${value}%`})
        }))
      }
      await callFunction('playgroundAppearance','submit',{requestId:draft._id,photos:uploaded,remark})
      if(!this.closed) {
        this.setData({photos:[],remark:''})
        wx.showToast({title:'申请已提交',icon:'success'})
        await this.load()
      }
    } catch(error) {if(!this.closed)showError(error)}
    finally {if(!this.closed)this.setData({busy:false,progress:''})}
  },
  cancel(e) {
    if(this.data.busy)return
    const requestId=e.currentTarget.dataset.id
    wx.showModal({title:'取消这次定制？',content:'取消后可以重新提交申请，已生效的形象不会改变。',success:async(result)=>{
      if(!result.confirm||this.closed)return
      this.setData({busy:true})
      try {await callFunction('playgroundAppearance','cancel',{requestId});await this.load()}
      catch(error) {showError(error)}
      finally {if(!this.closed)this.setData({busy:false})}
    }})
  }
})
