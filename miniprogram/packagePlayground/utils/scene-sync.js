const { callFunction, getCloudEnv } = require('../../utils/cloud')
const newer=(a,b)=>!b || !!a && (a.epoch>b.epoch || a.epoch===b.epoch && a.seq>b.seq)
class SceneSync {
  constructor(world,scene,onError,onConnection) {
    this.world=world;this.scene=scene;this.onError=onError||(()=>{})
    this.onConnection=onConnection||(()=>{})
    this.envId=typeof getCloudEnv==='function'?getCloudEnv():''
    this.seq=0;this.chain=Promise.resolve();this.active=false
    this.records=new Map();this.changes=new Map();this.watchers=[];this.applying=false;this.applyAgain=false
    this.channels={scene:{ready:false,attempts:0,revision:0},mail:{ready:false,attempts:0,revision:0}}
    if(world.setSocial) world.setSocial(scene.social||{})
  }
  credentials() {return {session:this.scene.session,sceneId:this.scene.sceneId}}
  clock(serverTime,sent) {
    if(!Number.isFinite(serverTime))return
    const rtt=Date.now()-sent
    if(this.bestRtt===undefined || rtt<=this.bestRtt*1.25) {
      this.bestRtt=Math.min(this.bestRtt===undefined?rtt:this.bestRtt,rtt)
      this.world.serverOffset=serverTime-(sent+Date.now())/2
    }
  }
  async apply(full=true) {
    this.fullApply=this.fullApply||full
    this.applyAgain=true
    if(this.applying)return
    this.applying=true
    try {
      while(this.applyAgain&&!this.world.destroyed) {
        this.applyAgain=false
        const changes=[...this.changes.values()]
        this.changes.clear()
        const rebuild=this.fullApply||!this.world.applySceneChanges||changes.some((r)=>!['presence','vehicle'].includes(r.kind))
        this.fullApply=false
        if(rebuild) await this.world.applySceneRecords([...this.records.values()].filter((r)=>!r.deleted))
        else await this.world.applySceneChanges(changes)
      }
    } finally {this.applying=false}
  }
  merge(record) {
    const old=this.records.get(record.id)
    if(old && !newer(record.version,old.version))return false
    this.eventSeq=(this.eventSeq||0)+1
    const next={...record,receivedSeq:this.eventSeq,mine:record.ownerId===this.scene.playerId}
    this.records.set(record.id,next)
    this.changes.set(record.id,next)
    return true
  }
  async snapshot(restorePosition=false) {
    const generation=this.generation
    const startedAt=this.eventSeq||0
    const records=[]
    let cursor=''
    do {
      const sent=Date.now()
      const result=await callFunction('playground','getScene',{...this.credentials(),cursor})
      if(this.world.destroyed || this.generation!==generation)return false
      records.push(...result.records);cursor=result.nextCursor
      this.clock(result.serverTime,sent)
    }while(cursor)
    if(restorePosition) {
      const actor=records.find((record)=>record.kind==='presence'&&record.id===this.scene.playerId)
      if(!actor || !actor.position || !this.world.character) throw new Error('暂时无法校准位置，正在重试')
      this.world.setCharacterInput(0,0)
      this.world.character.position={...actor.position}
      this.world.sceneTrail=[];this.world.characterTerrain=null
    }
    const ids=new Set(records.map((r)=>r.id))
    for(const [id,old] of this.records) if(!ids.has(id)&&(old.receivedSeq||0)<=startedAt)this.records.set(id,{...old,deleted:true})
    for(const record of records) {
      if(!this.records.has(record.id)||!this.records.get(record.id).version)this.records.set(record.id,record)
      else if(record.version)this.merge(record)
    }
    await this.apply()
    this.lastSnapshot=Date.now()
    return true
  }
  send(online=true) {
    const transmit=async(packet)=>{
      const generation=this.generation
      const {state,seq}=packet,sent=Date.now()
      try {
        const r=await callFunction('playground','syncScene',{...this.credentials(),...state,seq,online:packet.online,reconcile:true})
        this.clock(r.serverTime,sent)
        if(!r.accepted&&!(Number.isInteger(r.ackSeq)&&r.ackSeq>=seq))throw new Error('位置同步尚未确认，正在重试')
        this.pendingMovement=null
        this.world.ackSceneTrail(state.trail.length)
        if(r.corrected && this.world.character && generation===this.generation && !this.world.destroyed) {
          // Genuine collision/permission changes return the last safe point in
          // this reply. Keep joystick input live and avoid a full-scene fetch.
          this.world.characterRoute=null
          this.world.characterMoveToken=(this.world.characterMoveToken||0)+1
          this.world.character.position={...r.position}
          this.world.sceneTrail=[];this.world.characterTerrain=null
          if(this.world.prepareCharacterArea)this.world.prepareCharacterArea().catch(()=>{})
          this.world.onStatus(r.correctionReason==='permission'?'访问权限已过期，已回到庭院外':'路线已更新，已调整到可通行位置')
        }
      } catch(error) {
        if(!packet.online || !this.active || generation!==this.generation || this.world.destroyed ||
          !/移动过远|路径过长|不能穿过|上下车状态已更新/.test(error.message||'')) throw error
        this.pendingMovement=null
        // Reconcile rejected movement without rebuilding the canvas or reloading assets.
        this.world.recoveringScene=true
        this.world.setCharacterInput(0,0)
        try {
          if(await this.snapshot(true)) this.world.onStatus('角色位置已校准，可以继续移动')
        } finally {this.world.recoveringScene=false}
      }
    }
    const run=async()=>{
      // A timeout does not tell us whether the write committed. Retry the
      // immutable packet first; only then capture and send subsequent motion.
      if(this.pendingMovement)await transmit(this.pendingMovement)
      const packet={state:this.world.sceneState(),seq:++this.seq,online}
      this.pendingMovement=packet
      await transmit(packet)
    }
    const result=this.chain.then(run,run)
    this.chain=result.catch(()=>{})
    return result
  }
  connectionChanged() {
    const {scene,mail}=this.channels
    const reason=(error)=>{
      const message=String(error.errMsg||error.message||error||'')
      const code=String(error.errCode||error.code||'')
      const text=code+' '+message
      const hint=/permission|denied|unauthorized|权限|-502003/i.test(text)?'读取权限未配置':
        /collection.*(not exist|not found)|集合.*不存在|-502005/i.test(text)?'实时集合未创建':
        /index|索引/i.test(text)?'查询索引未就绪':
        /not a function|不支持|unsupported/i.test(text)?'当前微信版本不支持监听':'连接中断'
      return {hint,detail:(code?code+' · ':'')+message.slice(0,240)}
    }
    const details=[]
    for(const [key,label] of [['scene','场景'],['mail','好友消息']]) {
      const channel=this.channels[key]
      if(channel.error)details.push(label+'：'+reason(channel.error).hint+'；'+reason(channel.error).detail)
    }
    const message=scene.error?'场景连接暂时中断，正在重连':
      scene.ready?(mail.error?'场景已连接 · 好友消息重连中':''):'正在连接实时场景…'
    this.onConnection({message,envId:this.envId,scene:scene.ready?'已连接':'连接中',
      mail:mail.ready?'已连接':'连接中',details:details.join('\n')})
  }
  watchChannel(key,generation) {
    const channel=this.channels[key],revision=++channel.revision
    const current=()=>this.active && this.generation===generation && channel.revision===revision
    const failed=(error)=>{
      if(current()) {
        channel.revision++;channel.ready=false;channel.error=error||new Error('连接中断')
        if(key==='scene')this.live=false
        this.closeChannel(channel)
        const delay=Math.min(30000,2000*2**Math.min(channel.attempts++,4))
        channel.timer=setTimeout(()=>{if(this.active&&this.generation===generation)this.watchChannel(key,generation)},delay)
        this.connectionChanged()
      }
    }
    try {
      if(!this.scene.realtimeCollection || typeof wx==='undefined' || !wx.cloud || !wx.cloud.database)
        throw new Error('当前环境不支持实时监听，请升级微信并确认 api 已更新')
      const db=wx.cloud.database(this.envId?{env:this.envId}:{})
      const collection=db.collection(this.scene.realtimeCollection)
      // Include the ownership condition so the private query satisfies the read rule.
      const query=key==='scene'?collection.where({kind:'scene',communityId:this.scene.sceneId}).limit(16):
        collection.where({_id:'mail_'+this.scene.playerId,kind:'mail',_openid:'{openid}'}).limit(1)
      const watcher=query.watch({
        onChange:(event)=>{
          if(!current())return
          const recovered=!channel.ready||!!channel.error
          channel.ready=true;channel.error=null;channel.attempts=0
          if(recovered)this.connectionChanged()
          if(key==='scene') {
            this.live=true
            let changed=false
            const shards=event.docChanges&&event.docChanges.length?event.docChanges.map((change)=>change.doc).filter(Boolean):event.docs||[]
            for(const shard of shards)for(const record of Object.values(shard.records||{}))changed=this.merge(record)||changed
            if(changed)this.apply(false).catch((error)=>{if(current())this.onError(error)})
          } else {
            const state=(event.docs||[])[0]
            if(state&&this.world.setSocial)this.world.setSocial(state)
          }
        },onError:failed
      })
      if(!current()) {Promise.resolve(watcher.close()).catch(()=>{});return false}
      channel.watcher=watcher;this.watchers.push(watcher)
      return true
    } catch(error){failed(error);return false}
  }
  closeChannel(channel) {
    clearTimeout(channel.timer);channel.timer=null
    const watcher=channel.watcher;channel.watcher=null
    if(watcher) {
      this.watchers=this.watchers.filter((item)=>item!==watcher)
      try {Promise.resolve(watcher.close()).catch(()=>{})}catch(error){}
    }
  }
  watch(generation) {
    this.watchChannel('scene',generation)
    this.watchChannel('mail',generation)
    this.connectionChanged()
  }
  start() {
    if(this.active)return
    this.active=true
    const generation=this.generation=(this.generation||0)+1
    this.watch(generation)
    const tick=async()=>{
      const start=Date.now()
      try {
        const state=this.world.sceneState()
        const signature=JSON.stringify([state.position,state.moving,state.running,state.mirrored,state.characterType])
        if(this.pendingMovement || state.trail.length || signature!==this.signature || start-(this.lastSent||0)>=2000) {
          await this.send(true)
          if(this.active&&this.generation===generation) {this.signature=signature;this.lastSent=Date.now()}
        }
        this.sendFailures=0
      } catch(error){
        this.sendFailures=(this.sendFailures||0)+1
        if(this.active&&this.generation===generation)this.onError(error)
      }
      const delay=this.sendFailures?Math.min(2000,1000*2**Math.min(this.sendFailures-1,1)):Math.max(0,100-(Date.now()-start))
      if(this.active&&this.generation===generation)this.timer=setTimeout(tick,delay)
    }
    tick()
    const refresh=async()=>{
      try {await this.snapshot();this.snapshotFailures=0}
      catch(error){
        this.snapshotFailures=(this.snapshotFailures||0)+1
        if(this.active&&this.generation===generation)this.onError(error)
      }
      const delay=this.live?30000:Math.min(30000,1000*2**Math.min(this.snapshotFailures||0,5))
      if(this.active&&this.generation===generation)this.snapshotTimer=setTimeout(refresh,delay)
    }
    if(this.lastSnapshot && Date.now()-this.lastSnapshot<1000) this.snapshotTimer=setTimeout(refresh,this.live?30000:1000)
    else refresh()
  }
  stop() {
    this.active=false;this.generation=(this.generation||0)+1
    clearTimeout(this.timer);clearTimeout(this.snapshotTimer)
    for(const channel of Object.values(this.channels)) {channel.revision++;channel.ready=false;this.closeChannel(channel)}
    this.watchers=[];this.live=false;this.signature=null
    return this.send(false)
  }
  async social(action,data={}) {
    await this.send(true)
    const result=await callFunction('playground',action,{...this.credentials(),...data})
    if(!this.world.destroyed&&this.world.setSocial)this.world.setSocial(result)
    return result
  }
  async vehicleAction(operation,vehicleId) {
    if(this.world.vehicleBusy)throw new Error('车辆正在操作中')
    this.world.vehicleBusy=true
    this.world.setCharacterInput(0,0)
    try {
      await this.send(true)
      const run=async()=>{
        const result=await callFunction('playground','vehicleAction',{...this.credentials(),operation,vehicleId})
        if(this.world.destroyed)return result
        this.clock(result.serverTime,Date.now())
        this.merge(result.actor);this.merge(result.vehicle)
        await this.apply(false)
        const latest=this.records.get(result.actor.id)
        if(latest&&!newer(latest.version,result.actor.version))this.world.applyOwnVehicleActor(result.actor,true)
        return result
      }
      const result=this.chain.then(run,run)
      this.chain=result.catch(()=>{})
      return await result
    } catch(error) {
      // A lost reply may still have committed. Recover before enabling controls.
      if(!this.world.destroyed)await this.snapshot(true).catch(()=>{})
      throw error
    } finally {this.world.vehicleBusy=false}
  }
  async setVehicleSpeed(multiplier) {
    if(this.world.vehicleBusy)throw new Error('车辆正在操作中')
    this.world.vehicleBusy=true
    this.world.setCharacterInput(0,0)
    try {
      await this.send(true)
      const run=async()=>{
        const result=await callFunction('playground','setVehicleSpeed',{...this.credentials(),multiplier})
        if(!this.world.destroyed){
          if(result.vehicle){this.merge(result.vehicle);await this.apply(false)}
          this.world.setVehicleSpeed(result.speedMultiplier)
        }
        return result
      }
      const result=this.chain.then(run,run)
      this.chain=result.catch(()=>{})
      return await result
    } finally {this.world.vehicleBusy=false}
  }
  async movePet(petId,target) {
    const token=this.petCommand=(this.petCommand||0)+1
    if(!this.petCommands)this.petCommands=new Map()
    this.petCommands.set(petId,token)
    const prediction=this.world.predictPetMove?this.world.predictPetMove(petId,target,token):Promise.resolve()
    try {
      const result=await callFunction('playground','movePet',{...this.credentials(),petId,target,commandSeq:token})
      if(this.world.destroyed||token!==this.petCommands.get(petId))return
      this.world.applySharedPet({...result.pet,commandSeq:token},true)
    } catch(error) {
      if(this.world.rejectPetMove)this.world.rejectPetMove(petId,token)
      throw error
    } finally {await prediction}
  }
  async interactPet(petId) {
    await this.send(true)
    const token=this.petCommand=(this.petCommand||0)+1
    if(!this.petCommands)this.petCommands=new Map()
    this.petCommands.set(petId,token)
    const result=await callFunction('playground','interactPet',{...this.credentials(),petId,commandSeq:token})
    if(!this.world.destroyed&&token===this.petCommands.get(petId))this.world.applySharedPet({...result.pet,commandSeq:token},true)
  }
}
module.exports={SceneSync}
