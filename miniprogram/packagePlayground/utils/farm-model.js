const FARM_BASE='cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/farm/'
const SOILS={wild:FARM_BASE+'soil-wild.png',tilled:FARM_BASE+'soil-tilled.png',watered:FARM_BASE+'soil-watered.png'}
const CROPS = [
  {id:'carrot',name:'胡萝卜',minutes:5,price:0,sell:6,yield:3,xp:12,level:1,color:'#ed9854'},
  {id:'radish',name:'白萝卜',minutes:10,price:0,sell:9,yield:3,xp:18,level:1,color:'#f4eee0'},
  {id:'corn',name:'玉米',minutes:20,price:0,sell:14,yield:3,xp:25,level:2,color:'#efc858'},
  {id:'strawberry',name:'草莓',minutes:30,price:0,sell:20,yield:3,xp:35,level:2,color:'#e47a78'},
  {id:'pumpkin',name:'南瓜',minutes:60,price:0,sell:30,yield:4,xp:50,level:3,color:'#eaa24c'},
  {id:'sunflower',name:'向日葵',minutes:120,price:0,sell:40,yield:4,xp:70,level:4,color:'#f0ca55'}
].map((crop)=>{const stages=['radish','corn'].includes(crop.id)?[0,15,45,75,100]:[0,20,65,100];return {...crop,enabled:true,stages,atlas:{fileID:FARM_BASE+crop.id+'-stages.png',columns:stages.length,rows:1,frameSize:256,anchorX:.5,anchorY:.75}}})
const cropById=(id,crops=CROPS)=>crops.find((c)=>c.id===id)
function growthStage(crop,progress) {
  const stages=crop&&crop.stages||[0,20,65,100]
  let frame=0
  for(let i=1;i<stages.length;i++)if(progress>=stages[i])frame=i
  return frame
}
const level=(xp)=>Math.min(10,1+Math.floor(Math.max(0,xp||0)/80))
function farmLayout(plot) {
  const scale=Math.min(1,(plot.size||112)/112)
  return Array.from({length:12},(_,index)=>({id:index,x:plot.x+(10+index%4*5)*scale,z:plot.z+(-27+Math.floor(index/4)*6)*scale,size:4*scale}))
}
// Reach one individual plot; adjacent plots must not share a remote action.
const bedReach=(tile)=>Math.max(1.8,tile.size*.8)
function bedView(bed,stamp,crops=CROPS) {
  if(!bed)return {state:'wild',label:'待开垦',progress:0}
  if(!bed.cropId)return {...bed,state:'empty',label:'待播种',progress:0}
  const crop=cropById(bed.cropId,crops),duration=bed.readyAt-bed.plantedAt
  const progress=Math.max(0,Math.min(100,(stamp-bed.plantedAt)/Math.max(1,duration)*100))
  const boosted=bed.boostUntil&&stamp<bed.boostUntil
  const defaultLabel=stamp>=bed.readyAt?'可收获':boosted?'双倍生长中':progress<20?'萌芽':progress<65?'生长中':'即将成熟'
  return {...bed,state:stamp>=bed.readyAt?'ready':'growing',label:defaultLabel,
    name:crop?crop.name:'作物',color:crop?crop.color:'#7ca557',progress:Math.floor(progress),remaining:Math.max(0,Math.ceil((bed.readyAt-stamp)/1000)),boosted:!!boosted}
}
function newFarm() {return {coins:120,xp:0,seeds:{carrot:12,radish:8},produce:{},beds:{},manure:0,receipts:[]}}
module.exports={CROPS,SOILS,FARM_BASE,cropById,growthStage,level,farmLayout,bedReach,bedView,newFarm}
