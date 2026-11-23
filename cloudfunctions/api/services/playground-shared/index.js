const { transaction } = require('../playground-transaction')
const crypto = require('crypto')
const world = require('../playground-world')
const { validColor } = require('../playground-name-colors')
const { createNavigation } = require('./navigation')
const { yardLayout } = require('./yard-layout')
const { sampleMotion } = require('./shared-motion')
const { publicAppearance } = require('../playground-appearance-record')
const { publicUserTitle } = require('../userTitles')
const { settleNeeds, isWasteExpired } = require('./pet-needs')
const manor3dBuildings = require('./manor3d-buildings')
const COLLECTION = 'pet_playground_plots'
const MANOR3D_WIDTH = 1200
const MANOR3D_DEPTH = 960
const MANOR3D_SOURCE_WIDTH = 2240
const MANOR3D_SOURCE_DEPTH = 2240
const PLAYGROUND_CONFIG_CACHE_MS = 5000
const MANOR3D_PLOT_CACHE_MS = 5000
const RESIDENT_SWEEP_CACHE_MS = 30000
const MANOR3D_HEIGHT_LIMIT = 1200
const MANOR3D_ONLINE_TTL = 15000
const MANOR3D_MOVING_TTL = 3000
const MANOR3D_GUEST_PRESENCE = 'manor3dPresence'
const presenceId = (openid) => 'presence_' + world.hash(openid)
const residentId = (openid) => 'resident_' + world.hash(openid)
function projectManor3dPosition(position, config) {
  return {
    x: (position.x / config.width - .5) * MANOR3D_WIDTH,
    z: (position.z / config.height - .5) * MANOR3D_DEPTH
  }
}

function projectPlaygroundPosition(position, config) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return null
  return {
    x: (position.x / MANOR3D_WIDTH + .5) * config.width,
    z: (position.z / MANOR3D_DEPTH + .5) * config.height
  }
}

function projectManor3dPoint(point, config) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return point
  return {
    x: (point.x / (config?.width || MANOR3D_SOURCE_WIDTH) - .5) * MANOR3D_WIDTH,
    z: (point.z / (config?.height || MANOR3D_SOURCE_DEPTH) - .5) * MANOR3D_DEPTH
  }
}

function projectManor3dMotion(motion, config) {
  if (!motion || typeof motion !== 'object') return null
  const result = { ...motion }
  for (const key of ['origin', 'followCenter']) {
    if (motion[key]) result[key] = projectManor3dPoint(motion[key], config)
  }
  for (const key of ['approach', 'patrol']) {
    if (Array.isArray(motion[key])) result[key] = motion[key].map(point => projectManor3dPoint(point, config))
  }
  const speedFor=(key)=>{
    if(!Array.isArray(motion[key])||!Number.isFinite(motion[key==='approach'?'speed':'roamSpeed']))return
    const length=points=>points.slice(1).reduce((total,point,index)=>total+
      Math.hypot(point.x-points[index].x,point.z-points[index].z),0)
    const sourceLength=length(motion[key]),projectedLength=length(result[key])
    if(sourceLength>0)result[key==='approach'?'speed':'roamSpeed']=motion[key==='approach'?'speed':'roamSpeed']*projectedLength/sourceLength
  }
  speedFor('approach')
  speedFor('patrol')
  return result
}

function commandManor3dPosition(data, config) {
  if (!data || data.manor3dPosition == null) return null
  if (!validManor3dPosition(data.manor3dPosition)) throw new Error('宠物 3D 位置无效')
  const point = projectPlaygroundPosition(data.manor3dPosition, config)
  if (!point || point.x < 0 || point.x > config.width || point.z < 0 || point.z > config.height) {
    throw new Error('宠物 3D 位置超出庄园范围')
  }
  return point
}

function validManor3dPosition(position) {
  return !!position && typeof position === 'object' &&
    Number.isFinite(position.x) && Number.isFinite(position.z) &&
    (position.y === undefined || Number.isFinite(position.y) && Math.abs(position.y) <= MANOR3D_HEIGHT_LIMIT) &&
    Math.abs(position.x) <= MANOR3D_WIDTH / 2 && Math.abs(position.z) <= MANOR3D_DEPTH / 2
}
function manor3dPosition({x,y,z}) {
  return y === undefined ? {x,z} : {x,y,z}
}
function manor3dInterior(interior) {
  if(interior == null) return null
  if(interior.kind==='red') return {kind:'red'}
  if(interior.kind==='courtyard'&&typeof interior.plotId==='string'&&/^M\d{3}$/.test(interior.plotId)) {
    return {kind:'courtyard',plotId:interior.plotId}
  }
  if(interior.kind==='tower'&&typeof interior.plotId==='string'&&/^tower-(west|walk|east|south-east|south|south-west)$/.test(interior.plotId)) {
    return {kind:'tower',plotId:interior.plotId}
  }
  throw new Error('3D角色室内区域无效')
}
function validManor3dFacing(facing) {
  return ['nw', 'ne', 'sw', 'se'].includes(facing) ||
    Number.isFinite(facing) && Math.abs(facing) <= Math.PI * 2
}
function canPublishManor3d(row) {
  return row.manor3dSession === true || row.active === true
}

function manor3dOnline(row, stamp) {
  return row.manor3d === true && canPublishManor3d(row) && row.manor3dOnline !== false &&
    stamp - Number(row.manor3dLastSeen || 0) < MANOR3D_ONLINE_TTL
}
const { buildingGeometryKey } = require('./plot-buildings')
const layoutKey = (plots) => world.hash('garage-v2'+JSON.stringify(plots.map((p)=>[p._id,p.gateDirection,p.buildingType,buildingGeometryKey(p)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))))
const inside = (p, plot) => Math.abs(p.x - plot.x) < (plot.size || 48) / 2 && Math.abs(p.z - plot.z) < (plot.size || 48) / 2
function obstacles(plot, solid = false) {
  const h = (plot.size || 48) / 2, x = plot.x, z = plot.z, t = .65
  if (solid) return [{ minX:x-h, maxX:x+h, minZ:z-h, maxZ:z+h }]
  const dir = plot.gateDirection || 'south'
  const fences = []

  if (dir === 'north') {
    fences.push({ minX: x - h, maxX: x - 3, minZ: z - h - t, maxZ: z - h + t })
    fences.push({ minX: x + 3, maxX: x + h, minZ: z - h - t, maxZ: z - h + t })
    fences.push({ minX: x - 3.25, maxX: x - 2.75, minZ: z - h, maxZ: z - h + 3 })
    fences.push({ minX: x + 2.75, maxX: x + 3.25, minZ: z - h, maxZ: z - h + 3 })
  } else {
    fences.push({ minX: x - h, maxX: x + h, minZ: z - h - t, maxZ: z - h + t })
  }

  if (dir === 'south') {
    fences.push({ minX: x - h, maxX: x - 3, minZ: z + h - t, maxZ: z + h + t })
    fences.push({ minX: x + 3, maxX: x + h, minZ: z + h - t, maxZ: z + h + t })
    fences.push({ minX: x - 3.25, maxX: x - 2.75, minZ: z + h - 3, maxZ: z + h })
    fences.push({ minX: x + 2.75, maxX: x + 3.25, minZ: z + h - 3, maxZ: z + h })
  } else {
    fences.push({ minX: x - h, maxX: x + h, minZ: z + h - t, maxZ: z + h + t })
  }

  if (dir === 'west') {
    fences.push({ minX: x - h - t, maxX: x - h + t, minZ: z - h, maxZ: z - 3 })
    fences.push({ minX: x - h - t, maxX: x - h + t, minZ: z + 3, maxZ: z + h })
    fences.push({ minX: x - h, maxX: x - h + 3, minZ: z - 3.25, maxZ: z - 2.75 })
    fences.push({ minX: x - h, maxX: x - h + 3, minZ: z + 2.75, maxZ: z + 3.25 })
  } else {
    fences.push({ minX: x - h - t, maxX: x - h + t, minZ: z - h, maxZ: z + h })
  }

  if (dir === 'east') {
    fences.push({ minX: x + h - t, maxX: x + h + t, minZ: z - h, maxZ: z - 3 })
    fences.push({ minX: x + h - t, maxX: x + h + t, minZ: z + 3, maxZ: z + h })
    fences.push({ minX: x + h - 3, maxX: x + h, minZ: z - 3.25, maxZ: z - 2.75 })
    fences.push({ minX: x + h - 3, maxX: x + h, minZ: z + 2.75, maxZ: z + 3.25 })
  } else {
    fences.push({ minX: x + h - t, maxX: x + h + t, minZ: z - h, maxZ: z + h })
  }

  return [
    ...fences,
    ...yardLayout(plot).sprites.filter((p)=>p.radius>0).map((p)=>({minX:p.x-p.radius,maxX:p.x+p.radius,minZ:p.z-p.radius,maxZ:p.z+p.radius}))
  ]
}
function navigation(cfg, plots, a, b, mode, homeId, allowed=[]) {
  const margin=mode==='companion'?120:30
  const bounds = {minX:Math.max(0,Math.min(a.x,b.x)-margin),maxX:Math.min(cfg.width,Math.max(a.x,b.x)+margin),
    minZ:Math.max(0,Math.min(a.z,b.z)-margin),maxZ:Math.min(cfg.height,Math.max(a.z,b.z)+margin)}
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
  let playgroundConfigPromise,playgroundConfigAt=0,playgroundConfigValue=null,playgroundCareRulesPromise,playgroundCareRulesAt=0
  const manor3dPlotCache=new Map(),residentSweepCache=new Map()
  const readPlaygroundConfig=()=>{
    if(playgroundConfigPromise&&now()-playgroundConfigAt<PLAYGROUND_CONFIG_CACHE_MS)return playgroundConfigPromise
    const pending=service.config().then(config=>{
      playgroundConfigValue=config
      return config
    })
    playgroundConfigPromise=pending
    playgroundConfigAt=now()
    return pending.catch(error=>{
      if(playgroundConfigPromise===pending){playgroundConfigPromise=null;playgroundConfigAt=0}
      throw error
    })
  }
  const readPlaygroundCareRules=()=>{
    if(playgroundCareRulesPromise&&now()-playgroundCareRulesAt<PLAYGROUND_CONFIG_CACHE_MS)return playgroundCareRulesPromise
    const pending=require('../playground-config').readConfig(db).then(result=>result.care)
    playgroundCareRulesPromise=pending
    playgroundCareRulesAt=now()
    return pending.catch(error=>{
      if(playgroundCareRulesPromise===pending){playgroundCareRulesPromise=null;playgroundCareRulesAt=0}
      throw error
    })
  }
  const readManor3dPlots=async(communityId)=>{
    const cached=manor3dPlotCache.get(communityId)
    if(cached&&now()-cached.at<MANOR3D_PLOT_CACHE_MS)return cached.rows
    const result=await rows(communityId,'plot')
    manor3dPlotCache.set(communityId,{at:now(),rows:result})
    if(manor3dPlotCache.size>24)manor3dPlotCache.delete(manor3dPlotCache.keys().next().value)
    return result
  }
  const read=async(database,id)=>{const row=await world.read(database,id);return row?{...row}:null}
  function publicRecord(row) {
    if(row.kind===manor3dBuildings.KIND) return manor3dBuildings.publicBuilding(row)
    const ownerId=presenceId(row.ownerOpenid)
    if(row.kind==='manor3dVehicle') return {kind:'manor3dVehicle',id:row._id,ownerId,communityId:row.communityId,
      buildingId:row.buildingId,position3d:row.position3d,yaw:row.yaw,moving:!!row.moving,online:!!row.online,
      lastSeen:row.lastSeen||0,seq:row.seq||0}
    if(row.kind==='plot') {const {mine,...plot}=service.publicPlot(row,'');return {kind:'plot',...plot,ownerId}}
    if(row.kind==='resident') {
      const stamp = now()
      return {
        kind:'resident',id:row._id,ownerId,name:row.name,nameColor:row.nameColor||'',ownerName:row.name,careAgent:row.careAgent||null,careAgents:row.careAgents||(row.careAgent?[row.careAgent]:[]),
        pets:(row.pets||[]).map((pet)=>({
          ...pet,
          waste:(pet.waste||[]).filter((w)=>!isWasteExpired(w, stamp)),
          manor3dMotion:pet.manor3dMotion||projectManor3dMotion(pet.motion,playgroundConfigValue),
          lifeManaged:true,
          appearance:publicAppearance(pet.appearance,'pet',pet.id,row.ownerOpenid)
        }))
      }
    }
    if(row.kind==='vehicle') {
      const stamp = now()
      const stains = (row.stains||[]).filter((s)=>!isWasteExpired(s, stamp))
      return {kind:'vehicle',id:row._id,ownerId,name:row.name,nameColor:row.nameColor||'',plotId:row.plotId,state:row.state,position:row.position,
        facing:row.facing||'sw',passengers:(row.passengers||[]).map((p)=>({id:p.id,name:p.name})),capacity:3,
        stains,soiled:!!row.soiled && stains.length > 0,
        mirrored:!!row.mirrored,moving:!!row.moving&&now()-row.lastSeen<3000,online:!!row.online&&now()-row.lastSeen<15000,lastSeen:row.lastSeen,speedMultiplier:row.speedMultiplier}
    }
    const stamp = now()
    const manor3dFresh = manor3dOnline(row, stamp)
    const manor3dMoving = manor3dFresh && row.manor3dMoving === true &&
      stamp - Number(row.manor3dLastSeen || 0) < MANOR3D_MOVING_TTL
    return {kind:'presence',id:row._id,ownerId,name:row.name||'邻居',nameColor:row.nameColor||'',userTitle:row.userTitle||null,position:row.position,
      position3d:row.position3d||null,manor3d:row.manor3d===true,manor3dOnline:manor3dFresh,
      manor3dLastSeen:row.manor3dLastSeen||0,manor3dInterior:row.manor3dInterior||null,
      manor3dCharacterType:row.manor3dCharacterType||null,
      manor3dPose:row.manor3dPose||null,
      manor3dMoving,manor3dRunning:manor3dMoving&&row.manor3dRunning===true,manor3dFacing:row.manor3dFacing??null,
      characterType:row.characterType==='girl'?'girl':'boy',
      vehicleId:row.vehicleId||'',
      vehicleRole:row.vehicleRole||'',facing:row.facing||'sw',
      appearance:publicAppearance(row.appearance,'character',row._id,row.ownerOpenid),
      mirrored:!!row.mirrored,online:!!row.online&&row.active!==false&&now()-row.lastSeen<15000,lastSeen:row.lastSeen,moving:!!row.moving&&now()-row.lastSeen<3000,running:!!row.running}
  }
  const version=(row)=>({epoch:row.kind==='presence'?row.sessionStarted||row.lastSeen:row.revision||Date.parse(row.updatedAt||row.createdAt)||0,
    seq:row.kind==='resident'?row.petSeq||0:row.kind==='presence'?(row.seq||0)+(row.manor3dSeq||0):row.seq||0})
  function publishManor3d(row, options) {
    const record = publicRecord(row)
    if (row.active !== true) record.kind = MANOR3D_GUEST_PRESENCE
    return live.publish(row.communityId, record, version(row), options)
  }
  async function ensureRecordNameColor(row) {
    if(row.kind==='plot' || row.kind===manor3dBuildings.KIND || validColor(row.nameColor)) return row
    const home=await service.own(row.ownerOpenid)
    if(!home) return row
    return transaction(db,async(tx)=>{
      const current=await read(tx,row._id),owned=await read(tx,world.ownerId(row.ownerOpenid))
      if(!current || current.communityId!==row.communityId) return null
      if(validColor(current.nameColor) || !owned) return current
      // Bump the projection version so existing watchers receive legacy colors.
      const patch={nameColor:owned.nameColor,[current.kind==='presence'?'sessionStarted':'revision']:Math.max(now(),version(current).epoch+1)}
      await tx.collection(COLLECTION).doc(current._id).update({data:patch})
      return {...current,...patch}
    })
  }
  async function publish(row) {
    row=await ensureRecordNameColor(row)
    if(!row || row.kind==='presence'&&row.active===false) return row
    await live.publish(row.communityId,publicRecord(row),version(row))
    return row
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
    return kind === 'plot' ? service.ensureNameColors(result.filter((p)=>!p.demolished)) : result
  }
  async function ownedManor3dHomes(openid) {
    const result=[]
    let cursor=''
    do {
      const query={kind:manor3dBuildings.KIND,ownerOpenid:openid,...(cursor?{_id:db.command.gt(cursor)}:{})}
      const page=(await db.collection(COLLECTION).where(query).orderBy('_id','asc').limit(100).get()).data||[]
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
  async function currentPets(tx,pets,openid) {
    const result=[]
    // CloudBase rejects overlapping requests on the same transaction.
    for(const pet of pets) {
      const current=await world.readDocument(tx,'pets',pet._id,'读取宠物形象',true)
      if(current&&!current.deletedAt&&current.openid===openid&&['cat','dog'].includes(current.species||'dog'))result.push(current)
    }
    return result
  }
  async function ensureResidentRecords(sceneId,plots,cfg,manor3dHomes=[]) {
    const cached=residentSweepCache.get(sceneId)
    if(cached&&now()-cached.at<RESIDENT_SWEEP_CACHE_MS)return cached.promise
    const pending=(async()=>{
      const existing=await rows(sceneId,'resident')
      const homes=plots.filter(item=>!item.isNewPlot).map(plot=>({ownerOpenid:plot.ownerOpenid,plotId:plot._id,plot,manor3dOnly:false}))
      const residentOwners=new Set(homes.map(home=>home.ownerOpenid))
      for(const villa of manor3dHomes.filter(item=>item.buildingId==='red_tile_villa'&&!residentOwners.has(item.ownerOpenid))) {
        residentOwners.add(villa.ownerOpenid)
        homes.push({ownerOpenid:villa.ownerOpenid,plotId:'',villa,manor3dOnly:true})
      }
      for(const home of homes) if(!existing.some(row=>row.ownerOpenid===home.ownerOpenid&&row.communityId===sceneId&&
        (home.manor3dOnly?row.manor3dOnly===true:row.plotId===home.plotId))) {
        const pets=((await db.collection('pets').where({openid:home.ownerOpenid}).orderBy('createdAt','desc').limit(100).get()).data||[])
          .filter(pet=>!pet.deletedAt&&['cat','dog'].includes(pet.species||'dog')).slice(0,8)
        const homePosition=home.manor3dOnly?projectPlaygroundPosition(home.villa,cfg):null
        await transaction(db,async(tx)=>{
          const owned=await read(tx,world.ownerId(home.ownerOpenid)),old=await read(tx,residentId(home.ownerOpenid))
          if(home.manor3dOnly) {
            const villa=await read(tx,home.villa._id)
            if(!villa||villa.communityId!==sceneId||villa.ownerOpenid!==home.ownerOpenid||villa.buildingId!=='red_tile_villa'||
              old&&old.communityId===sceneId)return
          } else if(!owned||owned.communityId!==sceneId||owned.plotId!==home.plotId||old&&old.communityId===sceneId&&old.plotId===home.plotId)return
          const petsNow=await currentPets(tx,pets,home.ownerOpenid)
          const origin=home.manor3dOnly?homePosition:{x:home.plot.x,z:home.plot.z}
          const resident={kind:'resident',communityId:sceneId,ownerOpenid:home.ownerOpenid,plotId:home.plotId,
            ...(home.manor3dOnly?{manor3dOnly:true,manor3dPlotId:home.villa.plotId,homePosition}:{}),revision:now(),
            name:home.plot?.ownerName||String(home.plot?.name||'邻居').replace(/的庭院$/,''),nameColor:owned?.nameColor||'',layoutKey:layoutKey(plots),
            pets:petsNow.map((pet,index)=>({
              id:pet._id,name:pet.name||'宠物',species:pet.species==='cat'?'cat':'dog',
              appearance:publicAppearance(pet.playgroundAppearance,'pet',pet._id,home.ownerOpenid),
              needs:{at:now(),energy:100,satiety:100,hydration:100},
              modelScale:Math.max(.5,Math.min(2,Number(pet.playgroundScale)||1)),
              motion:home.manor3dOnly
                ? {epoch:now(),approach:[origin],patrol:[origin],speed:7,roamSpeed:3,wait:3}
                : motion(cfg,plots,{x:origin.x+(index%3-1)*5,z:origin.z+14+Math.floor(index/3)*4},now(),pet._id)
            }))}
          await tx.collection(COLLECTION).doc(residentId(home.ownerOpenid)).set({data:resident})
        })
      }
    })()
    residentSweepCache.set(sceneId,{at:now(),promise:pending})
    try {
      await pending
      residentSweepCache.set(sceneId,{at:now(),promise:Promise.resolve()})
    } catch(error) {
      if(residentSweepCache.get(sceneId)?.promise===pending)residentSweepCache.delete(sceneId)
      throw error
    }
  }
  async function advanceResidentRows(page,sceneId,plots,cfg,careService,careRules,throttleMs=0,manor3dHomes=[]) {
    const stamp=now(),geometry=layoutKey(plots)
    for(let i=0;i<page.length;i++) if(page[i].kind==='resident'&&(
      plots.some(plot=>plot.ownerOpenid===page[i].ownerOpenid&&plot._id===page[i].plotId)||
      page[i].manor3dOnly&&manor3dHomes.some(home=>home.ownerOpenid===page[i].ownerOpenid&&home.buildingId==='red_tile_villa'))) {
      if(throttleMs&&stamp-Number(page[i].manor3dLifeAdvancedAt||0)<throttleMs)continue
      const serviceOrders=page[i].manor3dOnly?[]:await careService.activeOrders(page[i].ownerOpenid)
      page[i]=await transaction(db,async(tx)=>{
        const row=await read(tx,page[i]._id)
        if(!row||row.communityId!==sceneId)return {...page[i],pets:[]}
        if(throttleMs&&stamp-Number(row.manor3dLifeAdvancedAt||0)<throttleMs)return row
        const layoutMismatch=!row.manor3dOnly&&row.layoutKey!==geometry
        row.pets=(row.pets||[]).map((pet)=>{
          if(pet.ridingVehicleId)return pet
          if(layoutMismatch) {
            const current=sampleMotion(pet.motion,stamp).position
            const start=safePoint(navigation(cfg,plots,current,current,'pet',row.plotId),current)
            settleNeeds(pet,stamp)
            return {...pet,care:null,motion:motion(cfg,plots,start,stamp,pet.id+geometry)}
          }
          return pet
        })
        let rulesChanged=false
        for(const pet of row.pets||[]) {
          const rules=careRules[pet.species==='cat'?'cat':'dog']
          if(JSON.stringify(pet.needsRules)!==JSON.stringify(rules)) {
            settleNeeds(pet,stamp);pet.needsRules=rules;rulesChanged=true
          }
        }
        const serviceChanged=row.manor3dOnly?false:await careService.advance(tx,row,cfg,plots,hooks,serviceOrders)
        const lifeChanged=await companions.advance(tx,row,cfg,plots)
        if(!layoutMismatch&&!lifeChanged&&!serviceChanged&&!rulesChanged&&!throttleMs)return row
        if(layoutMismatch)row.layoutKey=geometry
        if(throttleMs)row.manor3dLifeAdvancedAt=stamp
        row.revision=Math.max(stamp,(row.revision||0)+1)
        const id=row._id
        delete row._id
        await tx.collection(COLLECTION).doc(id).set({data:row})
        return {...row,_id:id}
      })
      if(!page[i].manor3dOnly&&(page[i].pets.some((pet)=>pet.care&&pet.care.type==='eat')||(page[i].careAgents||[]).some((agent)=>agent.phase==='caring'))) {
        const latest=await read(db,page[i].plotId),plotIndex=page.findIndex((row)=>row._id===page[i].plotId)
        if(latest) {
          if(plotIndex>=0)page[plotIndex]=latest
          await publish(latest)
        }
      }
    }
    return page
  }
  const hooks={read,check,publish,rows,safePoint,publicNavigation,navigation,motion,commandManor3dPosition,
    publicRecord:(row)=>({...publicRecord(row),version:version(row)}),
    config:()=>readPlaygroundConfig(),access:(...args)=>social.access(...args),social}
  const manor3dVehicles=require('./manor3d-vehicles')(context,{check,publish,publicRecord:hooks.publicRecord})
  const placeManor3dBuildingBase=manor3dBuildings.create(context,{check,publish,project:hooks.publicRecord})
  async function placeManor3dBuilding(openid,user,data) {
    const result=await placeManor3dBuildingBase(openid,user,data)
    if(result.record?.buildingId==='red_tile_villa') {
      const villa=await read(db,result.record.id)
      const vehicle=await manor3dVehicles.ensureForVilla(openid,villa)
      return {...result,vehicle:vehicle?hooks.publicRecord(vehicle):null}
    }
    return result
  }
  const companions=require('./companions')(context,hooks)
  const farm=require('./farm')(context,hooks)
  const rides=require('./rides')(context,{...hooks,companions})
  const vehicles=require('./vehicles')(context,{...hooks,companions,rides,
    publicRecord:(row)=>({...publicRecord(row),version:version(row)}),
    config:()=>readPlaygroundConfig(),access:(...args)=>social.access(...args),nextEpoch:(...args)=>live.nextEpoch(...args),
    response:({actor,car,records=[]})=>({actor:{...publicRecord(actor),version:version(actor)},vehicle:{...publicRecord(car),version:version(car)},records:records.filter(Boolean).map((r)=>({...publicRecord(r),version:version(r)})),serverTime:now()})})
  async function enter(openid,user,data,pets) {
    const communities=require('../playground-communities')(context)
    const choice=data.solo === true ? null : data.community || user.residentialCommunity || null
    const {community}=await communities.entry(choice,user)
    const id=world.communityId({residentialCommunity:community}) || 'solo_'+world.hash(openid)
    const manor3dSession=data.manor3d===true
    await rides.prepareEntry(openid,id)
    await service.own(openid)
    await vehicles.ensure(openid)
    const cfg=await readPlaygroundConfig()
    const plots=await rows(id,'plot')
    const ownedManor3d=manor3dSession?await ownedManor3dHomes(openid):[]
    const hasAnyManor3dHome=ownedManor3d.some(row=>!!row.communityId&&!String(row.communityId).startsWith('solo_'))
    const ownedVilla=manor3dSession&&ownedManor3d.find(row=>row.communityId===id&&row.buildingId==='red_tile_villa')
    const manor3dVehicle=ownedVilla?await manor3dVehicles.ensureForVilla(openid,ownedVilla):null
    const stamp=now(), session=crypto.randomBytes(16).toString('hex')
    const actorEpoch=await live.nextEpoch(id,presenceId(openid),stamp)
    const residentEpoch=await live.nextEpoch(id,residentId(openid),stamp)
    const state=await transaction(db,async(tx)=>{
      const currentUser=(await tx.collection('users').doc(user._id).get()).data||user
      const currentEntry=data.solo === true
        ? { community: null, retired: false }
        : await communities.entry(data.community || currentUser.residentialCommunity || null,currentUser,tx)
      if((world.communityId({residentialCommunity:currentEntry.community})||'solo_'+world.hash(openid))!==id) throw new Error('小区资料已更新，请重新进入')
      const old=await read(tx,presenceId(openid))
      const resident=await read(tx,residentId(openid))
      const currentHome=await service.ownInTransaction(tx,openid)
      const currentOwn=currentHome && currentHome.communityId===id ? currentHome : null
      const allowed=await social.access(openid,plots,tx)
      const preferred=currentOwn?{x:currentOwn.x+3,z:currentOwn.z+14}:{x:Math.floor(cfg.width/224)*112,z:Math.floor(cfg.height/224)*112}
      const spawnAllowed=currentOwn?[currentOwn.plotId]:[]
      const start=safePoint(publicNavigation(cfg,plots,spawnAllowed),preferred)
      const previous=old && old.communityId===id && (currentOwn || !plots.some((p)=>inside(old.position,p))) ? old.position : start
      const position=safePoint(publicNavigation(cfg,plots,allowed),previous)
      const saved3d=old?.communityId===id && (old.manor3dSaved===true || old.manor3d===true) &&
        validManor3dPosition(old.position3d)
      const actor={kind:'presence',communityId:id,ownerOpenid:openid,name:String(user.nickname||'邻居').slice(0,20),
        manor3dCommunity:currentEntry.community,manor3dCommunityRetired:currentEntry.retired===true,
        userTitle:publicUserTitle(currentUser,id),
        nameColor:currentHome&&currentHome.nameColor||'',
        appearance:publicAppearance(currentUser.playgroundAppearance,'character',presenceId(openid),openid),
        position3d:saved3d?manor3dPosition(old.position3d):projectManor3dPosition(position,cfg),
        manor3dSession,manor3dSaved:saved3d,manor3d:false,manor3dSeq:0,manor3dLastSeen:stamp,
        manor3dInterior:saved3d?old.manor3dInterior||null:null,
        manor3dCharacterType:saved3d?old.manor3dCharacterType||null:null,
        manor3dMoving:false,manor3dRunning:false,manor3dFacing:saved3d?old.manor3dFacing??null:null,manor3dOnline:false,
        position,characterType:old && old.characterType==='girl'?'girl':'boy',mirrored:!!(old&&old.mirrored),facing:old&&old.facing||'sw',
        session,seq:0,active:!!currentHome,homePlotId:currentHome?currentHome.plotId:'',online:true,lastSeen:stamp,sessionStarted:Math.max(actorEpoch,(old&&old.sessionStarted||0)+1)}
      const residentVilla=!currentOwn&&manor3dSession&&ownedVilla?await read(tx,ownedVilla._id):null
      const manor3dOnly=!currentOwn&&!!residentVilla&&residentVilla.communityId===id&&residentVilla.ownerOpenid===openid
      const canKeepPets=!!currentOwn||manor3dOnly
      const plotKey=currentOwn?currentOwn.plotId:''
      const homePosition=manor3dOnly?projectPlaygroundPosition(residentVilla,cfg):null
      let savedResident=null
      if(canKeepPets) {
        const petsNow=await currentPets(tx,pets,openid)
        savedResident={kind:'resident',communityId:id,ownerOpenid:openid,plotId:plotKey,session,revision:Math.max(residentEpoch,(resident&&resident.revision||0)+1),petSeq:0,layoutKey:resident&&resident.layoutKey||layoutKey(plots),
          ...(manor3dOnly?{manor3dOnly:true,manor3dPlotId:residentVilla.plotId,homePosition}:{}),
          serviceCare:resident&&resident.communityId===id&&resident.plotId===plotKey?resident.serviceCare||null:null,
          serviceCares:resident&&resident.communityId===id&&resident.plotId===plotKey?resident.serviceCares||(resident.serviceCare?[resident.serviceCare]:[]):[],
          careAgent:resident&&resident.communityId===id&&resident.plotId===plotKey?resident.careAgent||null:null,
          careAgents:resident&&resident.communityId===id&&resident.plotId===plotKey?resident.careAgents||(resident.careAgent?[resident.careAgent]:[]):[],
          name:actor.name,nameColor:actor.nameColor,pets:petsNow.map((p,i)=>{
            const previous=resident && resident.communityId===id && resident.plotId===plotKey && (resident.pets||[]).find((q)=>q.id===p._id)
            const origin=manor3dOnly?homePosition:{x:start.x+(i%3-1)*5,z:start.z+Math.floor(i/3)*4}
            return {...previous,id:p._id,name:p.name||'宠物',species:p.species==='cat'?'cat':'dog',modelScale:Math.max(.5,Math.min(2,Number(p.playgroundScale)||1)),
              needs:previous&&previous.needs||{at:stamp,energy:100,satiety:100,hydration:100},
              appearance:publicAppearance(p.playgroundAppearance,'pet',p._id,openid),motion:previous?previous.motion:manor3dOnly
                ? {epoch:stamp,approach:[origin],patrol:[origin],speed:7,roamSpeed:3,wait:3}
                : motion(cfg,plots,origin,stamp,p._id)}
          })}
      }
      const vehicle=await vehicles.onEnter(tx,openid,id,actor,currentHome,cfg,plots)
      actor.hasFollowers=!!savedResident&&savedResident.pets.some((p)=>p.following)
      await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:actor})
      if(savedResident) await tx.collection(COLLECTION).doc(residentId(openid)).set({data:savedResident})
      else if(!currentHome && resident) await tx.collection(COLLECTION).doc(residentId(openid)).remove()
      return {...actor,home:currentHome,own:currentOwn,resident:savedResident,old,allowed,vehicle,entry:currentEntry,
        canBuildManor3d:manor3dBuildings.canBuild(openid,{
          communityId:id,manor3dCommunityRetired:currentEntry.retired===true,manor3dSession
        },id)}
    })
    if(state.old && state.old.communityId!==id) await live.publish(state.old.communityId,{id:presenceId(openid),kind:'presence',deleted:true})
    if(state.active) await publish({...state,_id:presenceId(openid)})
    else if(state.old?.communityId===id && state.old.manor3d===true) {
      await publishManor3d({...state,_id:presenceId(openid)},{knownShard:true})
    }
    if(state.resident) await publish({...state.resident,_id:residentId(openid)})
    if(state.vehicle)await publish(state.vehicle)
    const socialState=await social.state(openid)
    return {session,playerId:presenceId(openid),name:state.name,nameColor:state.nameColor,userTitle:state.userTitle,sceneId:id,realtimeCollection:'pet_playground_live',serverTime:now(),social:socialState,allowedPlotIds:state.allowed,position:state.position,characterType:state.characterType,appearance:state.appearance,hasAvatar:state.active,
      vehicleId:state.vehicleId||'',vehicleRole:state.vehicleRole||'',facing:state.facing||'sw',mirrored:!!state.mirrored,vehicleSpeed:Math.max(2,Math.min(5,Number(user.playgroundVehicleSpeed)||2)),
      community:state.entry.community,communityRetired:state.entry.retired,visiting:id!==(world.communityId(user)||'solo_'+world.hash(openid)),hasHomeElsewhere:!!state.home&&!state.own,
      homeCommunity:user.residentialCommunity||null,plot:state.own?service.publicPlot({...state.own,_id:state.own.plotId},openid):null,
      position3d:manor3dSession&&!state.manor3dSaved?null:state.position3d,
      manor3dCanPublish:canPublishManor3d(state),manor3dInterior:state.manor3dInterior,manor3dFacing:state.manor3dFacing,
      canBuildManor3d:state.canBuildManor3d,
      hasAnyManor3dHome,manor3dVehicle:manor3dVehicle?hooks.publicRecord(manor3dVehicle):null}
  }
  async function syncManor3d(openid,data) {
    if(!Number.isSafeInteger(data.seq)||data.seq<1) throw new Error('3D角色同步序号无效')
    if(data.online!==undefined&&typeof data.online!=='boolean') throw new Error('3D角色在线状态无效')
    const online=data.online!==false
    const currentActor=await check(openid,data)
    const companionsDue=(currentActor.active===true||currentActor.manor3dSession===true)&&!currentActor.vehicleId&&
      now()-Number(currentActor.lastCompanionSync||0)>=600
    const [cfg,plots]=await Promise.all([
      readPlaygroundConfig(),
      companionsDue?readManor3dPlots(currentActor.communityId):Promise.resolve([])
    ])
    const result=await transaction(db,async(tx)=>{
      const actor=await check(openid,data,tx)
      const stamp=now()
      if(!canPublishManor3d(actor)) throw new Error('场景已切换，请重新进入')
      if(!validManor3dPosition(actor.position3d)) throw new Error('3D场景位置尚未初始化，请重新进入场景')
      if(data.pose!==undefined&&data.pose!==null&&data.pose!=='sit'&&data.pose!=='lie') throw new Error('3D角色姿势无效')
      const current=manor3dPosition(actor.position3d)
      const ackSeq=Number(actor.manor3dSeq||0)
      if(data.seq<=ackSeq) return {
        accepted:false,ackSeq,position3d:current,actor:data.seq===ackSeq?actor:null,
        manor3dOnline:manor3dOnline(actor, stamp)
      }
      let next=current
      const patch={manor3d:true,manor3dOnline:online,manor3dLastSeen:stamp,manor3dSeq:data.seq,
        manor3dMoving:online&&data.moving===true,manor3dRunning:online&&data.moving===true&&data.running===true,
        manor3dPose:online?(data.pose==='sit'||data.pose==='lie'?data.pose:null):actor.manor3dPose||null}
      if(online || data.position3d!==undefined) {
        if(!validManor3dPosition(data.position3d)) throw new Error('3D角色位置超出庄园范围或格式无效')
        if(online&&(typeof data.moving!=='boolean'||typeof data.running!=='boolean')) throw new Error('3D角色移动状态无效')
        if(online||data.facing!==undefined) {
          if(!validManor3dFacing(data.facing)) throw new Error('3D角色朝向无效')
          patch.manor3dFacing=data.facing
        }
        if(data.characterType==='boy'||data.characterType==='girl') patch.manor3dCharacterType=data.characterType
        next=manor3dPosition(data.position3d)
        patch.position3d=next
        patch.manor3dSaved=true
        patch.manor3dInterior=manor3dInterior(data.interior)
        if(!patch.manor3dInterior) {
          const projected=projectPlaygroundPosition(next,cfg)
          if(projected) patch.position=projected
        }
      }
      // A coalesced sample describes presence. Only the local 3D navigation has the path between reports.
      const nextActor={...actor,...patch}
      const resident=companionsDue&&stamp-Number(actor.lastCompanionSync||0)>=600
        ? await companions.sync(tx,nextActor,cfg,plots) : null
      if(nextActor.lastCompanionSync!==actor.lastCompanionSync) {
        patch.lastCompanionSync=nextActor.lastCompanionSync
        nextActor.lastCompanionSync=patch.lastCompanionSync
      }
      const update=patch.position3d?{...patch,position3d:db.command.set(next),
        manor3dInterior:db.command.set(patch.manor3dInterior)}:patch
      await tx.collection(COLLECTION).doc(actor._id).update({data:update})
      return {accepted:true,ackSeq:data.seq,position3d:next,manor3dOnline:online,actor:nextActor,resident}
    })
    const {actor,resident,...response}=result
    await Promise.all([
      actor&&publishManor3d(actor,{knownShard:true}),
      resident&&companions.publishLife(resident)
    ])
    return {...response,serverTime:now()}
  }
  async function syncManor3dVehicle(openid,data) { return manor3dVehicles.sync(openid,data) }
  async function listManor3dHomes(openid,user) {
    const homes=await ownedManor3dHomes(openid)
    const currentCommunityId=world.communityId(user||{})
    const legacyIds=homes.filter(home=>!home.community?.name&&String(home.communityId||'')!==currentCommunityId)
      .map(home=>String(home.communityId||''))
    const legacyCommunities=await require('../playground-communities')(context).resolveIds(legacyIds)
    const communities=new Map()
    for(const home of homes) {
      const id=String(home.communityId||'')
      if(!id||id.startsWith('solo_')) continue
      const saved=home.community&&typeof home.community==='object'&&String(home.community.name||'').trim()
        ? home.community
        : id===currentCommunityId?user.residentialCommunity:legacyCommunities.get(id)
      if(!saved) continue
      const community={
        ...(saved.serviceCommunityId?{serviceCommunityId:String(saved.serviceCommunityId)}:{}),
        name:String(saved.name||'').trim().slice(0,100),
        address:String(saved.address||'').trim().slice(0,300),
        city:String(saved.city||'').trim().slice(0,60),
        district:String(saved.district||'').trim().slice(0,60),
        latitude:Number.isFinite(Number(saved.latitude))?Number(saved.latitude):0,
        longitude:Number.isFinite(Number(saved.longitude))?Number(saved.longitude):0
      }
      if(community.name) communities.set(id,community)
    }
    return {communities:[...communities].map(([id,community])=>({id,community}))}
  }
  async function sync(openid,data) {
    const [cfg,plots]=await Promise.all([readPlaygroundConfig(),rows(data.sceneId,'plot')])
    const result=await transaction(db,async(tx)=>{
      const actor=await check(openid,data,tx)
      const stamp=now()
      if(!Number.isInteger(data.seq))return {serverTime:stamp,accepted:false}
      if(data.seq<=actor.seq) {
        // A committed write can lose its reply or fail to publish. Acknowledge
        // its exact sequence and retry the projection without moving twice.
        const duplicate=data.seq===actor.seq
        const vehicle=duplicate&&actor.vehicleId?await read(tx,actor.vehicleId):null
        const resident=duplicate&&actor.hasFollowers?await read(tx,residentId(openid)):null
        return {serverTime:stamp,accepted:false,ackSeq:actor.seq,actor:duplicate?actor:null,vehicle,resident,
          corrected:duplicate&&!!actor.movementCorrection,correctionReason:actor.movementCorrection||'',position:actor.position}
      }
      const car=await vehicles.sync(tx,openid,actor,data,cfg,plots)
      if(actor.vehicleRole==='passenger') {
        actor.position={...car.position};actor.moving=false;actor.running=false
        actor.seq=data.seq;actor.lastSeen=stamp;actor.online=data.online!==false
        const {_id,...saved}=actor
        await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:saved})
        return {accepted:true,ackSeq:data.seq,position:actor.position,riding:true,actor,serverTime:stamp}
      }
      const allowed=car?[]:await social.access(openid,plots,tx)
      const nav=car?require('./vehicles').vehicleNavigation(cfg,plots):publicNavigation(cfg,plots,allowed)
      if(actor.active!==false && !nav.walkable(actor.position)) {
        actor.position=safePoint(nav,actor.position)
        actor.seq=data.seq;actor.lastSeen=stamp;actor.moving=false;actor.movementCredit=0;actor.movementCorrection='permission'
        const {_id,...saved}=actor
        await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:saved})
        const vehicle=car?await vehicles.saveMovement(tx,car,actor):null
        return {serverTime:stamp,accepted:true,ackSeq:data.seq,position:actor.position,corrected:true,correctionReason:'permission',actor:{...actor,_id:presenceId(openid)},vehicle}
      }
      let correctionReason=''
      if(data.position && actor.active!==false) {
        const p=data.position
        if(![p.x,p.z].every((n)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('角色位置无效')
        const speed=car?14*car.speedMultiplier:14
        const elapsed=Math.max(0,Math.min(30,(stamp-actor.lastSeen)/1000))
        const credit=actor.movementSpeed===speed&&Number.isFinite(actor.movementCredit)?actor.movementCredit:3
        const budget=Math.min(speed*30+3,Math.max(0,credit)+elapsed*speed)
        const trail=data.trail || []
        if(!Array.isArray(trail) || trail.length>1200) throw new Error('移动路径过长，请重新进入场景')
        let previous=actor.position,total=0
        for(const point of [...trail,p]) {
          if(!point || ![point.x,point.z].every((n)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('角色位置无效')
          const distance=Math.hypot(point.x-previous.x,point.z-previous.z)
          const reason=total+distance>budget+1e-6?'distance':!nav.clearSegment(previous,point)?'path':''
          if(reason) {
            if(data.reconcile!==true)throw new Error(reason==='distance'?'移动过远，请重新进入场景':'不能穿过房屋或围栏，进入他人庭院需要好友或访问许可')
            correctionReason=reason
            break
          }
          total+=distance
          previous=point
        }
        actor.position={...previous}
        // Keep a jitter allowance, or the remaining elapsed-time budget
        // while draining bounded batches after a temporary disconnection or network latency.
        actor.movementCredit=Math.min(budget-total,data.moreTrail===true?speed*30+3:speed*1.8+3)
        actor.movementSpeed=speed
      }
      actor.characterType=data.characterType==='girl'?'girl':'boy'
      actor.mirrored=data.mirrored===true
      if(['nw','ne','sw','se'].includes(data.facing))actor.facing=data.facing
      actor.online=data.online!==false
      actor.lastSeen=stamp
      actor.seq=data.seq
      actor.movementCorrection=correctionReason
      actor.moving=!correctionReason && actor.online && data.moving===true
      actor.running=actor.moving && data.running===true
      const resident=await companions.sync(tx,actor,cfg,plots)
      delete actor._id
      await tx.collection(COLLECTION).doc(presenceId(openid)).set({data:actor})
      const vehicle=car?await vehicles.saveMovement(tx,car,actor):null
      return {serverTime:stamp,accepted:true,ackSeq:data.seq,corrected:!!correctionReason,correctionReason,position:actor.position,actor:{...actor,_id:presenceId(openid)},vehicle,resident}
    })
    await Promise.all([result.actor&&publish(result.actor),result.vehicle&&publish(result.vehicle),result.resident&&companions.publishLife(result.resident)])
    const {actor,vehicle,resident,...response}=result
    return {...response,serverTime:now()}
  }
  async function snapshot(openid,data) {
    await check(openid,data)
    const cursor=String(data.cursor||'')
    if(cursor.length>128) throw new Error('无效场景页码')
    const plots=await rows(data.sceneId,'plot'),cfg=await readPlaygroundConfig()
    const careService=require('../playground-care')(context)
    const careRules=await readPlaygroundCareRules()
    if(data.manor3d===true) {
      const manor3dHomes=await rows(data.sceneId,manor3dBuildings.KIND)
      if(!cursor) await ensureResidentRecords(data.sceneId,plots,cfg,manor3dHomes)
      const where={communityId:data.sceneId,kind:db.command.in(['plot','presence','resident',manor3dBuildings.KIND,manor3dVehicles.KIND])}
      if(cursor) where._id=db.command.gt(cursor)
      const page=(await db.collection(COLLECTION).where(where).orderBy('_id','asc').limit(100).get()).data||[]
      const stamp=now()
      await advanceResidentRows(page,data.sceneId,plots,cfg,careService,careRules,5000,manor3dHomes)
      const records=page.filter(row=>row.kind==='plot'?!row.demolished:row.kind==='resident'
        ? plots.some(plot=>plot.ownerOpenid===row.ownerOpenid&&plot._id===row.plotId)||
          row.manor3dOnly&&manor3dHomes.some(home=>home.ownerOpenid===row.ownerOpenid&&home.buildingId==='red_tile_villa')
        : row.kind!=='presence'||row.active===true||manor3dOnline(row, stamp))
        .map(row=>({...hooks.publicRecord(row),mine:row.ownerOpenid===openid}))
      return {serverTime:stamp,nextCursor:page.length===100?page[page.length-1]._id:'',records}
    }
    await careService.decoratePlots(plots)
    if(!cursor) {
      const cars=await rows(data.sceneId,'vehicle')
      for(const plot of plots.filter((p)=>!p.isNewPlot))if(!cars.some((car)=>car.ownerOpenid===plot.ownerOpenid&&car.plotId===plot._id&&car.plotInstanceId===(plot.instanceId||plot.createdAt||'')))await vehicles.ensure(plot.ownerOpenid)
      // Existing residents need not log in after deployment for their pets to appear.
      await ensureResidentRecords(data.sceneId,plots,cfg)
    }
    const where={communityId:data.sceneId,kind:db.command.in(['plot','presence','resident','vehicle',manor3dBuildings.KIND])}
    if(cursor) where._id=db.command.gt(cursor)
    const page=(await db.collection(COLLECTION).where(where).orderBy('_id','asc').limit(100).get()).data||[]
    for (const row of page) if (row.kind==='plot') {
      const current=plots.find((p)=>p._id===row._id)
      if (current && JSON.stringify(row.staffCard||null)!==JSON.stringify(current.staffCard||null)) {
        row.staffCard=current.staffCard||null;row.revision=Math.max(now(),(row.revision||0)+1)
        // Replace the whole card: legacy records can have staffCard: null.
        await db.collection(COLLECTION).doc(row._id).update({data:{staffCard:db.command.set(row.staffCard),revision:row.revision}})
      }
    }
    // Hide unplaced avatars written by older versions until their next entry.
    const legacyActors=new Set()
    for(const row of page) if(row.kind==='presence' && row.active===undefined && await read(db,world.ownerId(row.ownerOpenid))) legacyActors.add(row._id)
    const stamp=now()
    await advanceResidentRows(page,data.sceneId,plots,cfg,careService,careRules)
    const visible=page.filter((row)=>{
      if(row.kind==='plot') return !row.demolished
      if(row.kind==='presence') return row.active===true || legacyActors.has(row._id)
      if(row.kind==='resident') return plots.some((p)=>p.ownerOpenid===row.ownerOpenid&&p._id===row.plotId)
      if(row.kind==='vehicle')return plots.some((p)=>p.ownerOpenid===row.ownerOpenid&&p._id===row.plotId&&(p.instanceId||p.createdAt||'')===row.plotInstanceId)
      return true
    })
    const published=[]
    for(const row of visible) {
      const latest=row.kind==='vehicle'?await read(db,row._id):row
      if(!latest)continue
      const current=await publish(latest)
      if(current)published.push(current)
    }
    return {serverTime:now(),allowedPlotIds:await social.access(openid,plots),nextCursor:page.length===100?page[page.length-1]._id:'',records:published.map((row)=>({...publicRecord(row),version:version(row),mine:row.ownerOpenid===openid}))}
  }
  async function commandPet(openid,data) {
    const petRecord=((await db.collection('pets').where({_id:data.petId,openid}).get()).data||[])[0]
    if(!petRecord || petRecord.deletedAt) throw new Error('只能操作自己的宠物，宠物不存在或已删除')
    const cfg=await readPlaygroundConfig(), stamp=now()
    const plots=await rows(data.sceneId,'plot')
    // High-frequency movement must not invalidate a pet-command transaction.
    // The resident session fences commands against concurrent scene re-entry.
    const actor=await check(openid,data)
    const result=await transaction(db,async(tx)=>{
      const resident=await read(tx,residentId(openid))
      if(actor.vehicleId||resident&&resident.ridingVehicleId)throw new Error('请先下车再操作宠物')
      if(!resident || resident.communityId!==actor.communityId) throw new Error('只能操作自己当前小区的宠物')
      if(resident.session && resident.session!==data.session) throw new Error('场景已切换，请重新进入')
      const pet=(resident.pets||[]).find((p)=>p.id===data.petId)
      if(!pet) throw new Error('只能操作自己的宠物')
      if(pet.serviceManaged)throw new Error('宠物正在接受宠托师服务，请等待照护完成后再操作')
      if(!Number.isInteger(data.commandSeq) || data.commandSeq<1) throw new Error('无效宠物操作序号')
      if(data.commandSeq<=(resident.petSeq||0)) throw new Error('宠物操作已更新，请使用最新指令')
      let current=sampleMotion(pet.motion,stamp).position
      const manor3dPosition=commandManor3dPosition(data,cfg)
      if(manor3dPosition) {
        current=manor3dPosition
        if(!resident.manor3dOnly&&!navigation(cfg,plots,current,current,'pet',resident.plotId).walkable(current)) {
          throw new Error('宠物不能进入其他住户的庭院')
        }
        pet.motion=resident.manor3dOnly
          ? {epoch:stamp,approach:[current],patrol:[current],speed:7,roamSpeed:3,wait:3}
          : motion(cfg,plots,current,stamp,pet.id+'-manor3d')
      }
      settleNeeds(pet,stamp)
      if(data.interact!==true){pet.following=false;pet.care=null}
      else pet.followCenter=null
      let target=data.target
      if(data.interact===true) {
        if(pet.interactionUntil>stamp) throw new Error('宠物正在互动，请稍等一下')
        const nearby=manor3dPosition&&validManor3dPosition(actor.position3d)
          ? Math.hypot(actor.position3d.x-data.manor3dPosition.x,actor.position3d.z-data.manor3dPosition.z)<=4.5
          : Math.hypot(actor.position.x-current.x,actor.position.z-current.z)<=4
        const visiblePath=resident.manor3dOnly||navigation(cfg,plots,actor.position,current,'character',null,
          await social.access(openid,plots,tx)).clearSegment(actor.position,current)
        if(!nearby||!visiblePath) throw new Error('请先走近自己的宠物')
        target=current
      }
      if(!target || ![target.x,target.z].every((n)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('请选择有效目的地')
      if(Math.hypot(target.x-current.x,target.z-current.z)>300) throw new Error('请先选择附近的草地')
      const nav=resident.manor3dOnly?null:navigation(cfg,plots,current,target,'pet',resident.plotId)
      const route=resident.manor3dOnly?[data.interact===true?current:target]:nav.path(current,target)
      if(!route) throw new Error('这里无法到达，请从自家庭院院门进出')
      pet.motion=resident.manor3dOnly
        ? {epoch:data.interact===true?stamp-500:stamp,approach:[current,...route],patrol:[target],speed:7,roamSpeed:3,wait:3}
        : motion(cfg,plots,target,data.interact===true?stamp-500:stamp,pet.id+stamp,[current,...route])
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
      for(const [id,kind] of [[plotId,'plot'],[presenceId(openid),'presence'],[residentId(openid),'resident'],[require('./vehicles').vehicleId(openid),'vehicle']]) await live.publish(sceneId,{id,kind,deleted:true})
    } else {const row=await read(db,plotId);if(row){await publish(row);await vehicles.ensure(openid)}}
  }
  return {enter,sync,syncManor3d,syncManor3dVehicle,listManor3dHomes,placeManor3dBuilding,snapshot,commandPet,petScale,plotChanged,social,vehicles,companions,farm,rides,publishRecords:(records)=>Promise.all(records.map(publish))}
}
module.exports.navigation=navigation
module.exports.motion=motion
