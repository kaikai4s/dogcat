const CROPS = [
  {id:'carrot',name:'胡萝卜',minutes:5,price:3,sell:6,yield:3,xp:12,level:1,color:'#ed9854'},
  {id:'radish',name:'白萝卜',minutes:10,price:5,sell:9,yield:3,xp:18,level:1,color:'#f4eee0'},
  {id:'corn',name:'玉米',minutes:20,price:8,sell:14,yield:3,xp:25,level:2,color:'#efc858'},
  {id:'strawberry',name:'草莓',minutes:30,price:12,sell:20,yield:3,xp:35,level:2,color:'#e47a78'},
  {id:'pumpkin',name:'南瓜',minutes:60,price:18,sell:30,yield:4,xp:50,level:3,color:'#eaa24c'},
  {id:'sunflower',name:'向日葵',minutes:120,price:25,sell:40,yield:4,xp:70,level:4,color:'#f0ca55'}
]
const cropById=(id)=>CROPS.find((c)=>c.id===id)
const level=(xp)=>Math.min(10,1+Math.floor(Math.max(0,xp||0)/80))
function farmLayout(plot) {
  const scale=Math.min(1,(plot.size||112)/112)
  return Array.from({length:12},(_,index)=>({id:index,x:plot.x+(10+index%4*5)*scale,z:plot.z+(-27+Math.floor(index/4)*6)*scale,size:4*scale}))
}
// Reach one individual plot; adjacent plots must not share a remote action.
const bedReach=(tile)=>Math.max(1.8,tile.size*.8)
function bedView(bed,stamp) {
  if(!bed)return {state:'wild',label:'待开垦',progress:0}
  if(!bed.cropId)return {...bed,state:'empty',label:'待播种',progress:0}
  const crop=cropById(bed.cropId),duration=bed.readyAt-bed.plantedAt
  const progress=Math.max(0,Math.min(100,(stamp-bed.plantedAt)/Math.max(1,duration)*100))
  return {...bed,state:stamp>=bed.readyAt?'ready':'growing',label:stamp>=bed.readyAt?'可收获':progress<20?'萌芽':progress<65?'生长中':'即将成熟',
    name:crop?crop.name:'作物',color:crop?crop.color:'#7ca557',progress:Math.floor(progress),remaining:Math.max(0,Math.ceil((bed.readyAt-stamp)/1000))}
}
function newFarm() {return {coins:120,xp:0,seeds:{carrot:12,radish:8},produce:{},beds:{},receipts:[]}}
module.exports={CROPS,cropById,level,farmLayout,bedReach,bedView,newFarm}
