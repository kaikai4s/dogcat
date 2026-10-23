const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {World2D}=require('../../miniprogram/packagePlayground/utils/world2d')

function makeWorld(extra={}) {
  const page={data:{},setData(v){Object.assign(this.data,v)},fetchRegion:async()=>({plots:[]}),
    rememberZoom(zoom){this.sceneZoom=zoom}}
  const w=new World2D(page,null,{world:{width:1120,height:1120},plot:{id:'mine',mine:true,x:280,z:280,size:112},
    pets:[{_id:'cat',species:'cat',name:'团团'},{_id:'dog',species:'dog',name:'豆豆'}],...extra},(pets)=>{
      page.data.selectedPetId=(pets.find((p)=>p.selected)||{}).id||''
    })
  w.buildWorld()
  w.prepareCharacterArea=async()=>{}
  w.loadVisible=async()=>{}
  return w
}
function tapPet(w,pet) {
  const point=w.project(pet.position.x,pet.position.z)
  const touch={x:point.x,y:point.y-8,identifier:1}
  w.touchStart([touch]);w.touchEnd([touch])
}
function pageFixture(storage={},callFunction=async()=>({})) {
  let page
  const toasts=[]
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/pages/world.js'),'utf8'),{
    Page(p){page=p},setTimeout,clearTimeout,
    require:(name)=>name.includes('utils/cloud')?{callFunction,chooseSelectedLocation:async()=>({name:'新小区',address:'新地址',latitude:1,longitude:2})}:{},
    wx:{getStorageSync:(key)=>storage[key],setStorageSync:(key,value)=>{storage[key]=value},
      getWindowInfo:()=>({windowHeight:800,screenHeight:800,safeArea:{bottom:780}}),
      getMenuButtonBoundingClientRect:()=>({bottom:40}),showToast:(v)=>toasts.push(v),
      showModal:(v)=>v.success({confirm:true})}
  })
  page.setData=(v,done)=>{Object.assign(page.data,v);if(done)done()}
  page.world=makeWorld()
  page.data.loading=false
  page.data.hasAvatar=true
  page.onLoad()
  return {page,storage,toasts}
}

test('pet taps select, map taps command repeatedly, and switching or gestures replace the selection',()=>{
  const w=makeWorld()
  assert.equal(w.selectedPet(),undefined)
  tapPet(w,w.pets[0])
  assert.equal(w.selectedPetId,'cat')
  tapPet(w,w.pets[1])
  assert.equal(w.selectedPetId,'dog')
  assert.equal(w.page.data.selectedPetId,'dog')
  let moves=0
  w.moveTo=()=>{moves++}
  w.touchStart([{x:10,y:10}]);w.touchEnd([{x:10,y:10}])
  assert.equal(w.selectedPetId,'dog')
  assert.equal(moves,1)
  w.touchStart([{x:20,y:10}]);w.touchEnd([{x:20,y:10}])
  assert.equal(w.selectedPetId,'dog')
  assert.equal(moves,2)
  for(const pinch of [false,true]) {
    tapPet(w,w.pets[0])
    const touches=pinch?[{x:20,y:20},{x:120,y:20}]:[{x:20,y:20}]
    w.touchStart(touches)
    if(!pinch)w.touchMove([{x:45,y:20}])
    assert.equal(w.selectedPetId,pinch?'':'cat')
    w.touchEnd([{x:45,y:20}])
    assert.equal(moves,2)
  }
})

test('only a selected own pet responds to map taps without an extra move button',()=>{
  const w=makeWorld()
  let destination
  w.moveTo=(p)=>{destination=p}
  const target=w.project(240,260)
  w.touchStart([target]);w.touchEnd([target])
  assert.equal(destination,undefined)
  const neighbor={...w.pets[0],id:'other',mine:false,position:{x:300,z:300}}
  w.pets.push(neighbor)
  tapPet(w,neighbor)
  assert.equal(w.selectedPetId,'')
  tapPet(w,w.pets[0])
  w.touchStart([target]);w.touchEnd([target])
  assert.ok(Math.abs(destination.x-240)<1e-8)
  assert.equal(w.selectedPetId,'cat')
  tapPet(w,neighbor)
  assert.equal(w.selectedPetId,'')
})

test('character only accepts map movement while selected and menu expansion cancels all selection',()=>{
  const {page}=pageFixture(),w=page.world
  let moves=0
  w.moveCharacterTo=()=>{moves++}
  const target=w.project(240,260)
  const tap=()=>{w.touchStart([target]);w.touchEnd([target])}
  tap();assert.equal(moves,0)
  w.selectCharacter();tap();tap()
  assert.equal(moves,2)
  w.clearPetSelection();tap()
  assert.equal(moves,2)
  w.selectCharacter()
  w.touchStart([{x:20,y:20},{x:120,y:20}]);w.touchEnd([{x:20,y:20}])
  tap();assert.equal(moves,2)
  const collapsed=page.data.menuCollapsed
  w.selectCharacter();page.toggleMenuCollapse()
  assert.equal(page.data.menuCollapsed,!collapsed)
  assert.equal(w.characterSelected,false)
  tap();assert.equal(moves,2)
  w.selectPet('cat');page.toggleMenuCollapse()
  assert.equal(w.selectedPetId,'')
  assert.equal(page.data.menuCollapsed,collapsed)
})

test('character taps select exclusively, repeated map taps run, and panning through page controls preserves the route',async()=>{
  const {page}=pageFixture()
  const w=page.world
  w.page=page
  page.fetchRegion=async()=>({plots:[]})
  w.character.position={x:350,z:350}
  w.prepareCharacterArea=World2D.prototype.prepareCharacterArea
  const point=w.project(350,350),touch={x:point.x,y:point.y-8,identifier:1}
  w.selectPet('cat')
  page.touchStart({touches:[touch]});page.touchEnd({touches:[],changedTouches:[touch]})
  assert.equal(w.selectedPetId,'')
  assert.equal(page.data.characterSelected,true)
  const move=w.moveCharacterTo.bind(w)
  let movement
  w.moveCharacterTo=(target)=>{movement=move(target);return movement}
  const target=w.project(365,360)
  page.touchStart({touches:[target]});page.touchEnd({touches:[],changedTouches:[target]})
  await movement
  assert.ok(w.characterRoute)
  const route=w.characterRoute
  page.touchStart({touches:[{x:20,y:20}]})
  page.touchMove({touches:[{x:60,y:20}]})
  page.touchEnd({touches:[],changedTouches:[{x:60,y:20}]})
  assert.equal(w.characterRoute,route)
  assert.equal(w.characterSelected,true)
  await w.prepareCharacterArea()
  const start = {...w.character.position}
  w.updateCharacter(.05)
  assert.equal(w.character.runRequested,true)
  assert.ok(Math.abs(Math.hypot(w.character.position.x-start.x,w.character.position.z-start.z)-14*.05)<1e-8)
  assert.equal(w.sceneState().running,true)
  for(let i=0;i<100 && w.characterRoute;i++) {w.update(.05);await Promise.resolve()}
  assert.ok(Math.hypot(w.character.position.x-365,w.character.position.z-360)<.2)
  assert.equal(w.character.moving,false)
  assert.equal(w.character.runRequested,false)
  await w.moveCharacterTo({x:367,z:360})
  assert.ok(w.characterRoute)
  assert.equal(w.characterTarget.x,367)
  w.setCharacterInput(.8,0)
  assert.equal(w.characterSelected,false)
  assert.equal(w.characterRoute,null)
})

test('click run follows short waypoints without overshooting a turn or its destination',()=>{
  const w=makeWorld()
  w.character.position={x:350,z:350}
  w.characterTerrain={minX:0,minZ:0,maxX:1120,maxZ:1120}
  w.characterAreaLoaded=()=>true
  w.characterNavigation=()=>({clearSegment:()=>true})
  w.characterRoute=[{x:350.3,z:350},{x:350.3,z:352}]
  w.updateCharacter(.05)
  assert.ok(Math.abs(w.character.position.x-350.3)<1e-8)
  assert.ok(Math.abs(w.character.position.z-350)<1e-8)
  assert.equal(w.character.runRequested,true)
  for(let i=0;i<10;i++)w.updateCharacter(.05)
  assert.ok(Math.hypot(w.character.position.x-350.3,w.character.position.z-352)<1e-8)
  assert.equal(w.characterRoute,null)
  assert.equal(w.character.moving,false)
  assert.equal(w.character.runRequested,false)
})

test('roof taps select building info before movement and blank taps, controls or demolition dismiss it',async()=>{
  const {page}=pageFixture(),w=page.world
  w.page=page
  w.character.position={x:350,z:350}
  const plot={id:'repair',x:410,z:380,size:48,mine:true,isNewPlot:true,buildingId:'repair',buildingType:'repair_shop',buildingName:'社区修理厂',buildingWidth:10,buildingDepth:10,buildingImage:'cloud://repair'}
  w.sharedPlots.set(plot.id,plot)
  w.buildingImage=()=>({width:100,height:200})
  const origin=w.project(plot.x,plot.z)
  // 点击屋顶：该点投影到地面后并不位于建筑的占地范围。
  const roof={x:origin.x,y:origin.y-100}
  let moves=0
  w.moveCharacterTo=()=>{moves++}
  const tap=(point)=>{w.touchStart([point]);w.touchEnd([point])}
  w.selectCharacter()
  tap(roof)
  assert.equal(moves,0)
  assert.equal(w.characterSelected,true)
  assert.equal(page.data.selectedBuildingInfo.name,plot.buildingName)
  page.closeBuildingInfo()
  assert.equal(page.data.selectedBuildingInfo,null)
  tap(roof)
  tap(w.project(500,500))
  assert.equal(page.data.selectedBuildingInfo,null)
  tap(roof)
  w.selectCharacter()
  assert.equal(page.data.selectedBuildingInfo,null)
  tap(roof)
  page.openSettings()
  assert.equal(page.data.selectedBuildingInfo,null)
  tap(roof)
  await w.applySceneRecords([])
  assert.equal(page.data.selectedBuildingInfo,null)
})

test('shared scene refreshes retain character selection and a newer character destination replaces pending planning',async()=>{
  const w=makeWorld({scene:{hasAvatar:true,serverTime:Date.now(),position:{x:350,z:350}}})
  w.selectCharacter()
  const pending=[]
  w.loadNavigationArea=()=>new Promise((resolve)=>pending.push(resolve))
  const first=w.moveCharacterTo({x:365,z:350})
  const second=w.moveCharacterTo({x:370,z:350})
  pending[1]();await second
  pending[0]();await first
  assert.equal(w.characterTarget.x,370)
  assert.equal(w.characterRoute.at(-1).x,370)
  await w.applySceneRecords([])
  assert.equal(w.characterSelected,true)
  assert.equal(w.characterTarget.x,370)
})

test('opening hospital info preserves the chosen pet instead of silently switching to the first pet',async()=>{
  const calls=[]
  const {page}=pageFixture({},async(module,action,data)=>{calls.push({module,action,data});return {}}),w=page.world
  w.page=page
  w.onPetsChange=(pets)=>{
    page.data.pets=pets
    page.data.selectedPet=pets.find((p)=>p.selected)||null
  }
  w.selectPet('dog')
  w.selectBuilding({plotId:'hospital',type:'pet_hospital',name:'爱心宠物医院'})
  await page.hospitalCareAction({currentTarget:{dataset:{type:'treat'}}})
  assert.equal(calls.find((c)=>c.action==='hospitalCare').data.petId,'dog')
  assert.equal(w.selectedPetId,'dog')
})

test('building clicks during driving open info while preserving the selected vehicle',()=>{
  const w=makeWorld()
  w.drivingVehicleId='car';w.selectedVehicleId='car'
  w.sharedPlots.set('repair',{id:'repair',x:410,z:380,size:48,buildingType:'repair_shop'})
  w.vehicleAt=()=>null
  w.buildingAt=()=>({plotId:'repair',name:'社区修理厂',type:'repair_shop'})
  let moves=0
  w.moveCharacterTo=()=>{moves++}
  const point=w.project(400,400)
  w.touchStart([point]);w.touchEnd([point])
  assert.equal(w.page.data.selectedBuildingInfo.plotId,'repair')
  assert.equal(w.selectedVehicleId,'car')
  assert.equal(moves,0)
})

test('an injured character uses walking speed until recovery, including during click navigation',()=>{
  const w=makeWorld()
  w.character.position={x:350,z:350}
  w.characterTerrain={minX:0,minZ:0,maxX:1120,maxZ:1120};w.characterAreaLoaded=()=>true
  w.characterNavigation=()=>({clearSegment:()=>true})
  w.characterRoute=[{x:360,z:350}]
  w.character.injured=true
  w.updateCharacter(.05)
  assert.ok(Math.abs(w.character.position.x-350-7*.05)<1e-8)
  assert.equal(w.character.runRequested,false)
  w.character.injured=false
  const before=w.character.position.x
  w.updateCharacter(.05)
  assert.ok(Math.abs(w.character.position.x-before-14*.05)<1e-8)
  assert.equal(w.character.runRequested,true)
})

test('a selected nearby building keeps its service buttons when an adjacent plot center is closer',()=>{
  const w=makeWorld()
  w.character.position={x:327,z:400}
  w.characterTerrain={};w.characterAreaLoaded=()=>true
  w.characterNavigation=()=>({clearSegment:()=>true})
  const closer={id:'empty',x:300,z:400,size:48,mine:true,buildingType:'yard'}
  const selected={id:'hospital',x:356,z:400,size:48,mine:true,isNewPlot:true,buildingType:'pet_hospital'}
  w.sharedPlots.set(closer.id,closer);w.sharedPlots.set(selected.id,selected)
  w.selectBuilding(w.buildingInfoFor(selected))
  assert.equal(w.nearbyInteractions().building.plotId,selected.id)
})

test('transparent image padding does not intercept a click on the grass behind a building',()=>{
  const previousWx=global.wx,w=makeWorld()
  const plot={id:'repair',x:410,z:380,size:48,buildingId:'repair',buildingType:'repair_shop',buildingImage:'cloud://repair',buildingWidth:10,buildingDepth:10}
  w.sharedPlots.set(plot.id,plot)
  w.buildingImage=()=>image
  const image={width:100,height:100},origin=w.project(plot.x,plot.z)
  let reads=0
  global.wx={createOffscreenCanvas({width,height}){return {getContext:()=>({
    drawImage(){},getImageData(){
      reads++
      const data=new Uint8ClampedArray(width*height*4)
      for(let y=0;y<height;y++)for(let x=Math.floor(width/4);x<width*3/4;x++)data[(y*width+x)*4+3]=255
      return {data}
    }
  })}}}
  try {
    assert.equal(w.buildingAt({x:origin.x-38,y:origin.y-20}),null)
    assert.equal(w.buildingAt({x:origin.x,y:origin.y-20}).plotId,plot.id)
    assert.equal(reads,1)
  } finally {if(previousWx===undefined)delete global.wx;else global.wx=previousWx}
})

test('click movement cannot enter an unapproved yard and settings remove character selection',async()=>{
  const {page}=pageFixture()
  const w=page.world
  w.scene={}
  w.character.position={x:360,z:500}
  w.sharedPlots.set('neighbor',{id:'neighbor',ownerId:'other',x:400,z:500,size:48})
  w.selectCharacter()
  await w.moveCharacterTo({x:400,z:500})
  assert.equal(w.characterRoute,null)
  assert.equal(w.characterTarget,null)
  page.openSettings()
  assert.equal(w.characterSelected,false)
  assert.equal(page.data.characterSelected,false)
})

test('shared pet target marker appears immediately, follows the latest tap and survives server updates',async()=>{
  const w=makeWorld({scene:{hasAvatar:true,position:{x:280,z:280},serverTime:Date.now()}})
  const pending=[]
  w.sceneSync={movePet:(id,target)=>new Promise((resolve,reject)=>pending.push({id,target,resolve,reject}))}
  tapPet(w,w.pets[0])
  const commands=[w.moveTo({x:240,z:260}),w.moveTo({x:250,z:265})]
  assert.equal(w.selectedPetId,'cat')
  assert.equal(w.petTarget.x,250)
  assert.equal(w.petTarget.pending,true)
  const labels=[]
  w.ctx={save(){},restore(){},beginPath(){},ellipse(){},fill(){},stroke(){},moveTo(){},lineTo(){},setLineDash(){}}
  w.markerLabel=(label)=>labels.push(label)
  w.drawDestination()
  assert.equal(labels.pop(),'规划路线…')
  pending[1].resolve();await commands[1]
  pending[0].reject(new Error('旧指令失败'));await commands[0]
  assert.equal(w.petTarget.x,250)
  assert.equal(w.petTarget.pending,false)
  const pet=w.selectedPet()
  w.applySharedPet({id:pet.id,name:pet.name,species:pet.species,modelScale:1,
    motion:{epoch:Date.now(),approach:[{x:250,z:265}],patrol:[{x:250,z:265}]}},true)
  w.drawDestination()
  assert.equal(labels.pop(),'已到达')
  assert.equal(w.petTarget.x,250)
  tapPet(w,w.pets[1])
  assert.equal(w.petTarget,null)
  assert.equal(w.selectedPetId,'dog')
  const last=w.moveTo({x:245,z:260})
  w.clearPetSelection()
  pending[2].resolve();await last
  assert.equal(w.petTarget,null)
  assert.equal(w.selectedPetId,'')
})

test('manual zoom survives movement, view actions, resizing, placement and a reconstructed scene',()=>{
  const w=makeWorld()
  w.touchStart([{x:0,y:100},{x:100,y:100}])
  w.touchMove([{x:25,y:100},{x:75,y:100}])
  const zoom=w.zoom
  assert.equal(zoom,.5)
  assert.equal(w.page.sceneZoom,zoom)
  for(const action of [()=>w.focusCharacter(),()=>w.setCharacterInput(.5,0),()=>w.overview(),()=>w.fullOverview(),
    ()=>w.resize(900,400),()=>w.beginPlacement(),()=>w.cancelPlacement(),()=>w.setPlot({id:'new',mine:true,x:500,z:500,size:112})]) {
    action();assert.equal(w.zoom,zoom)
  }
  const rebuilt=new World2D(w.page,null,{plot:w.ownPlot})
  rebuilt.resize(375,800)
  assert.equal(rebuilt.zoom,zoom)
})

test('unplaced scene has no avatar or pets, can synchronize and choose a plot independently of profiles',async()=>{
  const w=makeWorld({plot:null,scene:{hasAvatar:false,position:{x:100,z:100},serverTime:Date.now()}})
  assert.equal(w.character,null)
  assert.equal(w.pets.length,0)
  assert.equal(w.overviewData.pets.length,2)
  assert.deepEqual(w.sceneState().trail,[])
  assert.equal(w.sceneState().position,undefined)
  w.beginPlacement()
  await w.pickPlot({x:280,z:280})
  assert.ok(w.candidate)
})

test('resident count uses occupied yards and the owner nickname setting applies to every yard',async()=>{
  const w=makeWorld({scene:{hasAvatar:true,serverTime:Date.now(),position:{x:280,z:280}}})
  const plots=[{kind:'plot',id:'mine',ownerId:'owner-me',mine:true,x:280,z:280,size:112,ownerName:'小明'},
    {kind:'plot',id:'other',ownerId:'owner-other',mine:false,x:500,z:500,size:112,name:'小红的庭院'}]
  await w.applySceneRecords(plots)
  assert.equal(w.page.data.residentCount,2)
  const labels=[]
  w.ctx={save(){},restore(){}}
  w.markerLabel=(text)=>labels.push(text)
  const bounds={minX:0,maxX:1120,minZ:0,maxZ:1120}
  w.drawYardOwners(bounds)
  assert.deepEqual(labels,[])
  w.page.data.showYardOwners=true
  w.drawYardOwners(bounds)
  assert.deepEqual(labels,['小明','小红'])
  await w.applySceneRecords(plots.slice(1))
  assert.equal(w.page.data.residentCount,1)
})

test('resident count deduplicates actual primary homes including offline owners and ignores extra land and visitors',async()=>{
  const w=makeWorld({scene:{hasAvatar:true,serverTime:Date.now(),position:{x:280,z:280}}})
  const home={kind:'plot',id:'mine',ownerId:'owner-me',mine:true,x:280,z:280,size:112,buildingType:'residential',isResidence:true}
  const neighbors=Array.from({length:205},(_,i)=>({...home,id:'home-'+i,ownerId:'owner-'+i,mine:false,x:800,z:800}))
  const extras=[
    {...home,id:'legacy-duplicate'},
    {...home,id:'extra-yard',isNewPlot:true,buildingType:'yard'},
    {...home,id:'extra-villa',isNewPlot:true},
    {...home,id:'cabin',buildingType:'wood_cabin'},
    {...home,id:'public',buildingType:'shop'},
    {...home,id:'demolished',ownerId:'removed-owner',demolished:true},
    {...home,id:'inactive',ownerId:'inactive-owner',isResidence:false},
    {...home,id:'unowned',ownerId:'',mine:false},
    {kind:'presence',id:'visitor',ownerId:'visitor',position:{x:100,z:100},online:true},
    {kind:'resident',id:'pet-owner',ownerId:'pet-owner',pets:[],careAgents:[{id:'sitter'}]}
  ]
  await w.applySceneRecords([home,...neighbors,...extras])
  assert.equal(w.page.data.residentCount,206)
  assert.equal(w.ownPlot.id,'mine')
  assert.equal(w.sharedPlots.has('demolished'),false)
  await w.applySceneRecords([...neighbors,...extras.filter((p)=>p.ownerId!=='owner-me')])
  assert.equal(w.page.data.residentCount,205)
  assert.equal(w.page.data.hasPlot,false)
  await w.applySceneRecords(extras.filter((p)=>p.isNewPlot))
  assert.equal(w.page.data.residentCount,0)
  assert.equal(w.page.data.hasPlot,false)
})

test('joystick defaults to always visible, stops on release and does not swallow the next map tap',()=>{
  const {page}=pageFixture()
  assert.equal(page.data.joystickMode,'always')
  assert.equal(page.data.joystickHand,'left')
  assert.equal(page.data.joystickOpacity,100)
  assert.equal(page.data.showYardOwners,false)
  const touch={identifier:2,clientX:page.data.joystickLeft+72,clientY:page.data.joystickTop+72}
  page.fixedJoystickStart({touches:[touch]})
  page.fixedJoystickMove({touches:[{...touch,clientX:touch.clientX+48}]})
  assert.equal(page.world.character.runRequested,true)
  page.fixedJoystickEnd()
  assert.equal(page.world.character.input.x,0)
  let taps=0
  page.world.touchEnd=()=>{taps++}
  page.touchStart({touches:[touch]})
  assert.equal(page.joystickTimer,null)
  page.touchEnd({touches:[],changedTouches:[touch]})
  assert.equal(taps,1)
})

test('left and right joystick choices anchor to screen edges, stop current input and persist',()=>{
  const {page,storage}=pageFixture()
  assert.equal(page.data.joystickLeft,20)
  const touch={identifier:7,clientX:page.data.joystickLeft+72,clientY:page.data.joystickTop+72}
  page.fixedJoystickStart({touches:[touch]})
  page.fixedJoystickMove({touches:[{...touch,clientX:touch.clientX+45}]})
  assert.notEqual(page.world.character.input.x,0)
  page.changeJoystickHand({currentTarget:{dataset:{hand:'right'}}})
  assert.equal(page.world.character.input.x,0)
  assert.equal(page.data.joystickHand,'right')
  assert.equal(page.data.joystickLeft+144,375-20)
  const restored=pageFixture(storage).page
  assert.equal(restored.data.joystickHand,'right')
  assert.equal(restored.data.joystickLeft,page.data.joystickLeft)
  restored.windowWidth=820
  restored.joystickInsetRight=40
  restored.positionJoystick()
  assert.equal(restored.data.joystickLeft+144,780)
  restored.changeJoystickHand({currentTarget:{dataset:{hand:'left'}}})
  assert.equal(restored.data.joystickLeft,20)
})

test('page connection status is updated independently and clears after realtime recovery',async()=>{
  let page,notify
  class FakeWorld {
    init(){return Promise.resolve()}
    setCharacterInput(){}
    destroy(){this.destroyed=true}
  }
  class FakeSync {
    constructor(world,scene,onError,onConnection){notify=onConnection}
    snapshot(){return Promise.resolve()}
    start(){notify({message:'场景连接中断，正在重连',envId:'cloud1-test',scene:'连接中',mail:'已连接',details:'network error'})}
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/pages/world.js'),'utf8'),{
    Page(p){page=p},setTimeout,clearTimeout,wx:{},
    require:(name)=>name.includes('utils/cloud')?{callFunction:async()=>({scene:{},world:{width:1120,height:1120}})}:
      name.includes('scene-sync')?{SceneSync:FakeSync}:{World2D:FakeWorld}
  })
  page.setData=(data,done)=>{Object.assign(page.data,data);if(done)done()}
  page.visible=true
  page.initialize()
  await new Promise((resolve)=>setImmediate(resolve))
  assert.equal(page.data.loading,false)
  assert.equal(page.data.syncEnvId,undefined)
  assert.match(page.data.connectionMessage,/重连/)
  notify({message:'',envId:'cloud1-test',scene:'已连接',mail:'已连接',details:''})
  assert.equal(page.data.connectionMessage,'')
  assert.equal(page.data.syncDetails,undefined)
  assert.equal(page.data.syncSceneState,'已连接')
})

test('control preferences and manual zoom persist; opening settings or controlling the character cancels pet selection',()=>{
  const {page,storage}=pageFixture()
  page.world.selectPet('cat')
  page.openSettings()
  assert.equal(page.world.selectedPetId,'')
  assert.equal(page.data.settingsOpen,true)
  page.changeJoystickMode({detail:{value:true}})
  page.changeJoystickOpacity({detail:{value:35}})
  page.changeYardOwners({detail:{value:true}})
  page.rememberZoom(.27)
  const restored=pageFixture(storage).page
  assert.equal(restored.data.joystickMode,'hold')
  assert.equal(restored.data.joystickOpacity,35)
  assert.equal(restored.data.showYardOwners,true)
  assert.equal(restored.sceneZoom,.27)
  page.world.selectPet('dog')
  page.world.setCharacterInput(.5,0)
  assert.equal(page.world.selectedPetId,'')
})

test('choosing a new community after demolition starts placement without requiring scene pets',async()=>{
  const calls=[]
  const {page,toasts}=pageFixture({},async(module,action,data)=>{calls.push({action,data});return {}})
  page.world=makeWorld({plot:null,scene:{hasAvatar:false,serverTime:Date.now()}})
  page.data.hasAvatar=false
  page.selectComponent=()=>({open:async()=>({name:'新小区',address:'新地址',latitude:1,longitude:2})})
  let initialized=0
  page.initialize=()=>{initialized++}
  await page.chooseCommunityAndBuild()
  assert.equal(calls[0].action,'saveCommunity')
  assert.equal(calls[0].data.community.name,'新小区')
  assert.equal(page.placeAfterLoad,true)
  assert.equal(page.selectedCommunity,null)
  assert.equal(initialized,1)
  assert.equal(toasts.length,0)
})


test('wash action sends scene credentials and clears dirt only after server acknowledgement',async()=>{
  const packets=[];let fail=true,cleaned=0,sent=0
  const {page}=pageFixture({},async(module,action,data)=>{
    packets.push({module,action,data});assert.equal(cleaned,0)
    if(fail)throw new Error('请将车辆开到洗车店附近')
    return {washed:true,message:'洗车完成'}
  })
  const w=page.world,car={id:'car'}
  w.ownVehicle=()=>car;w.cleanVehicle=()=>{cleaned++}
  w.sceneSync={send:async()=>{sent++},credentials:()=>({sceneId:'scene',session:'session'})}
  await page.cleanVehicleAction()
  assert.equal(cleaned,0);assert.equal(page.data.washingVehicle,false)
  fail=false;await page.cleanVehicleAction()
  assert.equal(sent,2);assert.equal(cleaned,1)
  assert.equal(packets[1].action,'washVehicle');assert.equal(packets[1].data.vehicleId,'car')
  assert.equal(packets[1].data.session,'session');assert.equal(packets[1].data.sceneId,'scene')
})

test('plot placement tap keeps the main courtyard mode, and new land selects an unlocked membership size',()=>{
  const {page}=pageFixture(),placements=[]
  page.data.hasPlot=true;page.data.hasCommunity=true
  page.data.plotSizes=[{size:48,unlocked:false},{size:64,unlocked:true}]
  page.world.beginPlacement=(isNew,size)=>placements.push({isNew,size})
  page.choosePlot({currentTarget:{dataset:{}}})
  assert.equal(placements[0].isNew,false)
  page.choosePlot(true)
  assert.equal(placements[1].isNew,true);assert.equal(placements[1].size,64)
})
