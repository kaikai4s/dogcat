const test=require('node:test')
const assert=require('node:assert/strict')
const {World2D}=require('../../miniprogram/packagePlayground/utils/world2d')
test('any nearby own or neighbor pet offers care history without granting control of a neighbor pet',()=>{
  const plot={id:'villa',x:280,z:280,size:48,gateDirection:'south',buildingType:'residential',staffCard:{id:'staff-profile',label:'认证宠托师'}}
  const world={character:{position:{x:280,z:306}},characterTerrain:{},isMapOverview:()=>false,characterAreaLoaded:()=>true,
    characterNavigation:()=>({clearSegment:()=>true}),pets:[{id:'neighbor-pet',name:'邻居的猫',mine:false,position:{x:281,z:306}}],
    plots:()=>[plot],remoteCharacters:[],canEnterPlot:()=>false,selectedPetId:'',groundDecals:[]}
  let nearby=World2D.prototype.nearbyInteractions.call(world)
  assert.deepEqual(nearby.carePet,{id:'neighbor-pet',name:'邻居的猫'})
  assert.equal(nearby.pet,null)
  assert.deepEqual(nearby.sitter,{id:'staff-profile',label:'认证宠托师'})
  world.pets[0].mine=true
  nearby=World2D.prototype.nearbyInteractions.call(world)
  assert.ok(nearby.carePet)
  world.character.position={x:500,z:500}
  nearby=World2D.prototype.nearbyInteractions.call(world)
  assert.ok(!nearby.carePet&&!nearby.sitter)
})
