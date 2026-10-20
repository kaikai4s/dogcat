const world = require('./playground-world')
const { sampleMotion } = require('./playground-shared/shared-motion')
const { settleNeeds } = require('./playground-shared/pet-needs')
const { publicAppearance } = require('./playground-appearance-record')
const LABELS = { feed: '添加粮食', food: '添加粮食', water: '更换饮水', litter: '清理猫砂', clean: '环境清洁', play: '陪伴互动', leash_on: '牵引散步', return_home: '回到庭院', pet_status: '日常照护' }
function gate(plot, outside = true) {
  const n = (plot.size || 48) / 2 + (outside ? 3 : -5), dir = plot.gateDirection || 'south'
  return { x: plot.x + (dir === 'west' ? -n : dir === 'east' ? n : 0), z: plot.z + (dir === 'north' ? -n : dir === 'south' ? n : 0) }
}
const petIds = (order) => order.petIds && order.petIds.length ? order.petIds : order.petId ? [order.petId] : []
const millis = (value) => typeof value === 'number' ? value : new Date(value || 0).getTime()
const sessionKey = (order) => [order._id, order.activeSessionIndex || 0, order.currentSessionStartedAt || order.startedAt || '', order.staffOpenid].join(':')
const layoutKey = (plots) => JSON.stringify(plots.map((p) => [p._id, p.x, p.z, p.size, p.gateDirection, p.buildingType, p.footprint]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
function duration(route, speed = 5) { let d = 0; for (let i = 1; i < route.length; i++) d += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z); return d / speed * 1000 }
module.exports = function createCare(context) {
  const { db } = context, now = () => context.nowMs ? context.nowMs() : Date.now()
  async function decoratePlots(plots) {
    const owners=[...new Set(plots.filter(world.isResidence).map((p)=>p.ownerOpenid))],profiles=[]
    for(let i=0;i<owners.length;i+=50) {
      const res=await db.collection('staff_profiles').where({openid:db.command.in(owners.slice(i,i+50))}).limit(100).get()
      profiles.push(...res.data||[])
    }
    for (const plot of plots) {
      const staff = world.isResidence(plot) && profiles.find((s)=>s.openid===plot.ownerOpenid&&s.auditStatus==='approved'&&!s.deletedAt&&!s.revokedAt)
      plot.staffCard = staff ? { id: staff._id, label: staff.staffLevel === 'intern' ? '实习宠托师' : '认证宠托师' } : null
    }
  }
  async function activeOrders(owner) {
    const res = await db.collection('orders').where({ clientOpenid: owner, status: 'in_service' }).orderBy('updatedAt', 'desc').limit(100).get()
    return (res.data || []).filter((o) => !o.adminDeletedAt && !o.deletedAt && o.staffOpenid && petIds(o).length)
  }
  async function advanceOne(tx, resident, cfg, plots, hooks, order) {
    if(order) {
      const current=await world.readDocument(tx,'orders',order._id,'读取服务状态',true)
      order=current&&current.status==='in_service'&&!current.deletedAt&&!current.adminDeletedAt?current:null
    }
    const stamp = now(), plot = plots.find((p) => p._id === resident.plotId)
    if (!plot) return false
    const previous = JSON.stringify([resident.serviceCare, resident.careAgent, resident.pets])
    let state = resident.serviceCare
    const same = order && state && state.orderId === order._id && (!state.sessionKey || state.sessionKey === sessionKey(order))
    const geometry = world.hash(JSON.stringify([cfg.width, cfg.height, layoutKey(plots)]))
    if (state && state.layoutKey !== geometry) {
      const current = sampleMotion(state.motion, stamp).position
      const nav = hooks.navigation(cfg, plots, current, current, 'companion', null, [plot._id])
      const start = nav.walkable(current) ? current : hooks.safePoint(nav, current)
      state.motion = { epoch: stamp, approach: [start], patrol: [start], speed: 5 }
      // Rebuild routes against new fences/buildings before resuming any service.
      state.phase = 'returning'; state.blocked = true; state.layoutKey = geometry
    }
    if (state && ((!same && state.phase !== 'returning') || state.blocked)) {
      const start = sampleMotion(state.motion, stamp).position, end = gate(plot, false)
      const nav = hooks.navigation(cfg, plots, start, end, 'companion', null, [plot._id]), path = nav.path(start, end)
      if (path) { const route = [start, ...path]; state = { ...state, phase: 'returning', blocked:false, motion: { epoch: stamp, approach: route, patrol: [end], speed: 5 }, arrivesAt: stamp + duration(route) } }
      else state={...state,phase:'returning',blocked:true,motion:{epoch:stamp,approach:[start],patrol:[start],speed:5}}
    }
    const returningPets = state && (resident.pets || []).filter((p) => state.petIds.includes(p.id) && state.walk && p.species === 'dog' && !p.ridingVehicleId)
    const petsReturned = state && returningPets.every((p) => p.serviceMotionKey === 'returning' + state.motion.epoch && stamp >= p.motion.epoch + duration(p.motion.approach))
    if (state && state.phase === 'returning' && !state.blocked && stamp >= state.arrivesAt && petsReturned) {
      for (const pet of resident.pets || []) if (state.petIds.includes(pet.id)) {
        const start = gate(plot, false)
        pet.motion = hooks.motion(cfg, plots, start, stamp, pet.id + 'service_home')
        pet.serviceManaged = false
        pet.serviceAgentId = ''
        pet.serviceMotionKey = ''
        pet.care = null
      }
      state = null
      resident.careAgent = null
    }
    if (!state && order) {
      const start = gate(plot), end = gate(plot, false), nav = hooks.navigation(cfg, plots, start, end, 'companion', null, [plot._id]), path = nav.path(start, end)
      if (path) {
        const route = [start, ...path]
        const sitter=await world.read(tx,'presence_'+world.hash(order.staffOpenid))
        const displayId='presence_'+world.hash(order.staffOpenid)
        state = { orderId: order._id, sessionKey: sessionKey(order), layoutKey: geometry, petIds: petIds(order), displayId, appearance:sitter?publicAppearance(sitter.appearance,'character',displayId,order.staffOpenid):null, characterType:sitter&&sitter.characterType==='girl'?'girl':'boy', walk: (order.serviceTypes || [order.serviceType]).includes('walk'), phase: 'entering',
          motion: { epoch: stamp, approach: route, patrol: [end], speed: 5 }, arrivesAt: stamp + duration(route), lastCareAt: stamp }
      }
    }
    if (state && same && state.phase === 'entering' && stamp >= state.arrivesAt) {
      const start = gate(plot, false), outside = gate(plot), nav = hooks.navigation(cfg, plots, start, outside, 'companion', null, [plot._id])
      const path = nav.path(start, outside)
      if (state.walk && path) {
        const patrol = [outside]
        let seed = parseInt(world.hash(state.orderId).slice(0, 8), 16)
        const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
        for (let i = 0; i < 16 && patrol.length < 7; i++) {
          const a = random() * Math.PI * 2, radius = 5 + random() * 24
          const target = { x: outside.x + Math.cos(a) * radius, z: outside.z + Math.sin(a) * radius }
          const inside = plots.some((p) => Math.abs(target.x - p.x) < (p.size || 48) / 2 && Math.abs(target.z - p.z) < (p.size || 48) / 2)
          if (!inside && nav.clearSegment(patrol[patrol.length - 1], target) && nav.clearSegment(target, outside)) patrol.push(target)
        }
        patrol.push(outside)
        state.phase = 'walking'
        state.motion = { epoch: stamp, approach: [start, ...path], patrol, speed: 5, roamSpeed: 3, wait: 2 }
      } else {
        state.phase = 'caring'
        const target = { x: plot.x + 7, z: plot.z + 10 }, path = nav.path(start, target)
        state.motion = { epoch: stamp, approach: [start], patrol: path ? [start, ...path, ...path.slice().reverse(), start] : [start], roamSpeed: 3, wait: 5 }
      }
    }
    if (state) {
      resident.careAgent = { id: 'care_' + world.hash(resident.ownerOpenid + ':' + state.orderId), displayId:state.displayId||'', appearance:state.appearance||null, name: '认证宠托师', phase: state.phase, characterType:state.characterType||'boy',
        label: { entering: '入院照护', caring: '清理·照护', walking: '牵引遛狗', returning: '带宠回家' }[state.phase], motion: state.motion }
      const elapsed = Math.max(0, (stamp - state.lastCareAt) / 1000)
      for (const pet of resident.pets || []) if (state.petIds.includes(pet.id) && !pet.ridingVehicleId) {
        const values = settleNeeds(pet, stamp), rules = pet.needsRules || {}
        pet.serviceManaged = true; pet.following = false; pet.care = null
        pet.serviceAgentId=resident.careAgent.id
        if ((state.phase === 'walking' || state.phase === 'returning') && state.walk && pet.species === 'dog') {
          const key=state.phase+state.motion.epoch
          if(pet.serviceMotionKey!==key) {
            const start=sampleMotion(pet.motion,stamp).position,target=state.motion.approach[0]
            const nav=hooks.navigation(cfg,plots,start,target,'companion',null,[plot._id]),connector=nav.path(start,target)
            if(connector) {
              const approach=[start,...connector,...state.motion.approach.slice(1)]
              pet.motion={...state.motion,epoch:stamp+400+state.petIds.indexOf(pet.id)*300,approach}
              pet.serviceMotionKey=key
              if(state.phase==='returning')state.arrivesAt=Math.max(state.arrivesAt,pet.motion.epoch+duration(approach))
            }
          }
        }
        else if (state.phase === 'caring') {
          for (const [key, rate] of [['satiety', rules.eatRate || .24], ['hydration', rules.drinkRate || .3], ['energy', rules.sleepRate || .16]]) values[key] = Math.min(100, values[key] + elapsed * rate)
          pet.waste = []
        }
      }
      if (state.phase === 'caring') {
        for (const id of [plot._id, world.ownerId(resident.ownerOpenid)]) {
          const current = await world.read(tx, id)
          if (!current || current.foodBowls && current.foodBowls.dog === 100 && current.foodBowls.cat === 100) continue
          const patch = { foodBowls: { dog: 100, cat: 100 } }
          // Scene clients discard records whose version has not advanced.
          if (id === plot._id) patch.revision = Math.max(stamp, (current.revision || 0) + 1)
          await tx.collection('pet_playground_plots').doc(id).update({ data: patch })
        }
      }
      state.lastCareAt = stamp
    }
    resident.serviceCare = state
    return previous !== JSON.stringify([resident.serviceCare, resident.careAgent, resident.pets])
  }
  async function advance(tx, resident, cfg, plots, hooks, input) {
    const before = JSON.stringify([resident.serviceCares, resident.serviceCare, resident.careAgents, resident.careAgent, resident.pets])
    const orders = Array.isArray(input) ? input : input ? [input] : []
    const states = Array.isArray(resident.serviceCares) ? resident.serviceCares : resident.serviceCare ? [resident.serviceCare] : []
    const nextStates = [], agents = [], claimed = new Set()
    async function run(state, order) {
      const slot = { ...resident, serviceCare: state, careAgent: null }
      await advanceOne(tx, slot, cfg, plots, hooks, order)
      if (slot.serviceCare) {
        nextStates.push(slot.serviceCare)
        agents.push(slot.careAgent)
        slot.serviceCare.petIds.forEach((id) => claimed.add(id))
      }
    }
    for (const state of states) await run(state, orders.find((o) => o._id === state.orderId))
    for (const order of orders) {
      if (nextStates.some((s) => s.orderId === order._id) || petIds(order).some((id) => claimed.has(id))) continue
      await run(null, order)
    }
    resident.serviceCares = nextStates
    resident.careAgents = agents
    // Keep the primary fields readable by older clients during rollout.
    resident.serviceCare = nextStates[0] || null
    resident.careAgent = agents[0] || null
    return before !== JSON.stringify([resident.serviceCares, resident.serviceCare, resident.careAgents, resident.careAgent, resident.pets])
  }
  async function publicCare(openid, data) {
    const actor = await world.read(db, 'presence_' + world.hash(openid))
    if (!actor || actor.session !== data.session || actor.communityId !== data.sceneId) throw new Error('请先进入当前小区')
    let resident=null,cursor=''
    do {
      const res=await db.collection('pet_playground_plots').where({kind:'resident',communityId:actor.communityId,...(cursor?{_id:db.command.gt(cursor)}:{})}).orderBy('_id','asc').limit(100).get()
      const page=res.data||[]
      resident=page.find((r)=>(r.pets||[]).some((p)=>p.id===data.petId))
      cursor=page.length===100?page[page.length-1]._id:''
    }while(!resident&&cursor)
    const pet = resident && resident.pets.find((p) => p.id === data.petId)
    if (!pet || !pet.motion) throw new Error('宠物已离开当前场景')
    const position = sampleMotion(pet.motion, now()).position
    if (Math.hypot(actor.position.x - position.x, actor.position.z - position.z) > 8) throw new Error('请走近宠物后查看照护记录')
    const orders = (await db.collection('orders').where({ clientOpenid: resident.ownerOpenid }).orderBy('createdAt', 'desc').limit(30).get()).data || []
    const records = []
    for (const order of orders.filter((o) => !o.deletedAt && !o.adminDeletedAt && petIds(o).includes(pet.id) && ['in_service', 'day_completed', 'completed'].includes(o.status)).slice(0, 5)) {
      const logs = (await db.collection('checkin_logs').where({ orderId: order._id }).orderBy('createdAt', 'desc').limit(20).get()).data || []
      for (const log of logs) if (!log.deletedAt && LABELS[log.eventType] && (!log.petId || log.petId === pet.id)) records.push({ label: LABELS[log.eventType], date: require('../utils/time').toCstParts(log.createdAt).dateKey, stamp: millis(log.createdAt) })
    }
    records.sort((a, b) => b.stamp - a.stamp)
    return { petName: String(pet.name || '宠物').slice(0, 20), active: !!pet.serviceManaged, records: records.slice(0, 15).map(({ label, date }) => ({ label, date })) }
  }
  return { decoratePlots, activeOrders, advance, publicCare }
}
