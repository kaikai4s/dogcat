const {transaction}=require('../playground-transaction')
const world=require('../playground-world')
const {readCatalog}=require('../playground-farm-catalog')
const {cropById,level,farmLayout,bedReach,bedView,newFarm}=require('./farm-model')
const {createNavigation}=require('./navigation')
const {yardLayout}=require('./yard-layout')
const COLLECTION='pet_playground_plots'
module.exports=function createFarm(context,hooks) {
  const {db}=context,now=()=>context.nowMs?context.nowMs():Date.now()
  const save=async(tx,id,row)=>{const {_id,...data}=row;await tx.collection(COLLECTION).doc(id).set({data})}
  const accountId=(openid)=>'farm_'+world.hash(openid)
  async function home(tx,openid,data) {
    const actor=await hooks.check(openid,data,tx),own=await hooks.read(tx,world.ownerId(openid))
    if(!own||!actor.active||own.communityId!==actor.communityId)throw new Error('请回到自己的庭院管理菜园')
    const plot=await hooks.read(tx,own.plotId)
    if(!plot||(plot.instanceId||plot.createdAt)!==(own.instanceId||own.createdAt))throw new Error('庭院已变化，请重新进入')
    const account=await hooks.read(tx,accountId(openid))
    const farm={...newFarm(),...(account&&account.farm||own.farm)}
    if(account&&(account.plotId!==own.plotId||account.instanceId!==(own.instanceId||own.createdAt||'')))farm.beds={}
    own.farm=farm
    return {actor,own,plot}
  }
  function view(own,stamp,catalog) {
    const farm={...newFarm(),...own.farm},currentLevel=level(farm.xp)
    return {plotId:own.plotId,serverTime:stamp,coins:farm.coins,xp:farm.xp,level:currentLevel,
      nextLevelXp:currentLevel<10?currentLevel*80:null,seeds:farm.seeds,produce:farm.produce,
      manure:farm.manure||0,
      unlockedBeds:Math.min(12,4+(currentLevel-1)*2),
      catalog,
      crops:catalog.crops.map((c)=>({...c,unlocked:c.enabled!==false&&c.level<=currentLevel,seeds:farm.seeds[c.id]||0,stock:farm.produce[c.id]||0})),
      beds:farmLayout(own).map((p)=>({...p,...bedView(farm.beds[p.id],stamp,catalog.crops),unlocked:p.id<Math.min(12,4+(currentLevel-1)*2)}))}
  }
  async function state(openid,data) {
    const result=await home(db,openid,data)
    return view(result.own,now(),await readCatalog(db))
  }
  async function action(openid,data) {
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(data.requestId||''))throw new Error('缺少有效操作标识，请重试')
    const stamp=now(),fingerprint=JSON.stringify([data.operation,data.bedId,data.cropId,data.quantity])
    const result=await transaction(db,async(tx)=>{
      const {actor,own,plot}=await home(tx,openid,data)
      const catalog=await readCatalog(tx),crops=catalog.crops
      const bedSpec=(bed)=>{
        const current=bed&&cropById(bed.cropId,crops)
        return current?{...current,...(bed.parameters||cropById(bed.cropId)||{})}:null
      }
      const farm={...newFarm(),...own.farm},receipts=farm.receipts||[]
      const receipt=receipts.find((r)=>r.id===data.requestId)
      if(receipt) {
        if(receipt.fingerprint!==fingerprint)throw new Error('操作标识已使用，请刷新菜园')
        return {own,plot,catalog,message:receipt.message}
      }
      if(actor.vehicleId)throw new Error('请先下车再照料菜园')
      const tiles=farmLayout(plot)
      const currentLevel=level(farm.xp),capacity=Math.min(12,4+(currentLevel-1)*2)
      const crop=cropById(data.cropId,crops),operation=data.operation
      const bedId=data.bedId
      const selected=Number.isInteger(bedId)&&bedId>=0&&bedId<12?tiles[bedId]:null
      const quantity=data.quantity===undefined?1:data.quantity
      let message='菜园已更新'
      const spend=(value)=>{if(farm.coins<value)throw new Error('农场金币不足，可以出售收获换取金币');farm.coins-=value}
      const plant=(id)=>{
        if(!crop||crop.enabled===false||crop.level>currentLevel)throw new Error('该作物已下架或尚未解锁')
        if(!farm.beds[id]||farm.beds[id].cropId)throw new Error('请选择已开垦的空地')
        if(!(farm.seeds[crop.id]>0))throw new Error('种子不足，请先购买种子')
        farm.seeds[crop.id]--
        farm.beds[id]={id,cropId:crop.id,parameters:{minutes:crop.minutes,yield:crop.yield,xp:crop.xp},plantedAt:stamp,readyAt:stamp+crop.minutes*60000,watered:false,fertilized:false}
      }
      const harvest=(id)=>{
        const bed=farm.beds[id],spec=bedSpec(bed)
        if(!spec||stamp<bed.readyAt)throw new Error('作物还没有成熟')
        const count=spec.yield+(bed.watered?1:0)+(bed.fertilized?1:0)
        farm.produce[bed.cropId]=(farm.produce[bed.cropId]||0)+count;farm.xp+=spec.xp
        farm.beds[id]={id};return count
      }
      const water=(id)=>{
        const bed=farm.beds[id],spec=bedSpec(bed)
        if(!spec||bed.watered||stamp>=bed.readyAt)throw new Error('请选择尚未浇水且正在生长的作物')
        bed.watered=true;bed.readyAt=Math.max(stamp+1000,bed.readyAt-spec.minutes*60000*.15)
      }
      if(['till','plant','water','fertilize','harvest'].includes(operation)) {
        if(!selected||bedId>=capacity)throw new Error('这块土地还未解锁')
        if(Math.hypot(actor.position.x-selected.x,actor.position.z-selected.z)>bedReach(selected))throw new Error('请先走到这块土地旁边')
        const blocks=yardLayout(plot).sprites.filter((p)=>p.radius>0).map((p)=>({minX:p.x-p.radius,maxX:p.x+p.radius,minZ:p.z-p.radius,maxZ:p.z+p.radius}))
        const half=(plot.size||112)/2
        const nav=createNavigation({minX:plot.x-half,minZ:plot.z-half,maxX:plot.x+half,maxZ:plot.z+half},blocks,.8,1.5)
        if(!nav.clearSegment(actor.position,selected))throw new Error('请绕过障碍走到这块土地旁边')
        const bed=farm.beds[bedId]
        if(operation==='till') {
          if(bed)throw new Error('这块土地已经开垦')
          spend(10);farm.beds[bedId]={id:bedId};message='土地已开垦，可以播种了'
        } else if(operation==='plant') {plant(bedId);message=crop.name+'已播种'}
        else if(operation==='water'){water(bedId);message='浇水完成，生长加快且收成 +1'}
        else if(operation==='harvest'){const count=harvest(bedId);message='收获 '+count+' 份，已放入仓库'}
        else {
          const spec=bedSpec(bed)
          if(!spec||bed.fertilized||stamp>=bed.readyAt)throw new Error('请选择尚未施肥且正在生长的作物')
          if(data.useManure||(data.useManure===undefined&&farm.manure>0)) {
            if(!farm.manure||farm.manure<=0)throw new Error('仓库中暂无便便有机肥')
            farm.manure=Math.max(0,farm.manure-1)
            bed.fertilized=true
            const boostMs=60*60*1000
            const remaining=bed.readyAt-stamp
            const deduction=Math.min(boostMs,Math.max(1000,remaining*0.5))
            bed.readyAt=Math.max(stamp+1000,bed.readyAt-deduction)
            bed.boostUntil=stamp+boostMs
            message='已使用便便施肥！作物享受1小时双倍生长加速！收成 +1'
          } else {
            spend(5);bed.fertilized=true;bed.readyAt=Math.max(stamp+1000,bed.readyAt-spec.minutes*60000*.2)
            message='施肥完成，生长加快且收成 +1'
          }
        }
      } else if(operation==='pickupPoop') {
        const poopId = String(data.poopId || data.requestId || '')
        farm.pickedPoops = farm.pickedPoops || []
        if (poopId && farm.pickedPoops.includes(poopId)) {
          throw new Error('该便便已被拾取，不可重复拾取')
        }
        if (poopId) {
          const pickedKey = 'picked_poop_' + poopId
          const existing = await hooks.read(tx, pickedKey)
          if (existing && existing.picked) {
            throw new Error('该便便已被其他邻居拾取，不可重复拾取')
          }
          await tx.collection(COLLECTION).doc(pickedKey).set({
            data: {
              kind: 'picked_poop',
              picked: true,
              poopId,
              pickedBy: openid,
              pickedAt: stamp,
              communityId: actor.communityId
            }
          })
          farm.pickedPoops.push(poopId)
          if (farm.pickedPoops.length > 200) farm.pickedPoops.shift()
        }
        farm.manure=(farm.manure||0)+(quantity||1)
        message='已将便便存入农场仓库化为有机肥'
      } else if(operation==='buySeeds') {
        if(!crop||crop.enabled===false||crop.level>currentLevel)throw new Error('该种子已下架或尚未解锁')
        if(!Number.isInteger(quantity)||quantity<1||quantity>99)throw new Error('购买数量须在1～99之间')
        spend(crop.price*quantity);farm.seeds[crop.id]=(farm.seeds[crop.id]||0)+quantity
        message='已购买 '+quantity+' 包'+crop.name+'种子'
      } else if(operation==='sell') {
        if(!crop||!Number.isInteger(quantity)||quantity<1||quantity>(farm.produce[crop.id]||0))throw new Error('仓库里的作物数量不足')
        farm.produce[crop.id]-=quantity;farm.coins+=quantity*crop.sell;message='出售完成，获得 '+quantity*crop.sell+' 农场金币'
      } else if(['harvestAll','waterAll','plantAll'].includes(operation)) {
        throw new Error('请走到每块土地旁边操作')
      } else throw new Error('未知农场操作')
      farm.receipts=[...receipts.slice(-39),{id:data.requestId,fingerprint,message}]
      own.farm=farm
      // Public land carries crops only; wallets, request IDs and inventory stay private.
      plot.farmBeds=Object.values(farm.beds)
      plot.revision=Math.max(stamp,(plot.revision||0)+1)
      await save(tx,accountId(openid),{kind:'farm_account',ownerOpenid:openid,plotId:own.plotId,instanceId:own.instanceId||own.createdAt||'',farm})
      await save(tx,world.ownerId(openid),own);await save(tx,own.plotId,plot)
      return {own,plot,catalog,message}
    })
    await hooks.publish(result.plot)
    return {...view(result.own,now(),result.catalog),message:result.message}
  }
  return {state,action}
}
