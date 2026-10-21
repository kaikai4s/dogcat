const FARM_BASE='cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/farm/'
const SOILS={soil:FARM_BASE+'soil-wild.png',tilled:FARM_BASE+'soil-tilled.png',watered:FARM_BASE+'soil-watered.png'}
const CROPS = [
  {id:'carrot',name:'胡萝卜',minutes:5,color:'#ed9854'},
  {id:'radish',name:'白萝卜',minutes:10,color:'#f4eee0'},
  {id:'corn',name:'玉米',minutes:20,color:'#efc858'},
  {id:'strawberry',name:'草莓',minutes:30,color:'#e47a78'},
  {id:'pumpkin',name:'南瓜',minutes:60,color:'#eaa24c'},
  {id:'sunflower',name:'向日葵',minutes:120,color:'#f0ca55'}
].map((crop)=>{const stages=['radish','corn'].includes(crop.id)?[0,15,45,75,100]:[0,20,65,100];return {id:crop.id,name:crop.name,minutes:crop.minutes,color:crop.color,unlockLevelIds:[],enabled:true,stages,atlas:{fileID:FARM_BASE+crop.id+'-stages.png',columns:stages.length,rows:1,frameSize:256,anchorX:.5,anchorY:.75}}})
const cropById=(id,crops=CROPS)=>crops.find((c)=>c.id===id)
function growthStage(crop,progress) {
  const stages=crop&&crop.stages||[0,20,65,100]
  let frame=0
  for(let i=1;i<stages.length;i++)if(progress>=stages[i])frame=i
  return frame
}
const TILE_SIZE=3.5
const {yardLayout}=require('./yard-layout')
const {buildingGeometryKey}=require('./plot-buildings')
const layoutCache=new Map(),layoutIndexes=new WeakMap()
function farmLayout(plot) {
  const key=JSON.stringify([buildingGeometryKey(plot),plot.buildingType])
  if(layoutCache.has(key))return layoutCache.get(key)
  const half=(plot.size||112)/2, count=Math.floor((half*2-4)/TILE_SIZE)
  const startX=plot.x-count*TILE_SIZE/2+TILE_SIZE/2, startZ=plot.z-count*TILE_SIZE/2+TILE_SIZE/2
  const pure=plot.buildingType==='yard'
  const blocks=yardLayout(plot).sprites.filter((p)=>p.radius>0)
  const tiles=[]
  for(let z=0;z<count;z++)for(let x=0;x<count;x++) {
    const tile={id:z*count+x,x:startX+x*TILE_SIZE,z:startZ+z*TILE_SIZE,size:TILE_SIZE}
    if(blocks.some((p)=>Math.abs(p.x-tile.x)<p.radius+TILE_SIZE/2+.5&&Math.abs(p.z-tile.z)<p.radius+TILE_SIZE/2+.5))continue
    // Keep the house entrance, fountain, bowls and garage approaches open.
    if(!pure&&Math.abs(tile.x-plot.x)<3&&tile.z>=plot.z-2)continue
    tiles.push(tile)
  }
  if(layoutCache.size>=128)layoutCache.delete(layoutCache.keys().next().value)
  layoutCache.set(key,tiles)
  return tiles
}
function savedBeds(plot) {
  const tiles=farmLayout(plot)
  if(!layoutIndexes.has(tiles))layoutIndexes.set(tiles,new Map(tiles.map((t)=>[t.id,t])))
  const byId=layoutIndexes.get(tiles)
  const beds={}
  for(const bed of plot.farmBeds||[]) {
    let tile=byId.get(bed.id)
    if(plot.gardenVersion!==2) {
      const scale=Math.min(1,(plot.size||112)/112)
      const x=plot.x+(10+bed.id%4*5)*scale,z=plot.z+(-27+Math.floor(bed.id/4)*6)*scale
      tile=tiles.filter((t)=>!beds[t.id]).sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z))[0]
    }
    if(tile)beds[tile.id]={...bed,id:tile.id,stage:bed.stage||(bed.watered?'watered':'tilled')}
  }
  return beds
}
// Reach one individual plot; adjacent plots must not share a remote action.
const bedReach=(tile)=>Math.max(1.8,tile.size*.8)
function bedView(bed,stamp,crops=CROPS) {
  if(!bed)return {state:'grass',label:'草坪',progress:0}
  if(!bed.cropId)return {...bed,state:bed.stage==='soil'?'soil':'empty',label:bed.stage==='soil'?'耕地':bed.stage==='watered'?'已浇水':'已开垦',progress:0}
  const crop=cropById(bed.cropId,crops)||bed.crop,duration=bed.readyAt-bed.plantedAt
  const progress=Math.max(0,Math.min(100,(stamp-bed.plantedAt)/Math.max(1,duration)*100))
  const defaultLabel=stamp>=bed.readyAt?'成熟展示':progress<20?'萌芽':progress<65?'生长中':'即将成熟'
  return {...bed,state:stamp>=bed.readyAt?'ready':'growing',label:defaultLabel,
    name:crop?crop.name:'作物',color:crop?crop.color:'#7ca557',progress:Math.floor(progress),remaining:Math.max(0,Math.ceil((bed.readyAt-stamp)/1000)),boosted:false}
}
module.exports={CROPS,SOILS,FARM_BASE,TILE_SIZE,cropById,growthStage,farmLayout,savedBeds,bedReach,bedView}
