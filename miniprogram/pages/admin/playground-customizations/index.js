const {callFunction,showError}=require('../../../utils/cloud')
const {chooseAtlas,uploadFile,STATUS_TEXT}=require('../utils/playgroundAppearanceUpload')
const {formatDateTime}=require('../../../utils/format')
const DIRECTIONS=[{key:'sw',label:'左前 SW',view:'面向屏幕左下方，正面可见'},{key:'se',label:'右前 SE',view:'面向屏幕右下方，正面可见'},{key:'nw',label:'左后 NW',view:'面向屏幕左上方，背面朝向镜头'},{key:'ne',label:'右后 NE',view:'面向屏幕右上方，背面朝向镜头'}]
function directionAtlases(){return DIRECTIONS.map((direction)=>({...direction,atlas:null}))}
function characterPrompt(action,direction) {
  const view=DIRECTIONS.find((item)=>item.key===direction)||DIRECTIONS[0]
  const motion=action==='run'?'奔跑：输出完整循环的12个连续关键帧，手臂与双腿有明显交替摆动、膝盖弯曲和腾空相位；':'行走：输出完整循环的12个连续关键帧，双腿自然交替迈步，一只脚保持支撑相位，第1帧采用适合停留的站姿，同时用于该方向待机；'
  return `请根据申请人上传的清晰参考照片，制作同一个人物的宠物庄园2D等距视角${action==='run'?'奔跑':'行走'}精灵图。保持人物脸型、发型、肤色、服装颜色和配饰一致。\n\n方向：${view.view}（${view.label}），整个动画保持此朝向，不要转向镜头。\n动作：${motion}\n\n文件格式：静态 PNG，RGBA 透明背景，关闭隔行扫描；画布必须为 1024×768 像素，4列×3行，每格256×256像素，按从左到右、从上到下排列12帧。12格都要有完整的人物动作，不能留空、重复首尾帧或加边框、文字、序号。\n\n构图：每格均为完整全身，人物居中，头发、手脚不得超出格子；人物脚底统一落在每格约 y=230 像素的基准线上，头部大小和人物比例逐帧稳定。线条与阴影清晰，透明边缘干净。文件小于8MB。不要绿色背景、棋盘格、场景、投影、运动模糊、水印或额外人物。`
}
Page({
  data:{tabs:[{value:'pending',label:'待处理'},{value:'processing',label:'制作中'},{value:'completed',label:'已生效'},{value:'rejected',label:'未通过'},{value:'',label:'全部'}],status:'pending',
    applications:[],cursor:'',hasMore:false,loading:false,busy:false,error:'',detail:null,walk:null,run:null,
    directions:DIRECTIONS,walkAtlases:directionAtlases(),runAtlases:directionAtlases(),
    promptAction:'walk',promptDirection:'sw',generationPrompt:characterPrompt('walk','sw'),allAtlasesReady:false,
    reason:'',progress:'',previewLeft:0,previewTop:0},
  onShow() {this.closed=false;this.load(true);if(this.data.detail&&(this.data.walk||this.data.run||this.hasCharacterAtlases()))this.startPreview()},
  onHide() {this.stopPreview()},
  onUnload() {this.closed=true;this.requestToken=(this.requestToken||0)+1;this.stopPreview()},
  async load(reset=false) {
    const token=this.requestToken=(this.requestToken||0)+1
    this.setData({loading:true,error:''})
    try {
      const result=await callFunction('playgroundAppearance','listAdmin',{status:this.data.status,cursor:reset?'':this.data.cursor})
      if(this.closed||token!==this.requestToken)return
      const list=(result.list||[]).map((item)=>({...item,statusText:STATUS_TEXT[item.status],timeText:formatDateTime(item.createdAt)}))
      this.setData({applications:reset?list:this.data.applications.concat(list),cursor:result.nextCursor,hasMore:!!result.nextCursor})
    } catch(error) {if(!this.closed&&token===this.requestToken)this.setData({error:error.message||'申请加载失败'})}
    finally {if(!this.closed&&token===this.requestToken)this.setData({loading:false})}
  },
  refresh() {if(!this.data.busy)return this.load(true)},
  loadMore() {if(!this.data.busy&&!this.data.loading&&this.data.hasMore)return this.load()},
  changeStatus(e) {if(!this.data.busy){this.setData({status:e.currentTarget.dataset.status});this.load(true)}},
  async openDetail(e) {
    if(this.data.busy)return
    const token=this.detailToken=(this.detailToken||0)+1
    this.setData({busy:true})
    try {
      const result=await callFunction('playgroundAppearance','detailAdmin',{requestId:e.currentTarget.dataset.id})
      if(this.closed||token!==this.detailToken)return
      this.stopPreview()
      this.setData({detail:{...result,photoUrls:result.photoUrls&&result.photoUrls.length?result.photoUrls:result.photos,statusText:STATUS_TEXT[result.status],canProcess:['pending','processing'].includes(result.status)},walk:null,run:null,walkAtlases:directionAtlases(),runAtlases:directionAtlases(),promptAction:'walk',promptDirection:'sw',generationPrompt:characterPrompt('walk','sw'),allAtlasesReady:false,reason:'',previewLeft:0,previewTop:0})
    } catch(error) {if(!this.closed)showError(error)}
    finally {if(!this.closed)this.setData({busy:false})}
  },
  closeDetail() {if(!this.data.busy){this.detailToken=(this.detailToken||0)+1;this.stopPreview();this.setData({detail:null,walk:null,run:null,walkAtlases:directionAtlases(),runAtlases:directionAtlases(),allAtlasesReady:false})}},
  previewPhoto(e) {wx.previewImage({current:e.currentTarget.dataset.url,urls:this.data.detail.photoUrls||this.data.detail.photos})},
  async selectAtlas(e) {
    if(this.data.busy||!this.data.detail||!this.data.detail.canProcess)return
    const action=e.currentTarget.dataset.action
    if(!['walk','run'].includes(action))return
    const direction=e.currentTarget.dataset.direction||''
    const requestId=this.data.detail._id
    try {
      const atlas=await chooseAtlas(this.data.detail.targetType==='character'?3:6)
      if(!this.closed&&this.data.detail&&this.data.detail._id===requestId) {
        if(this.data.detail.targetType==='character') {
          const slots=this.data[action+'Atlases'].map((item)=>item.key===direction?{...item,atlas}:item)
          const values={walkAtlases:this.data.walkAtlases,runAtlases:this.data.runAtlases}
          values[action+'Atlases']=slots
          this.setData({...values,allAtlasesReady:[...values.walkAtlases,...values.runAtlases].every((item)=>!!item.atlas)})
        } else this.setData({[action]:atlas})
        this.startPreview()
      }
    } catch(error) {showError(error)}
  },
  removeRun() {if(!this.data.busy)this.setData({run:null})},
  hasCharacterAtlases() {return [...this.data.walkAtlases,...this.data.runAtlases].some((item)=>item.atlas)},
  selectPromptAction(e) {const promptAction=e.currentTarget.dataset.action;this.setData({promptAction,generationPrompt:characterPrompt(promptAction,this.data.promptDirection)})},
  selectPromptDirection(e) {const promptDirection=e.currentTarget.dataset.direction;this.setData({promptDirection,generationPrompt:characterPrompt(this.data.promptAction,promptDirection)})},
  copyPrompt() {wx.setClipboardData({data:this.data.generationPrompt,success:()=>wx.showToast({title:'提示词已复制',icon:'success'})})},
  inputReason(e) {this.setData({reason:e.detail.value})},
  startPreview() {
    this.stopPreview()
    let frame=0
    this.previewTimer=setInterval(()=>{
      if(!this.closed&&this.data.detail)this.setData({previewLeft:-(frame%4)*100,previewTop:-Math.floor(frame/4)*100})
      frame=(frame+1)%(this.data.detail&&this.data.detail.targetType==='character'?12:24)
    },100)
  },
  stopPreview() {if(this.previewTimer)clearInterval(this.previewTimer);this.previewTimer=null},
  publish() {
    if(this.data.busy||!this.data.detail)return
    if(this.data.detail.targetType==='character'&&!this.allCharacterAtlases())return showError(new Error('请补齐四个方向的行走和奔跑图集'))
    if(this.data.detail.targetType!=='character'&&!this.data.walk)return showError(new Error('请先选择24帧行走图集'))
    const detail=this.data.detail
    wx.showModal({title:'发布这套专属形象？',content:`将绑定给「${detail.ownerName}」的${detail.targetType==='pet'?'宠物「'+detail.targetName+'」':'角色'}。这套形象不能再分配给其他角色或宠物。`,success:(result)=>{
      if(result.confirm&&!this.closed&&this.data.detail&&this.data.detail._id===detail._id&&!this.data.busy)this.uploadAndPublish()
    }})
  },
  async uploadAndPublish() {
    const detail=this.data.detail,walk=this.data.walk,run=this.data.run
    if(this.data.busy||!detail||(detail.targetType==='character'?!this.allCharacterAtlases():!walk))return
    this.setData({busy:true,progress:'正在准备上传…'})
    try {
      const batch=await callFunction('playgroundAppearance','prepareUpload',{requestId:detail._id})
      let publishData
      const atlasByteLengths={}
      if(detail.targetType==='character') {
        const walkFileIDs={},runFileIDs={}
        for(const direction of DIRECTIONS)for(const action of ['walk','run']) {
          const slot=this.data[action+'Atlases'].find((item)=>item.key===direction.key)
          const progress=(value)=>{if(!this.closed)this.setData({progress:`上传${action==='walk'?'行走':'奔跑'}${direction.label} ${value}%`})}
          const id=await uploadFile(slot.atlas.path,batch[action+'Paths'][direction.key],progress)
          ;(action==='walk'?walkFileIDs:runFileIDs)[direction.key]=id
          if(slot.atlas.byteLength)atlasByteLengths[action+'-'+direction.key]=slot.atlas.byteLength
        }
        publishData={walkFileIDs,runFileIDs}
      } else {
        const walkFileID=await uploadFile(walk.path,batch.walkPath,(progress)=>{if(!this.closed)this.setData({progress:`上传行走图集 ${progress}%`})})
        let runFileID=''
        if(run)runFileID=await uploadFile(run.path,batch.runPath,(progress)=>{if(!this.closed)this.setData({progress:`上传奔跑图集 ${progress}%`})})
        publishData={walkFileID,runFileID}
        if(walk.byteLength)atlasByteLengths.walk=walk.byteLength
        if(run&&run.byteLength)atlasByteLengths.run=run.byteLength
      }
      if(!this.closed)this.setData({progress:'正在校验并绑定专属形象…'})
      const result=await callFunction('playgroundAppearance','publish',{requestId:detail._id,token:batch.token,...publishData,atlasByteLengths})
      if(!this.closed) {
        this.stopPreview()
        this.setData({detail:null,walk:null,run:null,walkAtlases:directionAtlases(),runAtlases:directionAtlases(),allAtlasesReady:false})
        wx.showModal({title:'专属形象已生效',content:result.syncPending?'形象已保存，场景将在下一次同步时更新。':'已绑定申请对象，其他角色和宠物不会改变。',showCancel:false})
        await this.load(true)
      }
    } catch(error) {if(!this.closed)showError(error)}
    finally {if(!this.closed)this.setData({busy:false,progress:''})}
  },
  allCharacterAtlases() {return [...this.data.walkAtlases,...this.data.runAtlases].every((item)=>!!item.atlas)},
  async reject() {
    if(this.data.busy||!this.data.detail)return
    if(!this.data.reason.trim())return showError(new Error('请填写未通过原因，让用户知道如何补充照片'))
    this.setData({busy:true})
    try {
      await callFunction('playgroundAppearance','reject',{requestId:this.data.detail._id,reason:this.data.reason})
      if(!this.closed) {this.stopPreview();this.setData({detail:null});await this.load(true)}
    } catch(error) {if(!this.closed)showError(error)}
    finally {if(!this.closed)this.setData({busy:false})}
  },
  async disableAppearance() {
    if(this.data.busy||!this.data.detail)return
    const detail=this.data.detail
    wx.showModal({
      title:'暂扣作废专属形象？',
      content:`作废后「${detail.ownerName}」在庄园中将恢复显示通用外观（支持后续随时重新开启）。请输入作废说明：`,
      editable:true,
      placeholderText:'违规原因（如：服务违规/资质暂停）',
      success:async(res)=>{
        if(!res.confirm)return
        const reason=String(res.content||'').trim()||'管理员暂扣作废'
        this.setData({busy:true})
        try {
          await callFunction('playgroundAppearance','disableAppearance',{requestId:detail._id,reason})
          wx.showToast({title:'已作废形象',icon:'success'})
          if(!this.closed) {
            this.setData({detail:{...detail,appearanceDisabled:true,appearanceDisabledReason:reason}})
            await this.load(true)
          }
        } catch(err){showError(err)}
        finally{if(!this.closed)this.setData({busy:false})}
      }
    })
  },
  async enableAppearance() {
    if(this.data.busy||!this.data.detail)return
    const detail=this.data.detail
    wx.showModal({
      title:'重新启用专属形象？',
      content:`重新启用后，「${detail.ownerName}」在庄园中将立即恢复专属24帧图集外观。`,
      confirmText:'确认启用',
      success:async(res)=>{
        if(!res.confirm)return
        this.setData({busy:true})
        try {
          await callFunction('playgroundAppearance','enableAppearance',{requestId:detail._id})
          wx.showToast({title:'已恢复生效',icon:'success'})
          if(!this.closed) {
            this.setData({detail:{...detail,appearanceDisabled:false,appearanceDisabledReason:''}})
            await this.load(true)
          }
        } catch(err){showError(err)}
        finally{if(!this.closed)this.setData({busy:false})}
      }
    })
  },
  swallow() {}
})
