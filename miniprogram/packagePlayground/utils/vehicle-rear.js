// One consistent isometric model, facing upper left. Upper right is mirrored
// by drawVehicle, using the same ground anchor and size as the front atlas.
function drawRearVehicle(size,moving,phase) {
  const c=this.ctx,bounce=moving?Math.sin(phase*Math.PI*4)*.003:0
  const project=([length,width,height])=>[
    .60*(width-length)*size,
    (-.33*(length+width)-height-.235+bounce)*size
  ]
  const face=(points,fill,outline='#345371')=>{
    c.beginPath()
    points.map(project).forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y))
    c.closePath();c.fillStyle=fill;c.fill()
    if(outline){c.strokeStyle=outline;c.lineWidth=size*.004;c.stroke()}
  }
  const wheel=(length,width)=>{
    const [x,y]=project([length,width,.065])
    c.save();c.translate(x,y);c.rotate(.476)
    const oval=(rx,ry,color)=>{c.beginPath();c.ellipse(0,0,rx*size,ry*size,0,0,Math.PI*2);c.fillStyle=color;c.fill()}
    oval(.058,.078,'#24313e');oval(.037,.055,'#bec9d1');oval(.027,.043,'#6e8294')
    c.strokeStyle='#e0e6e9';c.lineWidth=size*.005
    const spin=moving?phase*Math.PI*24:0
    for(let i=0;i<5;i++) {
      const a=spin+i*Math.PI*2/5
      c.beginPath();c.moveTo(0,0);c.lineTo(Math.cos(a)*size*.027,Math.sin(a)*size*.043);c.stroke()
    }
    oval(.011,.014,'#e3e8eb');c.restore()
  }
  c.save()
  c.fillStyle='rgba(35,50,58,.16)';c.beginPath();c.ellipse(0,-size*.235,size*.44,size*.1,.476,0,Math.PI*2);c.fill()
  // Far wheels, then connected body surfaces, then the visible wheels.
  wheel(-.34,.255);wheel(.34,.255)
  face([[.54,-.22,.10],[.54,.22,.10],[.54,.22,.19],[.49,.23,.23],[.49,-.23,.23],[.54,-.22,.19]],'#6394bb')
  face([[.49,-.23,.23],[.49,.23,.23],[.20,.23,.24],[.20,-.23,.24]],'#9cbdd5')
  face([[.54,-.22,.10],[-.52,-.22,.10],[-.54,-.235,.21],[-.48,-.24,.24],[.49,-.23,.23],[.54,-.22,.19]],'#719fc4')
  face([[-.54,-.235,.21],[-.54,.235,.21],[-.48,.24,.24],[-.48,-.24,.24]],'#78a6c8')
  face([[-.48,-.24,.24],[-.48,.24,.24],[-.27,.23,.25],[-.27,-.23,.25]],'#a1c1d9')
  // Cabin: side windows and rear glass share the roof's edges.
  face([[.20,-.23,.24],[.20,.23,.24],[.08,.19,.34],[.08,-.19,.34]],'#56758e')
  face([[.20,-.23,.24],[.08,-.19,.34],[-.15,-.19,.34],[-.29,-.23,.25]],'#83adcc')
  face([[.08,-.19,.34],[.08,.19,.34],[-.15,.19,.34],[-.15,-.19,.34]],'#a9c9df')
  face([[-.15,-.19,.34],[-.15,.19,.34],[-.29,.23,.25],[-.29,-.23,.25]],'#7d9db6')
  face([[-.15,-.165,.324],[-.15,.165,.324],[-.265,.195,.267],[-.265,-.195,.267]],'#334e67')
  face([[.16,-.234,.257],[.065,-.198,.323],[-.025,-.198,.323],[-.025,-.235,.257]],'#3a556c')
  face([[-.045,-.235,.257],[-.045,-.198,.323],[-.14,-.198,.323],[-.255,-.234,.267]],'#3a556c')
  // Rear panel, both tail lamps, plate and bumper lie on the same plane.
  const rear=(width,height)=>[-.542,width,height]
  face([rear(-.235,.21),rear(.235,.21),rear(.22,.10),rear(-.22,.10)],'#5d8eb6')
  for(const [a,b] of [[-.215,-.115],[.115,.215]]) {
    face([rear(a,.158),rear(b,.158),rear(b,.199),rear(a,.199)],'#b74e52','#81494f')
    face([rear(a,.162),rear(b,.162),rear(b,.174),rear(a,.174)],'#f5b3a2',null)
  }
  face([rear(-.065,.112),rear(.065,.112),rear(.065,.15),rear(-.065,.15)],'#edf0e8','#567388')
  face([rear(-.205,.10),rear(.205,.10),rear(.205,.114),rear(-.205,.114)],'#456d91',null)
  // Door seams and handles follow the side plane instead of screen rectangles.
  const side=(length,height)=>[length,-.244,height]
  face([side(-.04,.12),side(-.04,.24),side(-.032,.24),side(-.032,.12)],'#5d85a6',null)
  face([side(.06,.22),side(.12,.22),side(.12,.23),side(.06,.23)],'#c6d8e3',null)
  face([side(-.22,.22),side(-.16,.22),side(-.16,.23),side(-.22,.23)],'#c6d8e3',null)
  wheel(.34,-.255);wheel(-.34,-.255)
  c.restore()
}
module.exports={drawRearVehicle}
