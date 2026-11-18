import * as T from 'three';
import {mergeGeometries, mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';

const {sin, cos, PI, min, max} = Math;
const V = (x, y, z) => new T.Vector3(x, y, z);
const rect = (x, y, w, h) => [[x-w/2,y],[x+w/2,y],[x+w/2,y+h],[x-w/2,y+h]];

function arch(x, y, w, h, crown) {
  const p = [[x-w/2,y],[x+w/2,y],[x+w/2,y+h-crown]];
  for (let i=1; i<=20; i++) {
    const a = PI*i/20;
    p.push([x+cos(a)*w/2,y+h-crown+sin(a)*crown]);
  }
  return p;
}

function pathTo(path, points) {
  points.forEach(([x,y],i) => i ? path.lineTo(x,y) : path.moveTo(x,y));
  path.closePath();
  return path;
}

function cube() {
  const g = new T.BoxGeometry(1,1,1);
  g.clearGroups();
  return g.toNonIndexed();
}

function chamfer() {
  const e = .11;
  const points = [[-.5+e,-.5],[.5-e,-.5],[.5,-.5+e],[.5,.5-e],[.5-e,.5],[-.5+e,.5],[-.5,.5-e],[-.5,-.5+e]];
  const g = new T.ExtrudeGeometry(pathTo(new T.Shape(),points),{depth:.8,bevelEnabled:true,bevelThickness:.1,bevelSize:.035,bevelSegments:1,steps:1});
  g.translate(0,0,-.4);
  g.clearGroups();
  return g;
}

const box = cube(), block = chamfer();
const leaf = new T.IcosahedronGeometry(1,0);
const nail = new T.IcosahedronGeometry(1,0);
const joint = new T.IcosahedronGeometry(1,1);
const euler = new T.Euler();
const up = V(0,1,0);

class Fabric {
  constructor(name) {
    this.name = name;
    this.parts = new Map();
  }
  bake(g,mat,p=V(0,0,0),q=new T.Quaternion(),s=V(1,1,1)) {
    g.applyMatrix4(new T.Matrix4().compose(p,q,s));
    if (!this.parts.has(mat)) this.parts.set(mat,[]);
    this.parts.get(mat).push(g.index ? g.toNonIndexed() : g);
  }
  form(g,mat,p,s,rx=0,ry=0,rz=0) {
    this.bake(g.clone(),mat,p,new T.Quaternion().setFromEuler(euler.set(rx,ry,rz)),s);
  }
  link(a,b,w,d,mat,g=box) {
    const dir = b.clone().sub(a);
    this.bake(g.clone(),mat,a.clone().lerp(b,.5),new T.Quaternion().setFromUnitVectors(up,dir.clone().normalize()),V(w,dir.length(),d));
  }
  finish() {
    const group = new T.Group();
    group.name = this.name;
    for (const [mat,parts] of this.parts) {
      const g = mergeGeometries(parts);
      if (!g) throw new Error('Could not batch '+this.name+' / '+mat.name);
      const mesh = new T.Mesh(mergeVertices(g,1e-5),mat);
      g.dispose();
      mesh.name = this.name + ' - ' + mat.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      for (const part of parts) part.dispose();
    }
    this.parts.clear();
    return group;
  }
}

function elevation(x,z,yaw=0) {
  return {
    yaw,p:(u,v,n=0) => V(x+u*cos(yaw)+n*sin(yaw),v,z-u*sin(yaw)+n*cos(yaw)),
    q:new T.Quaternion().setFromAxisAngle(up,yaw),
  };
}

export function buildArchitecture(m) {
  let seed = 0xf09531d5;
  function random() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed>>>0)/4294967296;
  }
  const pick = xs => xs[Math.floor(random()*xs.length)];
  const house = new Fabric('Villa walls and structure');
  const wood = new Fabric('Half-timbering, doors and glazed windows');
  const mas = new Fabric('Stone chimney, arcade and foundations');
  const plants = new Fabric('Courtyard pots');
  const f = elevation(0,3.56), r = elevation(0,-3.60,PI);
  const wing = elevation(0,3.22), wingG = elevation(0,3.93);
  const right = elevation(0,4.93), rightBack = elevation(0,-4.34,PI);
  const stone = m.stoneTones, beams = m.woodTones;

  function piece(batch,g,mat,e,x,y,z,w,h,d,roll=0) {
    batch.form(g,mat,e.p(x,y,z),V(w,h,d),0,e.yaw,roll);
  }

  function panel(batch,e,points,mat,{holes=[],depth=.20,n=0,repeat=3.0}={}) {
    const shape = pathTo(new T.Shape(),points);
    shape.holes = holes.map(points => pathTo(new T.Path(),points));
    const g = depth > 0
      ? new T.ExtrudeGeometry(shape,{depth,bevelEnabled:false,curveSegments:1})
      : new T.ShapeGeometry(shape,1);
    g.translate(0,0,-depth);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for(let i=0;i<pos.count;i++) uv.setXY(i,pos.getX(i)/repeat,1-pos.getY(i)/repeat);
    g.clearGroups();
    batch.bake(g,mat,e.p(0,0,n),e.q);
  }

  function quad(batch,mat,ps,uvs=[[0,1],[1,1],[1,0],[0,0]]) {
    const g = new T.BufferGeometry();
    const order = ps[3].distanceToSquared(ps[0])<1e-10 ? [0,1,2] : [0,1,2,0,2,3];
    g.setAttribute('position',new T.Float32BufferAttribute(order.flatMap(i=>ps[i].toArray()),3));
    g.setAttribute('uv',new T.Float32BufferAttribute(order.flatMap(i=>uvs[i]),2));
    g.computeVertexNormals();
    batch.bake(g,mat);
  }

  function timber(e,x0,y0,x1,y1,w=.16,d=.092,n=.023,mat=pick(beams),pegs=false) {
    const h = Math.hypot(x1-x0,y1-y0);
    if (h<1e-5) return;
    piece(wood,box,mat,e,(x0+x1)/2,(y0+y1)/2,n,w,h,d,-Math.atan2(x1-x0,y1-y0));
    if (pegs && h>.36) {
      for (const t of [.1,.9]) piece(wood,nail,m.peg,e,x0+(x1-x0)*t,y0+(y1-y0)*t,n+d/2,.029,.029,.019);
    }
  }

  function sill(e,x,y,w,forStone=false) {
    const mat = forStone ? stone[2] : beams[1];
    const b = forStone ? mas : wood;
    piece(b,box,mat,e,x,y,.095,w+.14,.10,.28);
    piece(b,box,mat,e,x,y+.063,.09,w+.18,.042,.30);
  }

  function window(e,{x,y,w,h,crown=0,cols=2,rows=3,stoneSill=false,trim=true,shutter=false,diamond=false}) {
    const outline = crown ? arch(x,y,w,h,crown) : rect(x,y,w,h);
    panel(wood,e,outline,m.glass,{depth:0,n:-.113,repeat:2.5});
    const topAt = dx => crown ? y+h-crown+crown*Math.sqrt(max(0,1-(dx/(w/2))**2)) : y+h;
    const border = trim ? min(.117,w*.116) : min(.078,w*.095);
    for(let i=0;i<outline.length;i++) {
      const [a,b] = outline[i],[c,d] = outline[(i+1)%outline.length];
      timber(e,a,b,c,d,border,.145,-.005,beams[1]);
    }
    for(let col=0;col<cols;col++) for (let row=0;row<rows;row++) {
      const inset=.025;
      const l=x-w/2+w*col/cols+inset,v=x-w/2+w*(col+1)/cols-inset;
      const bottom=y+h*row/rows+inset, top=y+h*(row+1)/rows-inset;
      if (top>topAt(l-x)-.02 || top>topAt(v-x)-.02) continue;
      const mat = pick(m.glassTones);
      panel(wood,e,[[l,bottom],[v,bottom],[v,top],[l,top]],mat,{n:-.104,depth:0,repeat:2.6});
    }
    for(let col=1;col<cols;col++) {
      const wx=x-w/2+w*col/cols;
      timber(e,wx,y,wx,topAt(wx-x),col===Math.ceil(cols/2)?.062:.046,.07,-.051,beams[1]);
    }
    for(let row=1;row<rows;row++) {
      const wy=y+h*row/rows;
      const edge = crown && wy>y+h-crown ? w/2*Math.sqrt(1-((wy-y-h+crown)/crown)**2) : w/2;
      timber(e,x-edge,wy,x+edge,wy,row===rows-1?.055:.042,.074,-.051,beams[1]);
    }
    if(diamond) {
      const dx=w/(2*cols), dy=h/(2*rows);
      for(let col=0;col<cols;col++) for(let row=0;row<rows;row++) {
        const cx=x-w/2+dx*(col*2+1),cy=y+dy*(row*2+1);
        if(cy+dy>topAt(cx-x)-.06) continue;
        const pairs = [[cx-dx,cy,cx,cy+dy],[cx,cy+dy,cx+dx,cy],[cx+dx,cy,cx,cy-dy],[cx,cy-dy,cx-dx,cy]];
        for(const p of pairs) timber(e,...p,.018,.016,-.072,m.lead);
      }
    }
    sill(e,x,y-.055,w,stoneSill);
    if(!crown && trim) {
      timber(e,x-w/2-.038,y+h+.047,x+w/2+.038,y+h+.047,.095,.15,.052,beams[1]);
      timber(e,x-w/2-.075,y+h+.098,x+w/2+.075,y+h+.098,.043,.18,.058,beams[2]);
    }
    if (shutter) {
      for (const s of [-1,1]) {
        const side=x+s*(w/2+.19);
        piece(wood,box,beams[2],e,side,y+h/2,.064,.29,h+.10,.11);
        for(let i=-1;i<=1;i++) piece(wood,box,beams[0],e,side+.082*i,y+h/2,.13,.075,h+.05,.016);
        for(const d of [.25,.76]) timber(e,side-.144,y+h*d,side+.144,y+h*d,.055,.025,.15,beams[1]);
      }
    }
    return outline;
  }

  function row(e,l,r,y,h,n=.066,d=.18,width=.52) {
    let x = l;
    while(x<r-.04) {
      const remaining=r-x;
      let w=min(remaining,width*(.58+random()*.84));
      if(remaining-w<.11) w=remaining;
      piece(mas,block,pick(stone),e,x+w/2,y+(random()-.5)*.021,n+(random()-.5)*.036,
        max(.04,w-.038),h-(.018+random()*.019),d+(random()-.5)*.037,(random()-.5)*.046);
      x+=w;
    }
  }

  function base(e,a,b) {
    for(let i=0;i<3;i++) row(e,a,b,.08+i*.137,.137,.055,.16,.51);
    piece(mas,box,stone[1],e,(a+b)/2,.417,.027,b-a,.090,.18);
  }

  const windowHoles = specs => specs.map(s=>s.crown?arch(s.x,s.y,s.w,s.h,s.crown):rect(s.x,s.y,s.w,s.h));
  function wall(e,l,r,h,specs,{doors=[],bottom=.12,plinth=true}={}) {
    panel(house,e,[[l,bottom],[r,bottom],[r,h],[l,h]],m.plaster,{holes:[...windowHoles(specs),...doors]});
    for(const s of specs) window(e,s);
    if(plinth) base(e,l,r);
  }

  function boardBelt(e,a,b,floor,height) {
    timber(e,a,floor,b,floor,.23,.135,.051,beams[1]);
    timber(e,a,floor+.123,b,floor+.123,.037,.161,.057,beams[2]);
    timber(e,a,height,b,height,.19,.141,.050,beams[0]);
  }

  function crosses(e,a,b,low,high,stations,braces=[]) {
    timber(e,a,low,a,high,.22,.16,.041,beams[1],true);
    timber(e,b,low,b,high,.22,.16,.041,beams[1],true);
    for(const x of stations) timber(e,x,low,x,high,.14+random()*.055,.095,.036,pick(beams),true);
    for(const [x,y,u,v] of braces) timber(e,x,y,u,v,.13,.085,.030,pick(beams),true);
  }

  function gable(e,left,center,right,baseY,leftY,midY,rightY) {
    const top = x => x<center ? leftY+(midY-leftY)*(x-left)/(center-left) : midY+(rightY-midY)*(x-center)/(right-center);
    panel(house,e,[[left,baseY],[right,baseY],[right,rightY],[center,midY],[left,leftY]],m.plaster);
    timber(e,left,baseY,right,baseY,.245,.143,.049,beams[1],true);
    timber(e,left,leftY-.047,center,midY-.084,.175,.115,.04,beams[1]);
    timber(e,center,midY-.084,right,rightY-.047,.175,.115,.04,beams[1]);
    timber(e,center,baseY,center,midY-.098,.235,.148,.05,beams[1],true);
    for(const f of [.21,.43,.69,.85]) {
      const x=left+(right-left)*f;
      timber(e,x,baseY,x,top(x)-.09,.135,.096,.029,pick(beams),true);
    }
    const midBase=baseY+(midY-baseY)*.40;
    const legL=left+(center-left)*max(0,(midBase-leftY)/(midY-leftY)),legR=right+(center-right)*max(0,(midBase-rightY)/(midY-rightY));
    timber(e,legL,midBase,legR,midBase,.145,.112,.030,beams[1]);
    timber(e,center,midBase,center-(center-left)*.49,top(center-(center-left)*.49)-.11,.124,.085,.02,beams[0]);
    timber(e,center,midBase,center+(right-center)*.49,top(center+(right-center)*.49)-.11,.124,.085,.02,beams[0]);
  }

  const mainWindows = [
    {x:-3.86,y:3.99,w:.91,h:1.33,crown:.16,rows:4,diamond:true},
    {x:-1.42,y:3.96,w:.92,h:1.39,crown:.16,rows:4,diamond:true},
    {x:1.02,y:4.02,w:1.04,h:1.26,rows:3,diamond:true},
  ];
  const porchCenters = [-4.01,-1.37,1.28];
  const rearDoor = arch(.65,.38,1.18,2.23,.33);
  const portal = arch(porchCenters[2],.40,1.28,2.34,.49);
  mainWindows.push(
    {x:porchCenters[0],y:.81,w:1.94,h:1.73,crown:.38,cols:4,diamond:true},
    {x:porchCenters[1],y:.81,w:1.90,h:1.73,crown:.38,cols:4,diamond:true}
  );
  wall(f,-6.46,2.84,6.50,mainWindows,{doors:[portal]});
  boardBelt(f,-6.42,2.83,3.43,6.38);
  crosses(f,-6.42,2.83,3.55,6.38,[-5.30,-4.64,-3.10,-2.18,-.67,.27,1.78,2.39],[
    [-5.40,3.55,-6.39,4.58],[-5.40,3.55,-4.66,4.51],[-3.10,5.75,-2.39,6.36],
    [-.68,5.69,-.02,6.32],[1.79,6.34,2.37,5.67],[2.35,3.55,2.81,4.06],
  ]);
  timber(f,-6.4,5.52,2.82,5.52,.129,.112,.038,beams[1],true);
  for(const x of [-6.41,-5.73,-2.69,.0,2.82]) timber(f,x,.47,x,3.40,.184,.13,.039,beams[0],true);

  const rearWins = [
    {x:-1.78,y:3.98,w:1.15,h:1.50,rows:3,shutter:true},
    {x:.62,y:4.04,w:1.20,h:1.47,rows:3,diamond:true},
    {x:4.49,y:4.01,w:1.40,h:1.49,rows:4,cols:3},
    {x:-1.47,y:.86,w:1.54,h:1.77,cols:3,diamond:true},
    {x:3.43,y:.82,w:1.38,h:1.64,cols:3,diamond:true},
    {x:5.27,y:.86,w:1.06,h:1.54,stoneSill:true},
  ];
  wall(r,-2.84,6.46,6.48,rearWins,{doors:[rearDoor]});
  boardBelt(r,-2.84,6.46,3.40,6.36);
  crosses(r,-2.84,6.46,3.52,6.35,[-.85,1.60,2.08,3.50,5.46,5.93],[
    [-2.83,5.44,-2.12,6.33],[-.84,3.54,-.23,4.18],[2.08,3.54,3.47,4.89],
    [2.08,3.54,1.63,4.06],[5.48,5.59,6.44,6.34],
  ]);
  timber(r,-2.84,5.77,6.45,5.77,.147);
  for(const x of [-2.82,-.51,1.78,2.43,4.23,6.41]) timber(r,x,.46,x,3.36,.18,.13,.04,beams[1],true);

  const west = elevation(-6.46,0,-PI/2), wingOutside=elevation(-10.32,0,-PI/2);
  gable(west,-3.62,0,3.56,6.30,6.57,9.73,6.54);
  const westUpper = [{x:-.48,y:7.0,w:.84,h:1.18,crown:.12,rows:3}];
  wall(west,-3.62,3.56,6.34,[],{plinth:false,bottom:4.27});
  for (const spec of westUpper) window(west,spec);
  const wingUpper = {x:-8.76,y:3.18,w:1.29,h:1.40,cols:3,rows:3,diamond:true};
  const wingSmall = {x:-6.99,y:1.0,w:.65,h:1.29,rows:3};
  wall(wing,-10.32,-6.44,5.03,[wingSmall]);
  wall(wingG,-10.18,-7.33,5.03,[wingUpper]);
  const returnWest = elevation(-10.18,3.57,-PI/2),returnEast = elevation(-7.33,3.57,PI/2);
  wall(returnWest,-.35,.36,4.99,[]);wall(returnEast,-.36,.35,4.99,[]);
  gable(wingG,-10.18,-8.76,-7.33,5.03,5.17,6.73,5.18);
  boardBelt(wingG,-10.17,-7.34,2.69,4.96);
  crosses(wingG,-10.16,-7.35,2.79,4.93,[-9.66,-7.87],[[-10.13,2.83,-9.68,3.27],[-7.91,3.25,-7.35,2.84]]);
  for(const x of [-10.16,-9.63,-7.92,-7.34]) timber(wingG,x,.46,x,2.68,.159,.122,.036,beams[1],true);
  timber(wingG,-10.14,.52,-7.35,.52,.163);
  timber(wing,-7.33,2.69,-6.44,2.69,.203);timber(wing,-7.33,4.74,-6.44,4.74,.172);
  timber(wing,-6.49,.45,-6.49,4.99,.186,.127,.034,beams[1],true);

  const wingRear=elevation(0,-3.43,PI);
  wall(wingRear,6.46,10.32,4.99,[
    {x:7.52,y:3.02,w:.91,h:1.36,rows:4},
    {x:9.21,y:3.02,w:.77,h:1.29,rows:3},
    {x:8.61,y:.84,w:1.45,h:1.49,cols:3,diamond:true},
  ]);
  boardBelt(wingRear,6.46,10.32,2.66,4.92);
  crosses(wingRear,6.46,10.32,.46,4.88,[8.19,9.84],[[6.47,2.80,7.05,3.31],[9.85,3.65,10.30,4.55]]);
  wall(wingOutside,-3.43,3.21,5.02,[
    {x:-1.76,y:3.01,w:1.14,h:1.34,diamond:true},
    {x:1.43,y:3.0,w:1.12,h:1.34,diamond:true},
    {x:-.04,y:.88,w:1.54,h:1.46,cols:3},
  ]);
  gable(wingOutside,-3.43,0,3.21,4.92,5.05,6.86,5.06);
  boardBelt(wingOutside,-3.43,3.21,2.68,4.92);
  crosses(wingOutside,-3.42,3.2,.46,4.90,[-2.57,-.96,.88,2.36],[[-.95,2.8,-.04,3.75],[.88,2.81,.03,3.75]]);

  const rightEnds = [
    {e:right,l:2.83,c:5.17,r:7.53},
    {e:rightBack,l:-7.53,c:-5.17,r:-2.83},
  ];
  wall(right,2.83,7.53,6.42,[{x:3.87,y:4.08,w:.80,h:1.51,rows:4,diamond:true}]);
  wall(rightBack,-7.53,-2.83,6.42,[
    {x:-6.31,y:4.0,w:1.26,h:1.66,cols:3,diamond:true},
    {x:-4.02,y:4.04,w:.96,h:1.47,rows:4},
    {x:-5.15,y:.81,w:2.05,h:1.64,cols:4,crown:.24,diamond:true},
  ]);
  for(const {e,l,c,r} of rightEnds){
    gable(e,l,c,r,6.42,6.72,9.89,6.70);
    boardBelt(e,l,r,3.39,6.38);
    crosses(e,l+.028,r-.028,3.52,6.34,[c-.48,c+.02,r-.41],
      [[l+.07,3.57,l+.67,4.13],[r-.03,3.64,r-.39,4.19]]);
    timber(e,l+.048,.44,l+.048,3.40,.211,.155,.048,beams[1],true);
    timber(e,r-.045,.44,r-.045,3.40,.212,.155,.048,beams[1],true);
  }
  const east = elevation(7.53,0,PI/2);
  wall(east,-4.93,4.34,6.33,[
    {x:-3.51,y:4.04,w:1.10,h:1.56,crown:.15,diamond:true},
    {x:-.76,y:4.10,w:1.20,h:1.51,cols:3},
    {x:2.30,y:4.07,w:1.24,h:1.52,cols:3,shutter:true},
    {x:-3.47,y:.83,w:1.19,h:1.72,diamond:true},
    {x:-.78,y:.83,w:1.53,h:1.72,cols:3,stoneSill:true},
    {x:2.44,y:.87,w:1.42,h:1.68,cols:3,diamond:true},
  ]);
  boardBelt(east,-4.90,4.31,3.39,6.29);
  crosses(east,-4.90,4.31,.46,6.29,[-4.46,-2.53,-2,-1.69,.22,.81,1.23,3.57,4.01],[
    [-4.89,3.54,-4.45,4.02],[-2.48,3.55,-1.70,4.33],[.23,3.54,1.23,4.39],[3.56,5.76,4.29,6.22],
  ]);
  timber(east,-4.89,5.85,4.31,5.85,.128,.108,.034,beams[0]);

  const returnFront=elevation(2.83,4.24,-PI/2),returnBack=elevation(2.83,-3.96,-PI/2);
  for (const [e,l,r] of [[returnFront,-.68,.69],[returnBack,-.38,.36]]) {
    wall(e,l,r,6.38,[]);
    boardBelt(e,l,r,3.39,6.30);
    crosses(e,l+.04,r-.04,.44,6.30,[]);
  }

  function door(e,x,y,w,h,crown) {
    const outline = arch(x,y,w,h,crown);
    panel(wood,e,outline,m.door,{n:-.06,depth:.075,repeat:1.7});
    const bands = 7;
    for(let i=1;i<bands;i++){
      const xx=x-w/2+w*i/bands, cap=y+h-crown+crown*Math.sqrt(1-((xx-x)/(w/2))**2);
      timber(e,xx,y,xx,cap,.018,.014,-.055,beams[1]);
    }
    for(let i=0;i<outline.length;i++){
      const a=outline[i],b=outline[(i+1)%outline.length];
      timber(e,...a,...b,.12,.171,-.018,beams[0]);
    }
    for (const yy of [y+.34,y+1.50]) timber(e,x-w*.42,yy,x-w*.10,yy,.057,.022,-.038,m.lead);
    piece(wood,joint,m.brass,e,x+w*.31,y+.89,-.026,.065,.065,.043);
    piece(mas,box,stone[0],e,x,y-.09,.12,w+.34,.14,.44);
  }
  door(f,porchCenters[2],.40,1.28,2.34,.49);
  door(r,.65,.38,1.18,2.23,.33);
  piece(mas,block,stone[1],r,.65,.085,.34,1.65,.17,.75);

  function chimney() {
    const cx=-6.04,cz=4.09;
    const sides=[elevation(cx,cz+.64),elevation(cx+.78,cz,PI/2),elevation(cx,cz-.64,PI),elevation(cx-.78,cz,-PI/2)];
    const bands=[
      [.13,1.14,1.83,1.48],[1.14,4.49,1.60,1.29],[4.49,4.91,1.69,1.34],
      [4.91,6.37,1.38,1.18],[6.37,6.67,1.61,1.26],[6.67,9.52,1.01,.97],[9.52,9.86,1.31,1.18],[9.86,10.16,1.19,1.06],
    ];
    for (const [lo,hi,w,d] of bands) {
      mas.form(box,m.mortar,V(cx,(lo+hi)/2,cz),V(w-.05,hi-lo,d-.05));
      sides.forEach((e,i)=>{
        const along=i%2===0?w:d, off=i%2===0?(d-1.28)/2:(w-1.56)/2;
        const rows=Math.ceil((hi-lo)/.237);
        for(let rowId=0;rowId<rows;rowId++) {
          const h=(hi-lo)/rows;
          row(e,-along/2+.026,along/2-.026,lo+(rowId+.5)*h,h,off,.134,along>.9?.46:.35);
        }
      });
    }
    for(const [y,w,d,h] of [[.28,1.99,1.62,.21],[4.56,1.77,1.43,.15],[4.78,1.73,1.41,.10],[6.42,1.65,1.34,.16],[6.56,1.68,1.37,.118],[9.61,1.39,1.24,.16],[10.11,1.30,1.20,.10]]) {
      mas.form(block,stone[2],V(cx,y,cz),V(w,h,d));
    }
    for(const x of [cx-.25,cx+.25]){
      const bore = new T.LatheGeometry([
        new T.Vector2(.16,0),new T.Vector2(.19,.06),new T.Vector2(.17,.21),new T.Vector2(.22,.23),
        new T.Vector2(.22,.31),new T.Vector2(.14,.31),new T.Vector2(.14,.18),
      ],14);
      mas.bake(bore,stone[3],V(x,10.13,cz));
      mas.form(box,m.soot,V(x,10.148,cz),V(.27,.025,.27));
    }
    for(const [y,h,w,n] of [[1.30,.75,.30,.081],[3.25,.83,.25,.081],[5.36,.71,.27,.028]]) {
      const p=arch(0,y,w,h,.162);
      panel(mas,sides[0],p,m.soot,{depth:0,n,repeat:2.0});
      for(let i=0;i<p.length;i++){
        const a=p[i],b=p[(i+1)%p.length];
        mas.link(sides[0].p(...a,n+.005),sides[0].p(...b,n+.005),.062,.041,stone[4],block);
      }
    }
  }
  chimney();

  function porch() {
    const e=elevation(0,5.11);
    const spring=2.03, radius=1.092, rise=.87, out=.222;
    const l=-5.69,r=2.88, low=.45, high=3.155;
    const openings=porchCenters.map(x=>arch(x,low,2*radius,spring+rise-low,rise));
    panel(mas,e,[[l,.28],[r,.28],[r,high],[l,high]],stone[1],{holes:openings,depth:.27,n:-.01});
    for(let i=0;i<6;i++) {
      const y=2.99+i*.025;
      if(i===0||i===5) piece(mas,box,stone[2],e,(l+r)/2,y,.069,r-l,.044,.39);
    }
    const piers=[{x:-5.40,w:.41},{x:-2.692,w:.378},{x:-.045,w:.378},{x:2.594,w:.39}];
    for(const {x,w} of piers) {
      for(let i=0;i<8;i++) {
        const y=.48+(i+.5)*(spring-.485)/8;
        piece(mas,block,pick(stone),e,x,y,.015,w*(.94+random()*.07),.171,.42);
      }
      for(const [y,h,ww,dep] of [[.455,.16,w+.26,.59],[.565,.077,w+.16,.52],[1.871,.085,w+.087,.45],[2.006,.179,w+.16,.52]]) {
        piece(mas,block,stone[2],e,x,y,.034,ww,h,dep);
      }
    }
    for(const cx of porchCenters) {
      const aN=11;
      for(let j=0;j<aN;j++){
        const a=PI*j/aN+.024,b=PI*(j+1)/aN-.024;
        const rx=radius+.019,ry=rise+.015;
        const o=out*(j===Math.floor(aN/2)?1.10:1);
        const p=[[cx+cos(a)*rx,spring+sin(a)*ry],[cx+cos(a)*(rx+o),spring+sin(a)*(ry+o*.74)],
          [cx+cos(b)*(rx+o),spring+sin(b)*(ry+o*.74)],[cx+cos(b)*rx,spring+sin(b)*ry]];
        panel(mas,e,p,pick(stone),{depth:.337,n:.095,repeat:1.8});
      }
    }
    piece(mas,box,stone[0],e,(l+r)/2,.221,-.69,r-l+.27,.273,1.79);
    piece(mas,box,stone[2],e,(l+r)/2,.296,.08,r-l+.40,.122,.53);
    piece(mas,box,stone[1],e,-1.43,.107,.34,7.79,.195,.54);
    piece(mas,box,stone[2],e,-1.43,.183,.31,7.83,.047,.58);
    for(let rowId=0;rowId<3;rowId++){
      const depth=.41,zz=3.76+rowId*.428;
      for(let i=0;i<14;i++){
        const xx=l+.32+i*(r-l)/14;
        mas.form(box,pick(stone),V(xx,.363,zz),V((r-l)/14-.019,.043,depth-.014));
      }
    }
    const ceiling=3.071;
    for(let i=0;i<12;i++) wood.form(box,beams[i%beams.length],V(l+.39+i*.70,ceiling,4.42),V(.095,.15,1.51));
    for(const x of [-5.43,2.64]) wood.form(box,beams[1],V(x,ceiling,4.40),V(.15,.16,1.64));
  }
  porch();

  function canopy(cx,baseZ,w,h,depth,kind) {
    const zl=baseZ+.025, ze=baseZ+depth, L=cx-w/2,R=cx+w/2;
    const hi=h+(kind==='lower'?.36:.195), inset=.12*w;
    const e=elevation(0,ze);
    quad(house,m.tile,[V(L,h,ze),V(R,h,ze),V(R-inset,hi,zl),V(L+inset,hi,zl)]);
    const sideMaterial = m.tileTones[1];
    quad(house,sideMaterial,[V(L,h,zl),V(L,h,ze),V(L+inset,hi,zl),V(L,h,zl)]);
    quad(house,sideMaterial,[V(R,h,ze),V(R,h,zl),V(R-inset,hi,zl),V(R,h,ze)]);
    const nCols=Math.ceil(w/.228), nRows=4;
    const zSlope=depth/nRows;
    for(let r=0;r<nRows;r++){
      const f0=r/nRows,f1=min(1,(r+1.09)/nRows);
      const bottomL=L+inset*f0,bottomR=R-inset*f0;
      for(let k=0;k<nCols+1;k++){
        const span=(bottomR-bottomL)/nCols, st=max(bottomL,bottomL+span*(k-(r%2)*.5)),end=min(bottomR,bottomL+span*(k+1-(r%2)*.5));
        if(end-st<.023) continue;
        const mat=pick(m.tileTones), taper=inset*(f1-f0);
        const left=st+taper*(1-(st-bottomL)/(bottomR-bottomL)*2);
        const right=end+taper*(1-(end-bottomL)/(bottomR-bottomL)*2);
        quad(house,mat,[V(st+.012,h+(hi-h)*f0+.024,ze-r*zSlope+.018),V(end-.012,h+(hi-h)*f0+.024,ze-r*zSlope+.018),
          V(right-.009,h+(hi-h)*f1+.025,ze-f1*depth),V(left+.009,h+(hi-h)*f1+.025,ze-f1*depth)]);
      }
    }
    timber(e,L,h-.037,R,h-.037,.089,.100,.014,beams[1]);
  }

  function bay({cx,z,halfFront,halfBack,nose,y,h,colCount,kind}) {
    const e=elevation(cx,z+nose);
    panel(house,e,rect(0,y,halfFront*2,h),m.plaster,{holes:[rect(0,y+.31,halfFront*2-.22,h-.56)]});
    window(e,{x:0,y:y+.31,w:halfFront*2-.22,h:h-.56,cols:colCount,rows:4,diamond:true});
    for(const s of [-1,1]){
      const front=V(cx+s*halfFront,0,z+nose),back=V(cx+s*halfBack,0,z);
      const center=front.clone().lerp(back,.5), width=front.distanceTo(back);
      const d=front.clone().sub(back).multiplyScalar(-s);
      const skew=elevation(center.x,center.z,-Math.atan2(d.z,d.x));
      const spec={x:0,y:y+.31,w:width-.16,h:h-.56,cols:1,rows:4,diamond:true,trim:false};
      panel(house,skew,rect(0,y,width,h),m.plaster,{holes:windowHoles([spec]),depth:.12});
      window(skew,spec);
      for(const yy of [y+.08,y+.22,y+h-.081]) timber(skew,-width/2,yy,width/2,yy,.135,.121,.046,beams[1]);
      timber(e,s*halfFront,y+.07,s*halfFront,y+h,.154,.151,.039,beams[1],true);
      if (kind==='upper') {
        wood.link(V(cx+s*halfFront,y+.02,z+nose),V(cx+s*halfBack,y-.43,z+.055),.158,.151,beams[1],block);
      }
    }
    for(const yy of [y+.065,y+.22,y+h-.077])
      timber(e,-halfFront,yy,halfFront,yy,.147,.154,.054,beams[1]);
    timber(e,-halfFront-.13,y+.005,halfFront+.13,y+.005,.12,.18,.065,beams[1]);
    if(kind==='lower') for(let i=0;i<3;i++) row(e,-halfFront-.12,halfFront+.12,y-.225+i*.09,.105,.049,.17,.43);
    canopy(cx,z,halfBack*2+.38,y+h+.06,nose+.18,kind);
  }
  bay({cx:5.74,z:4.94,halfFront:1.05,halfBack:1.34,nose:.69,y:.38,h:2.11,colCount:4,kind:'lower'});
  bay({cx:5.92,z:4.94,halfFront:.67,halfBack:.84,nose:.45,y:3.18,h:2.07,colCount:3,kind:'upper'});
  bay({cx:-8.76,z:3.94,halfFront:.72,halfBack:.87,nose:.35,y:.39,h:1.97,colCount:3,kind:'wing'});

  function upperDormer() {
    const e=elevation(-2.25,2.855);
    const spec={x:0,y:7.368,w:.79,h:.63,cols:2,rows:3,crown:.097,trim:false};
    panel(house,e,[[-.66,7.33],[.66,7.33],[.66,8.005],[0,8.646],[-.66,8.005]],m.plaster,{holes:windowHoles([spec]),depth:.12});
    window(e,spec);
    timber(e,-.64,7.365,-.64,7.97,.125,.125,.046,beams[1]);
    timber(e,.64,7.365,.64,7.97,.125,.125,.046,beams[1]);
    timber(e,-.63,7.99,.00,8.596,.114,.103,.035,beams[1]);
    timber(e,.63,7.99,.00,8.596,.114,.103,.035,beams[1]);
    timber(e,-.65,8.015,.65,8.015,.101,.092,.029,beams[0]);
    const sideW=.74,slope=(9.9-6.35)/3.95;
    for(const s of [-1,1]) {
      const side=elevation(-2.25+s*.66,2.855-sideW/2,s*PI/2);
      const back=s*sideW/2,front=-s*sideW/2;
      panel(house,side,[[front,7.29],[back,7.29+slope*sideW],[back,8.02],[front,8.02]],m.plaster,{depth:.09});
    }
  }
  upperDormer();

  function tower() {
    const x=-1.65,z=-.15,half=1.235;
    for(const [i,e] of [
      elevation(x,z+half),elevation(x+half,z,PI/2),elevation(x,z-half,PI),elevation(x-half,z,-PI/2),
    ].entries()) {
      const wins=[{x:-.57,y:10.04,w:.57,h:.99,crown:.095,cols:2,rows:3,trim:false},
        {x:.55,y:10.04,w:.57,h:.99,crown:.095,cols:2,rows:3,trim:false}];
      if(i%2) wins.splice(1,1);
      panel(house,e,rect(0,8.85,half*2,2.42),m.plaster,{holes:windowHoles(wins),depth:.22,n:0});
      wins.forEach(spec=>window(e,spec));
      crosses(e,-half+.052,half-.052,8.9,11.27,[0],i%2?[[0,9.52,1.16,10.65]]:[]);
      for(const yy of [9.48,9.94,11.16]) timber(e,-half,yy,half,yy,.126,.127,.05,beams[1],true);
    }
  }
  tower();

  function planter(x,z,s,green) {
    const profile = [[0,0],[.27,0],[.30,.075],[.37,.475],[.41,.485],[.413,.56],[.36,.584],[.325,.545],[.32,.477],[0,.476]];
    const g = new T.LatheGeometry(profile.map(([x,y])=>new T.Vector2(x,y)),16);
    plants.form(g,m.pottery,V(x,.366,z),V(s,s,s));
    for(let i=0;i<54;i++) {
      const a=random()*2*PI,u=random()*2-1,r=Math.cbrt(random());
      const q=Math.sqrt(1-u*u)*r, size=.072+random()*.076,dy=(i<8?.12:0);
      plants.form(leaf,pick(green),V(x+cos(a)*q*.35*s,.366+(.77+u*r*.37+dy)*s,z+sin(a)*q*.35*s),
        V(size*s,size*s*.75,size*s),random()*PI,random()*PI,random()*PI);
    }
  }
  planter(-5.45,5.37,.62,m.leaves);planter(-2.71,5.36,.75,m.leaves);
  planter(-.06,5.36,.70,m.leaves);planter(2.62,5.32,.67,m.leaves);
  for(const [x,z,s] of [[-9.91,4.14,.53],[3.17,5.20,.48],[7.13,5.22,.53]]) planter(x,z,s,m.leaves);

  const result=new T.Group();
  result.name='Tudor villa';
  result.add(house.finish(),mas.finish(),wood.finish(),plants.finish());
  return result;
}
