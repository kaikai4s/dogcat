const {createCollectionStore}=require('../cloudfunctions/helpers')
const world=require('../../cloudfunctions/api/services/playground-world')
const createShared=require('../../cloudfunctions/api/services/playground-shared')
const {vehicleId}=require('../../cloudfunctions/api/services/playground-shared/vehicles')
function fixture() {
  let time=1800000000000
  const users=['a','b','c','d','e','f'].map((openid)=>({_id:'user_'+openid,openid,nickname:'玩家'+openid,residentialCommunity:{name:openid==='f'?'B小区':'A小区'}}))
  const pets=users.map((u)=>({_id:'pet_'+u.openid,openid:u.openid,name:'宠物'+u.openid,species:u.openid==='b'?'cat':'dog'}))
  const db=createCollectionStore({users,pets}),context={db,nowMs:()=>time,nowText:()=>new Date(time).toISOString()}
  const shared=createShared(context),plots=world.create(context),seq={},commands={}
  const user=(id)=>users.find((u)=>u.openid===id)
  const enter=(id,community)=>shared.enter(id,user(id),{community},pets.filter((p)=>p.openid===id))
  const auth=(scene)=>({session:scene.session,sceneId:scene.sceneId})
  const row=(id)=>db.state.pet_playground_plots.find((r)=>r._id===id)
  const actor=(id)=>row('presence_'+world.hash(id)),resident=(id)=>row('resident_'+world.hash(id))
  const pet=(id)=>resident(id).pets[0],car=(id)=>row(vehicleId(id))
  async function build(id='a',position={x:280,z:280}) {await plots.claim(id,user(id),position);return enter(id)}
  async function sync(id,scene,data={}) {
    seq[id]=(seq[id]||0)+1
    return shared.sync(id,{...auth(scene),seq:seq[id],vehicleId:actor(id).vehicleId||'',...data})
  }
  const action=(id,scene,operation)=>shared.vehicles.action(id,user(id),{...auth(scene),operation,vehicleId:vehicleId(id)})
  const petAction=(id,scene,operation,extra={})=>shared.companions.action(id,{...auth(scene),operation,petId:'pet_'+id,commandSeq:commands[id]=(commands[id]||0)+1,...extra})
  function place(id,position) {actor(id).position={...position};actor(id).lastSeen=time;actor(id).online=true}
  function placePet(id,position) {pet(id).motion={epoch:time,approach:[{...position}],patrol:[{...position}]}}
  async function drive(id='a',scene) {
    scene=scene||await build(id)
    await action(id,scene,'start');place(id,car(id).position);placePet(id,{x:car(id).position.x+2,z:car(id).position.z+1})
    await action(id,scene,'enter');return scene
  }
  let request=0
  const farmAction=(id,scene,operation,extra={})=>shared.farm.action(id,{...auth(scene),operation,requestId:'request_'+(++request).toString().padStart(8,'0'),...extra})
  return {db,context,shared,plots,user,enter,auth,row,actor,resident,pet,car,build,sync,action,petAction,place,placePet,drive,farmAction,
    now:()=>time,advance:(ms)=>time+=ms}
}
module.exports={fixture}
