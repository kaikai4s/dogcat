const { transaction } = require('../playground-transaction')
const crypto = require('crypto')
const world = require('../playground-world')
const { createNavigation } = require('./navigation')
const { yardLayout } = require('./yard-layout')
const { sampleMotion } = require('./shared-motion')
const COLLECTION = 'pet_playground_plots'
const presenceId = (openid) => 'presence_' + world.hash(openid)
const residentId = (openid) => 'resident_' + world.hash(openid)
const layoutKey = (plots) => world.hash(JSON.stringify(plots.map((p)=>[p._id,p.x,p.z,p.size]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))))
const inside = (p, plot) => Math.abs(p.x - plot.x) < (plot.size || 48) / 2 && Math.abs(p.z - plot.z) < (plot.size || 48) / 2
function obstacles(plot, solid = false) {
  const h = (plot.size || 48) / 2, x = plot.x, z = plot.z, t = .65
  if (solid) return [{ minX:x-h, maxX:x+h, minZ:z-h, maxZ:z+h }]
  return [
    {minX:x-h-t,maxX:x-h+t,minZ:z-h,maxZ:z+h},
    {minX:x+h-t,maxX:x+h+t,minZ:z-h,maxZ:z+h},
    {minX:x-h,maxX:x+h,minZ:z-h-t,maxZ:z-h+t},
    {minX:x-h,maxX:x-3,minZ:z+h-t,maxZ:z+h+t},
    {minX:x+3,maxX:x+h,minZ:z+h-t,maxZ:z+h+t},
    {minX:x-3.25,maxX:x-2.75,minZ:z+h-3,maxZ:z+h},
    {minX:x+2.75,maxX:x+3.25,minZ:z+h-3,maxZ:z+h},
    ...yardLayout(plot).sprites.filter((p)=>p.radius>0).map((p)=>({minX:p.x-p.radius,maxX:p.x+p.radius,minZ:p.z-p.radius,maxZ:p.z+p.radius}))
  ]
}
function navigation(cfg, plots, a, b, mode, homeId, allowed=[]) {
  const bounds = {minX:Math.max(0,Math.min(a.x,b.x)-30),maxX:Math.min(cfg.width,Math.max(a.x,b.x)+30),
    minZ:Math.max(0,Math.min(a.z,b.z)-30),maxZ:Math.min(cfg.height,Math.max(a.z,b.z)+30)}
  const yard = mode === 'roam' && plots.find((p)=>inside(a,p))
  if (yard) {
    const h=(yard.size||48)/2
    bounds.minX=Math.max(bounds.minX,yard.x-h)
    bounds.maxX=Math.min(bounds.maxX,yard.x+h)
    bounds.minZ=Math.max(bounds.minZ,yard.z-h)
    bounds.maxZ=Math.min(bounds.maxZ,yard.z+h)
  }
  const blocks=plots.flatMap((p)=>obstacles(p, mode==='roam' ? !yard || p._id!==yard._id : mode==='pet' ? p._id!==homeId : !allowed.includes(p._id)))
  return createNavigation(bounds,blocks,.8,1.5)
}
function safePoint(nav, preferred) {
  if(nav.walkable(preferred)) return {...preferred}
  for(let radius=1;radius<=200;radius++) for(let i=0;i<16;i++) {
    const a=i*Math.PI/8,p={x:preferred.x+Math.cos(a)*radius,z:preferred.z+Math.sin(a)*radius}
    if(nav.walkable(p)) return p
  }
  throw new Error('附近没有可用空地')
}
function motion(cfg, plots, start, epoch, seed, approach) {
  const nav=navigation(cfg,plots,start,start,'roam')
  start=safePoint(nav,start)
  let random=Number.parseInt(world.hash(seed).slice(0,8),16) || 1
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random/4294967296}
  const patrol=[start]
  let current=start
  for(let i=0;i<24 && patrol.length<9;i++) {
    const angle=next()*Math.PI*2,r=4+next()*16
    const target={x:start.x+Math.cos(angle)*r,z:start.z+Math.sin(angle)*r}
    if(nav.clearSegment(current,target) && nav.clearSegment(target,start)) {patrol.push(target);current=target}
  }
  patrol.push(start)
  return {epoch,approach:approach || [start],patrol,speed:7,roamSpeed:3,wait:3}
}
module.exports = function createShared(context) {
  const {db} = context, service=world.create(context)
  const live=require('../playground-live')(context),social=require('../playground-social')(context)
  const now=()=>context.nowMs ? context.nowMs() : Date.now()
  const read=async(database,id)=>{const row=await world.read(database,id);return row?{...row}:null}
  function publicRecord(row) {
    const ownerId=presenceId(row.ownerOpenid)
    if(row.kind==='plot') {const {mine,...plot}=service.publicPlot(row,'');return {kind:'plot',...plot,ownerId}}
    if(row.kind==='resident') return {kind:'resident',id:row._id,ownerId,name:row.name,ownerName:row.name,pets:row.pets||[]}
    return {kind:'presence',id:row._id,ownerId,name:row.name||'邻居',position:row.position,characterType:row.characterType==='girl'?'girl':'boy',
      mirrored:!!row.mirrored,online:!!row.online&&row.active!==false&&now()-row.lastSeen<15000,lastSeen:row.lastSeen,moving:!!row.moving&&now()-row.lastSeen<3000,running:!!row.running}
  }
  const version=(row)=>({epoch:row.kind==='presence'?row.sessionStarted||row.lastSeen:row.revision||Date.parse(row.updatedAt||row.createdAt)||0,seq:row.kind==='resident'?row.petSeq||0:row.seq||0})
  async function publish(row) {
    if(row.kind==='presence'&&row.active===false) return
    await live.publish(row.communityId,publicRecord(row),version(row))
  }
  function publicNavigation(cfg,plots,allowed) {
    return createNavigation({minX:0,minZ:0,maxX:cfg.width,maxZ:cfg.height},plots.flatMap((p)=>obstacles(p,!allowed.includes(p._id))),.8,1.5)
  }
  async function rows(communityId,kind) {
    const result=[]
    let cursor=''
    do {
      const where={communityId,kind}
      if(cursor) where._id=db.command.gt(cursor)
      const page=(await db.collection(COLLECTION).where(where).orderBy('_id','asc').limit(100).get()).data||[]
      result.push(...page)
      cursor=page.length===100?page[page.length-1]._id:''
    } while(cursor)
    return result
  }
  async function check(openid,data,database=db) {
    const actor=await read(database,presenceId(openid))
    if(!actor || actor.session!==data.session || actor.communityId!==data.sceneId) throw new Error('场景已切换，请重新进入')
    return actor
  }
  async function enter(openid,user,data,pets) {
    const community=data.community || user.residentialCommunity || null
    const id=world.communityId({residentialCommunity:community}) || 'solo_'+world.hash(openid)
    const cfg=await service.config()
    const plots=await rows(id,'plot')
    const stamp=now(), session=crypto.randomBytes(16).toString('hex')
    const actorEpoch=await live.nextEpoch(id,presenceId(openid),stamp)
    const residentEpoch=await live.nextEpoch(id,residentId(openid),stamp)
    const state=await transaction(db,async(tx)=>{
      const old=await read(tx,presenceId(openid))
      const resident=await read(tx,residentId(openid))
      const currentHome=await read(tx,world.ownerId(openid))
      const currentOwn=currentHome && currentHome.communityId===id ? currentHome : null
      const allowed=await social.access(openid,plots,tx)
      const preferred=currentOwn?{x:currentOwn.x+3,z:currentOwn.z+14}:{x:Math.floor(cfg.width/224)*112,z:Math.floor(cfg.height/224)*112}
      const spawnAllowed=currentOwn?[currentOwn.plotId]:[]
      const start=safePoint(publicNavigation(cfg,plots,spawnAllowed),preferred)
      const previous=old && old.communityId===id && (currentOwn || !plots.some((p)=>inside(old.position,p))) ? old.position : start
      const position=safePoint(publicNavigation(cfg,plots,allowed),previous)
      const actor={kind:'presence',communityId:id,ownerOpenid:openid,name:String(user.nickname||'邻居').slice(0,20),
        position,characterType:old && old.characterType==='girl'?'girl':'boy',mirrored:!!(old&&old.mirrored),
        session,seq:0,active:!!currentHome,homePlotId:currentHome?currentHome.plotId:'',online:true,lastSeen:stamp,sessionStarted:Math.max(actorEpoch,(old&&old.sessionStarted||0)+1)}
      const canKeepPets=!!currentOwn
      const plotKey=currentOwn?currentOwn.plotId:''
      let savedResident=null
      if(canKeepPets) {
        savedResident={kind:'resident',communityId:id,ownerOpenid:openid,plotId:plotKey,session,revision:Math.max(residentEpoch,(resident&&resident.revision||0)+1),petSeq:0,layoutKey:resident&&resident.layoutKey||layoutKey(plots),
          name:actor.name,pets:pets.map((p,i)=>{
            const previous=resident && resident.communityId===id && resident.plotId===plotKey && (resident.pets||[]).find((q)=>q.id===p._id)
            const origin={x:start.x+(i%3-1)*5,z:start.z+Math.floor(i/3)*4}
            return {id:p._id,name:p.name||'宠物',species:p.species==='cat'?'cat':'dog',modelScale:Math.max(.5,Math.min(2,Number(p.playgroundScale)||1)),
              motion:previous?previous.motion:motion(cfg,plots,origin,stamp,p._id)}
          })}
      }
      await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:actor})
      if(savedResident) await tx.collection(COLLECTION).doc(residentId(openid)).set({data:savedResident})
      else if(!currentHome && resident) await tx.collection(COLLECTION).doc(residentId(openid)).remove()
      return {...actor,home:currentHome,own:currentOwn,resident:savedResident,old,allowed}
    })
    if(state.old && state.old.communityId!==id) await live.publish(state.old.communityId,{id:presenceId(openid),kind:'presence',deleted:true})
    await publish({...state,_id:presenceId(openid)})
    if(state.resident) await publish({...state.resident,_id:residentId(openid)})
    const socialState=await social.state(openid)
    return {session,playerId:presenceId(openid),sceneId:id,realtimeCollection:'pet_playground_live',serverTime:now(),social:socialState,allowedPlotIds:state.allowed,position:state.position,characterType:state.characterType,hasAvatar:state.active,
      community,visiting:id!==(world.communityId(user)||'solo_'+world.hash(openid)),hasHomeElsewhere:!!state.home&&!state.own,
      homeCommunity:user.residentialCommunity||null,plot:state.own?service.publicPlot({...state.own,_id:state.own.plotId},openid):null}
  }
  async function sync(openid,data) {
    const [cfg,plots]=await Promise.all([service.config(),rows(data.sceneId,'plot')]), stamp=now()
    const result=await transaction(db,async(tx)=>{
      const actor=await check(openid,data,tx)
      const allowed=await social.access(openid,plots,tx)
      const nav=publicNavigation(cfg,plots,allowed)
      if(!Number.isInteger(data.seq) || data.seq<=actor.seq) return {serverTime:stamp,accepted:false}
      if(actor.active!==false && !nav.walkable(actor.position)) {
        actor.position=safePoint(nav,actor.position)
        actor.seq=data.seq;actor.lastSeen=stamp;actor.moving=false
        const {_id,...saved}=actor
        await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:saved})
        return {serverTime:stamp,accepted:true,position:actor.position,corrected:true,actor}
      }
      if(data.position && actor.active!==false) {
        const p=data.position
        if(![p.x,p.z].every((n)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('角色位置无效')
        const elapsed=Math.max(.2,Math.min(30,(stamp-actor.lastSeen)/1000))
        const trail=data.trail || []
        if(!Array.isArray(trail) || trail.length>1200) throw new Error('移动路径过长，请重新进入场景')
        let previous=actor.position,total=0
        for(const point of [...trail,p]) {
          if(!point || ![point.x,point.z].every((n)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('角色位置无效')
          total+=Math.hypot(point.x-previous.x,point.z-previous.z)
          if(total>elapsed*14+3) throw new Error('移动过远，请重新进入场景')
          if(!nav.clearSegment(previous,point)) throw new Error('不能穿过房屋或围栏，进入他人庭院需要好友或访问许可')
          previous=point
        }
        actor.position={x:p.x,z:p.z}
      }
      actor.characterType=data.characterType==='girl'?'girl':'boy'
      actor.mirrored=data.mirrored===true
      actor.online=data.online!==false
      actor.lastSeen=stamp
      actor.seq=data.seq
      actor.moving=actor.online && data.moving===true
      actor.running=actor.moving && data.running===true
      delete actor._id
      await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:actor})
      return {serverTime:stamp,accepted:true,actor:{...actor,_id:presenceId(openid)}}
    })
    if(result.actor) await publish(result.actor)
    const {actor,...response}=result
    return {...response,serverTime:now()}
  }
  async function snapshot(openid,data) {
    await check(openid,data)
    const cursor=String(data.cursor||'')
    if(cursor.length>128) throw new Error('无效场景页码')
    const plots=await rows(data.sceneId,'plot'), cfg=await service.config()
    if(!cursor) {
      // Existing residents need not log in after deployment for their pets to appear.
      const existing=await rows(data.sceneId,'resident')
      for(const plot of plots) if(!existing.some((r)=>r.ownerOpenid===plot.ownerOpenid&&r.plotId===plot._id)) {
        const pets=((await db.collection('pets').where({openid:plot.ownerOpenid}).orderBy('createdAt','desc').limit(100).get()).data||[])
          .filter((p)=>!p.deletedAt&&['cat','dog'].includes(p.species||'dog')).slice(0,8)
        await transaction(db,async(tx)=>{
          const owned=await read(tx,world.ownerId(plot.ownerOpenid)), old=await read(tx,residentId(plot.ownerOpenid))
          if(!owned || owned.communityId!==data.sceneId || owned.plotId!==plot._id || old&&old.communityId===data.sceneId&&old.plotId===plot._id) return
          const resident={kind:'resident',communityId:data.sceneId,ownerOpenid:plot.ownerOpenid,plotId:plot._id,revision:now(),
            name:plot.ownerName||String(plot.name||'邻居').replace(/的庭院$/,''),layoutKey:layoutKey(plots),pets:pets.map((p,i)=>({id:p._id,name:p.name||'宠物',species:p.species==='cat'?'cat':'dog',
              modelScale:Math.max(.5,Math.min(2,Number(p.playgroundScale)||1)),motion:motion(cfg,plots,{x:plot.x+(i%3-1)*5,z:plot.z+14+Math.floor(i/3)*4},now(),p._id)}))}
          await tx.collection(COLLECTION).doc(residentId(plot.ownerOpenid)).set({data:resident})
        })
      }
    }
    const where={communityId:data.sceneId,kind:db.command.in(['plot','presence','resident'])}
    if(cursor) where._id=db.command.gt(cursor)
    const page=(await db.collection(COLLECTION).where(where).orderBy('_id','asc').limit(100).get()).data||[]
    // Hide unplaced avatars written by older versions until their next entry.
    const legacyActors=new Set()
    for(const row of page) if(row.kind==='presence' && row.active===undefined && await read(db,world.ownerId(row.ownerOpenid))) legacyActors.add(row._id)
    const stamp=now()
    const geometry=layoutKey(plots)
    // A new/demolished yard invalidates old outdoor routes, even for offline owners.
    for(let i=0;i<page.length;i++) if(page[i].kind==='resident' && page[i].layoutKey!==geometry &&
      plots.some((p)=>p.ownerOpenid===page[i].ownerOpenid&&p._id===page[i].plotId)) {
      page[i]=await transaction(db,async(tx)=>{
        const row=await read(tx,page[i]._id)
        if(!row || row.communityId!==data.sceneId) return {...page[i],pets:[]}
        if(row.layoutKey===geometry) return row
        row.pets=(row.pets||[]).map((pet)=>{
          const current=sampleMotion(pet.motion,stamp).position
          const start=safePoint(navigation(cfg,plots,current,current,'pet',row.plotId),current)
          return {...pet,motion:motion(cfg,plots,start,stamp,pet.id+geometry)}
        })
        row.layoutKey=geometry
        row.revision=Math.max(stamp,(row.revision||0)+1)
        const key=row._id
        delete row._id
        await tx.collection(COLLECTION).doc(key).set({data:row})
        return {...row,_id:key}
      })
    }
    const visible=page.filter((row)=>{
      if(row.kind==='presence') return row.active===true || legacyActors.has(row._id)
      if(row.kind==='resident') return plots.some((p)=>p.ownerOpenid===row.ownerOpenid&&p._id===row.plotId)
      return true
    })
    for(const row of visible) await publish(row)
    return {serverTime:now(),allowedPlotIds:await social.access(openid,plots),nextCursor:page.length===100?page[page.length-1]._id:'',records:visible.map((row)=>({...publicRecord(row),version:version(row),mine:row.ownerOpenid===openid}))}
  }
  async function commandPet(openid,data) {
    const petRecord=((await db.collection('pets').where({_id:data.petId,openid}).get()).data||[])[0]
    if(!petRecord || petRecord.deletedAt) throw new Error('只能操作自己的宠物，宠物不存在或已删除')
    const cfg=await service.config(), stamp=now()
    const plots=await rows(data.sceneId,'plot')
    // High-frequency movement must not invalidate a pet-command transaction.
    // The resident session fences commands against concurrent scene re-entry.
    const actor=await check(openid,data)
    const result=await transaction(db,async(tx)=>{
      const resident=await read(tx,residentId(openid))
      if(!resident || resident.communityId!==actor.communityId) throw new Error('只能操作自己当前小区的宠物')
      if(resident.session && resident.session!==data.session) throw new Error('场景已切换，请重新进入')
      const pet=(resident.pets||[]).find((p)=>p.id===data.petId)
      if(!pet) throw new Error('只能操作自己的宠物')
      if(!Number.isInteger(data.commandSeq) || data.commandSeq<1) throw new Error('无效宠物操作序号')
      if(data.commandSeq<=(resident.petSeq||0)) throw new Error('宠物操作已更新，请使用最新指令')
      const current=sampleMotion(pet.motion,stamp).position
      let target=data.target
      if(data.interact===true) {
        if(pet.interactionUntil>stamp) throw new Error('宠物正在互动，请稍等一下')
        if(Math.hypot(actor.position.x-current.x,actor.position.z-current.z)>4 ||
          !navigation(cfg,plots,actor.position,current,'character',null,await social.access(openid,plots,tx)).clearSegment(actor.position,current)) throw new Error('请先走近自己的宠物')
        target=current
      }
      if(!target || ![target.x,target.z].every((n)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('请选择有效目的地')
      if(Math.hypot(target.x-current.x,target.z-current.z)>300) throw new Error('请先选择附近的草地')
      const nav=navigation(cfg,plots,current,target,'pet',resident.plotId)
      const route=nav.path(current,target)
      if(!route) throw new Error('这里无法到达，请从自家庭院院门进出')
      pet.motion=motion(cfg,plots,target,data.interact===true?stamp-500:stamp,pet.id+stamp,[current,...route])
      pet.interactionUntil=data.interact===true?stamp+2500:0
      pet.commandSeq=data.commandSeq
      resident.petSeq=data.commandSeq
      resident.revision=Math.max(stamp,(resident.revision||0)+1)
      delete resident._id
      await tx.collection(COLLECTION).doc(residentId(openid)).set({data:resident})
      return {serverTime:stamp,pet,resident}
    })
    await publish({...result.resident,_id:residentId(openid)})
    return {serverTime:now(),pet:result.pet}
  }
  async function petScale(openid,petId,scale) {
    await transaction(db,async(tx)=>{
      const resident=await read(tx,residentId(openid))
      if(!resident) return
      const pet=(resident.pets||[]).find((p)=>p.id===petId)
      if(!pet) return
      pet.modelScale=scale
      resident.revision=Math.max(now(),(resident.revision||0)+1)
      delete resident._id
      await tx.collection(COLLECTION).doc(residentId(openid)).set({data:resident})
    })
    const resident=await read(db,residentId(openid))
    if(resident) await publish(resident)
  }
  async function plotChanged(openid,plotId,deleted=false,sceneId) {
    if(deleted) {
      for(const [id,kind] of [[plotId,'plot'],[presenceId(openid),'presence'],[residentId(openid),'resident']]) await live.publish(sceneId,{id,kind,deleted:true})
    } else {const row=await read(db,plotId);if(row)await publish(row)}
  }
  return {enter,sync,snapshot,commandPet,petScale,plotChanged,social}
}
module.exports.navigation=navigation
module.exports.motion=motion
