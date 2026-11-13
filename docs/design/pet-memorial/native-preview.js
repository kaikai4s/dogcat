(async () => {
 const kind=new URLSearchParams(location.search).get('page')||'garden';
 const [sources,modules]=await Promise.all([fetch(kind+'-sources.json').then(r=>r.json()),fetch('modules.json').then(r=>r.json())]);
 const portraitDemoMode=new URLSearchParams(location.search).get('portraitDemo')==='1';
 const demoArt=await fetch('portrait-demo.json').then(r=>r.json()).catch(()=>null);
 const app=document.getElementById('app'), template=document.createElement('template'), cache={}; let page,canvas,rendering=false;
 template.innerHTML=sources.wxml.replace(/<template([^>]*?)\s*\/>/g,'<template$1></template>').replace(/<video([^>]*?)\s*\/>/g,'<video$1></video>').replace(/<textarea([^>]*?)\s*\/>/g,'<textarea$1></textarea>').replace(/<image([^>]*?)\s*\/>/g,'<img$1>').replace(/<switch([^>]*?)\s*\/>/g,'<input type=checkbox$1>');
 const evaluate=(value,scope)=>{try{return Function('s','with(s){return ('+value+')}')(scope)}catch(e){return undefined}};
 const interpolate=(value,scope)=>String(value).replace(/{{([\s\S]*?)}}/g,(_,code)=>evaluate(code,scope)??'');
 const truth=(value,scope)=>evaluate(String(value).replace(/^{{|}}$/g,''),scope);
 function render(){
  if(!page||rendering)return; rendering=true;
  function children(source,target,scope){let matched=false;
   for(const node of source.childNodes){
    if(node.nodeType===3){target.append(document.createTextNode(interpolate(node.textContent,scope)));continue}
    if(node.nodeType!==1)continue;
    if(node.hasAttribute('wx:if')){matched=!!truth(node.getAttribute('wx:if'),scope);if(!matched)continue}
    else if(node.hasAttribute('wx:elif')){if(matched)continue;matched=!!truth(node.getAttribute('wx:elif'),scope);if(!matched)continue}
    else if(node.hasAttribute('wx:else')){if(matched)continue;matched=true}
    else matched=false;
    if(node.hasAttribute('wx:for')){const rows=truth(node.getAttribute('wx:for'),scope)||[]; rows.forEach((item,index)=>{const copy=node.cloneNode(true);copy.removeAttribute('wx:for');const host=document.createElement('template');host.content.append(copy);children(host.content,target,{...scope,[node.getAttribute('wx:for-item')||'item']:item,index})});continue}
    if(node.tagName==='TEMPLATE') {
      if(node.hasAttribute('is')) { const def=template.content.querySelector('template[name="'+node.getAttribute('is')+'"]'); const data=evaluate('({'+node.getAttribute('data').replace(/^{{|}}$/g,'')+'})',scope); if(def)children(def.content,target,{...scope,...data}); }
      continue;
    }
    const el=node.tagName==='CANVAS'&&canvas?canvas:document.createElement(node.tagName.toLowerCase());
    for(const attr of node.attributes){if(attr.name.startsWith('wx:'))continue;
     if(attr.name==='disabled'||attr.name==='checked'){if(truth(attr.value,scope))el.setAttribute(attr.name,'');else el.removeAttribute(attr.name);continue}
     if(/^(bind|catch)/.test(attr.name)){
      const eventName=attr.name.replace(/^(bind|catch)/,'');
      if(['tap','input','change','load','play','pause','ended','error'].includes(eventName))el['on'+({tap:'click'}[eventName]||eventName)]=event=>{event.stopPropagation();page[attr.value]({currentTarget:el,detail:{value:el.type==='checkbox'?el.checked:el.value}})};
      continue
     }
     el.setAttribute(attr.name,interpolate(attr.value,scope));
     if(attr.name==='value' && ['INPUT','TEXTAREA'].includes(el.tagName))el.value=interpolate(attr.value,scope);
    }
    if(el.tagName!=='CANVAS')children(node,el,scope);
    target.append(el);
   }
  }
  const fragment=document.createDocumentFragment(); children(template.content,fragment,page.data);app.replaceChildren(fragment);
  rendering=false;
 }
 const previewGarden={id:'garden-ortho-v2',name:'时光纪念园',template:'garden-ortho-v2',accepting:true,revision:0}; const extraGarden={...previewGarden,id:'garden_'+'1'.repeat(32),name:'星光陪伴园'};
 const sample={gardenId:previewGarden.id,gardenName:previewGarden.name,ownerOpenid:'preview-owner',_id:'demo-application',petName:'小白',epitaph:'谢谢你陪我走过的每一个春天。\n愿这里永远有阳光，有你喜欢的风。',applicant:'小白的家人',date:'2026-10-18',plotId:'garden-ortho-v2:23:21',lawn:'静思苑2',status:'approved',createdAt:'2026-11-12T02:30:00Z'};
 // Local two-tab transport only; this does not connect to a deployed CloudBase room.
 const visitorId='preview_'+Math.random().toString(36).slice(2), presenceKey='memorial-preview-presence:', listeners=new Set();
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('memorial-preview-presence'):null;
 let presenceSession='',presenceSeq=0,presenceEpoch=0;
 const presenceDelay=Math.min(2000,Math.max(0,Number(new URLSearchParams(location.search).get('presenceDelay'))||0));
 function presenceDocs(){const docs=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key.startsWith(presenceKey))continue;try{const row=JSON.parse(localStorage.getItem(key));if(row.updatedAt>Date.now()-20000)docs.push({_id:key,kind:'scene',sceneId:'garden-ortho-v2',revision:row.updatedAt,records:{[row.id]:row}})}catch(_){}}return docs}
 function notifyPresence(){const event={type:'init',docs:presenceDocs()};for(const fn of listeners)fn(event)}
 if(channel)channel.onmessage=notifyPresence;
 window.addEventListener('storage',e=>{if(e.key?.startsWith(presenceKey))notifyPresence()});
 function publishPresence(){notifyPresence();channel?.postMessage('change')}
 const memoryDemo=new URLSearchParams(location.search).get('memoryDemo')==='1';
 const demoStory={text:'它喜欢趴在阳光照到的地板上。每次听见钥匙的声音，就会跑到门口等我。\n\n谢谢你，把平凡的日子变成了值得珍藏的回忆。',images:[{uploadId:'image-demo',entrance:true,url:memoryDemo?'/portrait-demo.png':'/packageMemorial/assets/monuments-v1/arch.png'}],videos:[],music:{uploadId:'music-demo',url:'/packageMemorial/assets/audio/music.wav',name:'陪伴的旋律.wav'}};
 if(memoryDemo){demoStory.images.push({uploadId:'image-second',entrance:false,url:'/portrait-demo.png'});demoStory.videos.push({uploadId:'video-demo',entrance:true,url:''},{uploadId:'video-second',entrance:false,url:''})}
 let memoryState={revision:1,mediaRevision:0,reviewStatus:'approved',isPublic:true,draft:structuredClone(demoStory),story:structuredClone(demoStory)};
 if(memoryDemo){try{memoryState=JSON.parse(localStorage.getItem('memorial-preview-memory'))||memoryState}catch(_){}}
 const cloud={callFunction:async(module,action,data={})=>{
  // Local-only network rehearsal: serialize the real sync client behind a slow
  // response, preserving the position's original sampledAt before the delay.
  if(presenceDelay&&['joinPresence','syncPresence','leavePresence'].includes(action))await new Promise(resolve=>setTimeout(resolve,presenceDelay));
  if(action==='joinPresence'){presenceSession=visitorId+'_'+Date.now();presenceEpoch=Date.now();presenceSeq=0;localStorage.setItem(presenceKey+visitorId,JSON.stringify({id:visitorId,...data.state,epoch:presenceEpoch,seq:0,updatedAt:Date.now()}));publishPresence();return{session:presenceSession,playerId:visitorId,sceneId:'garden-ortho-v2',collection:'preview',shards:65,serverTime:Date.now()}}
  if(action==='syncPresence'||action==='leavePresence'){if(data.session!==presenceSession)return{replaced:true};if(data.seq>presenceSeq){presenceSeq=data.seq;if(action==='leavePresence')localStorage.removeItem(presenceKey+visitorId);else localStorage.setItem(presenceKey+visitorId,JSON.stringify({id:visitorId,...data.state,epoch:presenceEpoch,seq:data.seq,updatedAt:Date.now()}));publishPresence()}return{accepted:true,serverTime:Date.now()}}

  if(action==='listGardens'||action==='listGardensAdmin')return{list:[previewGarden,extraGarden],hasMore:false};
  if(action==='createGarden'||action==='updateGarden')return{...previewGarden,...data,id:data.id||extraGarden.id,revision:1};
  if(action==='world')return{serverTime:Date.now(),garden:data.gardenId===extraGarden.id?extraGarden:previewGarden,occupied:['garden-ortho-v2:23:21'],memorials:[{id:'garden-ortho-v2:23:21',applicationId:sample._id,x:1376,y:1504,name:sample.petName,epitaph:sample.epitaph,date:sample.date,style:'arch',...(new URLSearchParams(location.search).get('portraitDemo')==='1'?{portrait:{id:'shiba-demo',url:'/portrait-demo.png',...demoArt}}:{})}]};
  const story=memoryState.story;
  if(action==='entrance')return memoryState.isPublic?{images:story.images.filter(m=>m.entrance),videos:story.videos.filter(m=>m.entrance)}:{images:[],videos:[]};
  if(action==='getMemorialAdmin')return{...sample,id:sample._id,reviewStatus:'approved',isPublic:true,draft:story,story,portrait:{status:'empty',photos:[]}};
  if(action==='detail')return{gardenId:sample.gardenId,gardenName:sample.gardenName,id:sample._id,petName:sample.petName,date:sample.date,epitaph:sample.epitaph,lawn:sample.lawn,plotId:sample.plotId,owner:new URLSearchParams(location.search).get('role')!=='visitor',hasPublicStory:memoryState.isPublic,...structuredClone(memoryState),story:memoryState.isPublic?structuredClone(story):null};
  if(action==='updateMemoryMedia'){
   if(data.mediaRevision!==memoryState.mediaRevision||data.revision!==memoryState.revision)throw new Error('回忆已更新，请重新打开');
   for(const snapshot of [memoryState.draft,memoryState.story])snapshot[data.kind]=data.operation==='remove'?snapshot[data.kind].filter(m=>m.uploadId!==data.uploadId):snapshot[data.kind].map(m=>m.uploadId===data.uploadId?{...m,entrance:data.enabled}:m);
   memoryState.mediaRevision++;if(memoryDemo)localStorage.setItem('memorial-preview-memory',JSON.stringify(memoryState));
   return{revision:memoryState.revision,mediaRevision:memoryState.mediaRevision,reviewStatus:memoryState.reviewStatus,story:memoryState.isPublic?structuredClone(memoryState.story):null,hasPublicStory:memoryState.isPublic};
  }
  if(action==='listMemoriesAdmin')return{list:[{...sample,_id:'demo-memory',status:'pending',revision:2,memory:story}],hasMore:false};
  if(action==='portraitDetail')return{revision:0,status:'empty',photos:[]};
  if(action==='preparePortraitAsset')return data.uploadId ? demoArt : {uploadId:'demo-art',cloudPath:'portrait-demo.png'};
  if(action==='listPortraitsAdmin')return{list:[{...sample,_id:'demo-portrait',style:new URLSearchParams(location.search).get('style')||'arch',pose:new URLSearchParams(location.search).get('pose')||'sitting',legacy:new URLSearchParams(location.search).get('legacy')==='1',status:'pending',revision:1,note:'右耳和尾巴上的花纹要保留',photos:[{uploadId:'front',url:'/portrait-demo.png'},{uploadId:'side',url:'/portrait-demo.png'}]}],hasMore:false};
  if(action==='saveMemory')return{revision:2,status:'pending'};
  if(action==='getSettings')return{subscription:{enabled:true,templates:{adminPendingAudit:'audit-local-preview'}}};
  if(action==='listAdmin'||action==='listMine'||action==='listUserMemorialsAdmin')return{list:(!data.status||data.status===sample.status)?[sample]:[],hasMore:false,cursor:''};
  if(action==='review'){sample.status=data.status;sample.reason=data.reason}
  return{id:'local-only',status:'pending'};
 },getCloudEnv:()=> 'local-preview',getCachedUser:()=>({_id:'preview-owner'}),showError:e=>console.error(e),setCachedSystemSettings:x=>x,requestSubscribeTemplates:async()=>({requested:false,reason:'preview'})};
 function req(name){
  if(name.endsWith('/memorial-asset-path'))return {monumentFileID:style=>'/packageMemorial/assets/monuments-v1/'+(style||'arch')+'.png'};
  if(name.endsWith('/image-upload'))return{prepareImage:async()=>{throw new Error('请在微信中验证真实文件上传')}};
  if(name.endsWith('/cloud'))return cloud;
  if(name.endsWith('/cloud-assets'))return{createCloudAssets:()=>Object.assign(key=>'/packageMemorial/assets/'+key,{dispose(){}}),createCloudChunks:()=>id=>fetch('/packageMemorial/assets/world-v3/chunks/'+id+'.json').then(r=>r.json())};
  const id=(['admin','archive'].includes(kind) && ['./plot-number','./portrait-prompt','./memorial-portrait-layout','./portrait-upload','./portrait-preview'].includes(name)?'admin/':name.includes('utils/')?'utils/':'scene/')+name.split('/').at(-1);
  if(!cache[id]){cache[id]={exports:{}};Function('module','exports','require',modules[id])(cache[id],cache[id].exports,req)}return cache[id].exports;
 }
 const info=()=>({windowWidth:innerWidth,windowHeight:innerHeight,pixelRatio:devicePixelRatio,safeArea:{top:24,left:0,right:innerWidth,bottom:innerHeight}});
 function previewDatabase(){
  const query={collection:()=>query,where:()=>query,limit:()=>query,watch({onChange,onError}){
   if(new URLSearchParams(location.search).get('syncError')==='index'){queueMicrotask(()=>onError(new Error('database watch requires index: kind, sceneId')));return{close(){}}}

   listeners.add(onChange);queueMicrotask(()=>{if(listeners.has(onChange))onChange({type:'init',docs:presenceDocs()})});
   return{close(){listeners.delete(onChange)}};
  }};return query;
 }
 window.wx={cloud:{database:previewDatabase,uploadFile(o){o.success({fileID:'cloud://preview/portrait-demo.png'});return{abort(){}}}},
 chooseMedia(o){if(portraitDemoMode)o.success({tempFiles:[{tempFilePath:'/portrait-demo.png',size:151716}]});else o.fail({errMsg:'cancel'})},
 getFileSystemManager(){return {getFileInfo(o){fetch(o.filePath).then(r=>r.arrayBuffer()).then(b=>o.success({size:b.byteLength})).catch(o.fail)}}},
 canvasToTempFilePath(o){o.canvas.toBlob(blob=>blob?o.success({tempFilePath:URL.createObjectURL(blob)}):o.fail(new Error('PNG export failed')),'image/png')},
 getImageInfo(o){const img=new Image();img.onload=()=>o.success({width:img.width,height:img.height,type:'png'});img.onerror=()=>o.fail(new Error('示例图片加载失败'));img.src=o.src},
 setClipboardData(o){navigator.clipboard.writeText(o.data)},getWindowInfo:info,getMenuButtonBoundingClientRect:()=>({bottom:48}),getStorageSync:key=>key==='memorial-sound-v1'?{music:false,effects:false}:JSON.parse(localStorage.getItem(key)||'null'),setStorageSync:(key,value)=>localStorage.setItem(key,JSON.stringify(value)),showToast:console.log,openSetting(){},navigateBack(){},reLaunch(){},navigateTo({url}){const dest=url.includes('user-archive')?'archive':url.includes('/gardens')?'gardens':url.includes('/garden')?'garden':'memory';location.href='native.html?page='+dest+'&'+(url.split('?')[1]||'')},redirectTo(options){this.navigateTo(options)},previewImage({current}){window.open(current,'_blank')},stopPullDownRefresh(){},
 createOffscreenCanvas:({width,height})=>Object.assign(document.createElement('canvas'),{width,height}),createInnerAudioContext:()=>{
  const audio=new Audio(), handlers={};
  audio.onplaying=()=>handlers.play?.();audio.oncanplay=()=>handlers.ready?.();audio.onended=()=>handlers.ended?.();audio.onerror=()=>handlers.error?.({errMsg:'预览音频未能播放'});
  return {get src(){return audio.src},set src(v){audio.src=v},set loop(v){audio.loop=v},set volume(v){audio.volume=v},play(){audio.play().catch(e=>handlers.error?.(e))},pause(){audio.pause()},destroy(){audio.pause();audio.removeAttribute('src')},seek(t){audio.currentTime=t},onError(f){handlers.error=f},onPlay(f){handlers.play=f},onCanplay(f){handlers.ready=f},onEnded(f){handlers.ended=f}};
 },
 createSelectorQuery(){const selectors=[];const q={in:()=>q,select:s=>{selectors.push(s);return q},fields:()=>q,boundingClientRect:()=>q,exec(fn){fn(selectors.map(s=>{const node=document.querySelector(s);if(!node)return null;if(node.tagName==='CANVAS')node.createImage=()=>new Image();return {...node.getBoundingClientRect().toJSON(),node}}))}};return q}};
 Function('Page','require','wx',sources.js)(def=>{page=def},req,wx);
 page.data=structuredClone(page.data);if(['admin','gardens','archive'].includes(kind))page.data.adminSuper=true;
 page.setData=patch=>{for(const [key,value]of Object.entries(patch)){const parts=key.split('.');let obj=page.data;for(const key of parts.slice(0,-1))obj=obj[key];obj[parts.at(-1)]=value}render()};
 function style(){document.getElementById('native-style').textContent=((sources.global||'')+'\n'+sources.wxss).replace(/\bimage\b/g,'img').replace(/(^|\n)page\s*{/g,'$1body {').replace(/([\d.]+)rpx/g,(_,n)=>Number(n)*Math.min(innerWidth,750)/750+'px')};style();render();
 if(kind==='garden'){
  canvas=document.getElementById('gardenCanvas');canvas.createImage=()=>new Image();canvas.requestAnimationFrame=fn=>requestAnimationFrame(fn);canvas.cancelAnimationFrame=id=>cancelAnimationFrame(id);
  const touches=new Map();function event(e){return{touches:[...touches.values()],changedTouches:[{identifier:e.pointerId,clientX:e.clientX,clientY:e.clientY}]}}
  canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);touches.set(e.pointerId,{identifier:e.pointerId,clientX:e.clientX,clientY:e.clientY});page.mapTouchStart(event(e))};
  canvas.onpointermove=e=>{if(!touches.has(e.pointerId))return;touches.set(e.pointerId,{identifier:e.pointerId,clientX:e.clientX,clientY:e.clientY});page.mapTouchMove(event(e))};
  canvas.onpointerup=e=>{touches.delete(e.pointerId);page.mapTouchEnd(event(e))};canvas.onpointercancel=()=>{touches.clear();page.cancelMapGesture()};
 }
 // Preview-only clock controls; production pages always use the shared server clock.
 if(kind==='garden'){
  const {environmentAt}=req('./environment');
  const liveSync=page.syncEnvironmentClock;
  let previewTime=null;
  page.syncEnvironmentClock=function(...args){if(previewTime===null)return liveSync.apply(this,args)};
  window.previewEnvironment=preset=>{
   const scene=page.scene;if(!scene)return null;
   if(preset==='live'){previewTime=null;scene.environment.now=Date.now;scene.environment.offset=0}
   else{
    const times={spring:'2026-04-15T06:00:00+08:00',summer:'2026-07-15T12:00:00+08:00',autumn:'2026-10-15T17:45:00+08:00',winter:'2026-01-15T21:00:00+08:00'};
    let time=Date.parse(times[preset]||preset);
    if(preset==='rain'||preset==='snow'){
     time=Date.parse(preset==='rain'?'2026-07-15T12:30:00+08:00':'2026-01-15T12:30:00+08:00');
     for(let i=0;i<90;i++,time+=86400000)if(environmentAt(time,scene.environment.garden).weather[preset]>.3)break;
    }
    if(!Number.isFinite(time))return null;
    previewTime=time;const started=Date.now();scene.environment.now=()=>time+Date.now()-started;scene.environment.offset=0;
   }
   scene.environment._at=undefined;scene.requestDraw();return scene.environment.sample();
  };
  if(new URLSearchParams(location.search).get('environmentPreview')==='1'){
   const controls=document.createElement('div');controls.id='environment-preview';
   controls.style.cssText='position:fixed;z-index:210;bottom:26px;left:50%;transform:translateX(-50%);display:flex;gap:4px;background:#fffdf2;padding:7px;border-radius:10px;max-width:96vw;flex-wrap:wrap;justify-content:center';
   for(const [key,label]of [['spring','春日清晨'],['summer','夏日白天'],['autumn','秋日黄昏'],['winter','冬日夜晚'],['rain','细雨'],['snow','轻雪'],['live','真实时间']]){
    const button=document.createElement('button');button.textContent=label;button.style.cssText='font-size:11px;padding:7px;background:#e4ead8;border-radius:6px;white-space:nowrap';button.onclick=()=>window.previewEnvironment(key);controls.appendChild(button);
   }
   document.body.appendChild(controls);
  }
 }
 window.addEventListener('pagehide',()=>page?.onHide?.());
 window.previewPage=page;page.onLoad&&page.onLoad({id:kind==='memory'?'demo-application':undefined,openid:'preview-owner',gardenId:new URLSearchParams(location.search).get('gardenId')||undefined,plotId:new URLSearchParams(location.search).get('plotId')||undefined,mode:new URLSearchParams(location.search).get('mode')});page.onShow&&await page.onShow();page.onReady&&page.onReady();window.onresize=()=>{style();page.onResize&&page.onResize()};
})().catch(console.error)
