
'use strict';
const $=id=>document.getElementById(id), images={}, durations={walk:125,idle:300};
let frame=0,paused=false,last=null,accum=0,loaded=0,failed=0;
function draw(){
 const action=$('action').value,im=images[action];
 $('counter').textContent=`${frame+1} / 8`;$('frame').value=frame;
 $('main-title').textContent=action==='idle'?'待机 · 呼吸与披风轻摆':'行走 · 保留步态，修补双手';
 $('timing').textContent=action==='idle'?'8 帧 / 2.4 秒循环':'8 帧 / 1 秒循环';
 for(const id of ['main','detail']){const c=$(id),ctx=c.getContext('2d');ctx.fillStyle=$('bg').value;ctx.fillRect(0,0,c.width,c.height);if(!im?.complete||!im.naturalWidth)continue;
 const cw=im.naturalWidth/4,ch=im.naturalHeight/2,sx=frame%4*cw,sy=Math.floor(frame/4)*ch;
 if(id==='main')ctx.drawImage(im,sx,sy,cw,ch,0,0,c.width,c.height);
 else {const crop=action==='walk'?[68,181,152,92]:[79,158,136,101];const scale=Math.min((c.width-24)/crop[2],(c.height-36)/crop[3]);ctx.drawImage(im,sx+crop[0],sy+crop[1],crop[2],crop[3],(c.width-crop[2]*scale)/2,(c.height-crop[3]*scale)/2,crop[2]*scale,crop[3]*scale);}}
 $('status').textContent=failed?'素材加载失败，请检查文件是否完整。':`已加载 ${loaded}/2 套动作 · ${paused?'已暂停，可逐帧检查':'循环播放'} · 待机靴子已固定`;
}
for(const action of ['walk','idle']){const im=new Image();images[action]=im;im.onload=()=>{loaded++;draw()};im.onerror=()=>{failed++;draw()};im.src=`${action}-sw.png`;}
function pause(){paused=true;accum=0;$('play').textContent='播放';}
$('play').onclick=()=>{paused=!paused;accum=0;$('play').textContent=paused?'播放':'暂停';draw()};
$('frame').oninput=()=>{pause();frame=Number($('frame').value);draw()};
$('prev').onclick=()=>{pause();frame=(frame+7)%8;draw()};$('next').onclick=()=>{pause();frame=(frame+1)%8;draw()};
$('action').onchange=()=>{frame=0;accum=0;draw()};$('bg').onchange=draw;$('speed').onchange=()=>{accum=0;};
function tick(t){if(last===null)last=t;const dt=Math.min(t-last,200);last=t;if(!paused&&loaded===2){accum+=dt*Number($('speed').value);const duration=durations[$('action').value];if(accum>=duration){frame=(frame+Math.floor(accum/duration))%8;accum%=duration;draw()}}requestAnimationFrame(tick)}
draw();requestAnimationFrame(tick);
