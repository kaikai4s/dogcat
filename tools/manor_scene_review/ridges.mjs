// Coordinates of the approved painting, measured on a 1344 x 756 reference plane.
// The texture baker reads these same envelopes to exclude the village and the sky.
const CREST = '0:74 9:72 20:76 33:80 45:85 57:89 72:96 87:101 102:106 124:112 143:119 164:115 183:111 200:105 222:99 242:94 259:89 268:88 280:92 301:98 324:109 347:120 366:128 386:134 405:143 424:150 447:152 474:149 487:151 504:159 518:164 534:170 556:174 578:180 593:181 614:187 632:190 647:189 665:192 682:188 696:191 715:190 730:185 745:181 759:178 776:177 790:172 805:166 816:169 836:172 851:172 863:169 875:161 891:155 903:151 919:142 936:141 950:144 965:140 980:140 993:138 1011:135 1027:131 1041:131 1057:123 1071:119 1087:115 1104:113 1117:108 1133:109 1149:106 1164:101 1181:97 1196:93 1210:88 1224:83 1239:84 1253:87 1268:91 1284:93 1300:97 1314:97 1329:92 1344:91';
const CUT = '0:140 70:153 125:163 177:166 230:168 300:175 360:186 421:194 480:197 535:207 595:208 647:206 685:206 724:211 773:220 823:222 888:218 945:221 983:222 997:222 1022:222 1042:216 1090:207 1140:207 1210:196 1270:193 1344:191';
const parse = s=>s.split(' ').map(v=>v.split(':').map(Number));
const crest=parse(CREST),cut=parse(CUT),W=1344,H=756,F=.775;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=t=>{const s=clamp(t,0,1);return s*s*(3-2*s);};
function interp(points,x) {
  if(x<=0) return points[0][1];
  let l=0,h=points.length-1;
  while(h-l>1){const mid=(h+l)>>1; if(points[mid][0]>x)h=mid;else l=mid;}
  const [px,py]=points[l],[qx,qy]=points[h]; return mix(py,qy,clamp((x-px)/(qx-px),0,1));
}

export function addRidges(T,root,layout,textures) {
  const map=name=>textures instanceof Map?textures.get(name):textures[name];
  const slopes=map('ridge-slopes.jpg'), water=map('ridge-waterfall.png');
  if(!slopes || !water) throw new Error('Missing projected ridge artwork');
  const out=new T.Group();out.name='Reference sculpted highlands';root.add(out);
  const camera=new T.Vector3(31,30,149),forward=new T.Vector3(-70,-28,-245).normalize();
  const right=new T.Vector3().crossVectors(forward,new T.Vector3(0,1,0)).normalize();
  const up=new T.Vector3().crossVectors(right,forward).normalize();
  const fov=Math.tan(Math.PI*.1);
  function ray(px,py,d) {
    return camera.clone().addScaledVector(forward,d).addScaledVector(right,(px/W*2-1)*fov*16/9*d).addScaledVector(up,(1-py/H*2)*fov*d);
  }
  function sourceX(px) {return px<0?-px:px>W?2*W-px:px;}
  function crestDepth(x) {
    return 716+31*Math.sin(1.2+x*.0056)+13*Math.cos(x*.018)+7*Math.sin(x*.039);
  }
  function vertex(px,t,offset=0) {
    const x=sourceX(px), t0=Math.min(1,t/F), end=clamp((t-F)/(1-F),0,1), top=interp(crest,x), low=interp(cut,x);
    const apron=smooth((Math.abs(px-clamp(px,0,W))-135)/220), dd=crestDepth(x);
    const folds=17*Math.sin(x*.021+.7*t)+6*Math.sin(x*.047-1.8*t)+12*Math.sin(x*.007);
    const cliff=(1-smooth(Math.abs(x-1009)/74))*smooth((t0-.09)/.22);
    const regular=dd-(135+12*Math.sin(x*.012))*t0+folds*Math.sin(Math.PI*t0);
    const d=mix(regular,dd-38-16*t0,cliff)-end*(93+12*Math.cos(x*.012))-offset;
    const p=ray(px,mix(top,low,t0),d);
    if(end>0){
      const harmonic=(6*Math.sin(x*.018+.9*end)+4*Math.cos(x*.036-2*end))*Math.sin(Math.PI*end);
      p.y=mix(p.y,-6+Math.sin(x*.027)*2,smooth(end))+harmonic;
    }
    p.y=mix(p.y,-7,apron);
    return p;
  }
  const paint=new T.MeshBasicMaterial({name:'Reference painted sunlit ridge',map:slopes,vertexColors:true});
  const paintBack=new T.MeshStandardMaterial({name:'Shaded backs of the highlands',vertexColors:true,roughness:1,metalness:0});
  function grid(name,cols,rows,build,material,reverse=false) {
    const pos=[],uv=[],color=[],ix=[];
    for(let j=0;j<=rows;j++) for(let i=0;i<=cols;i++) {
      const [p,u,v,c]=build(i/cols,j/rows);pos.push(p.x,p.y,p.z);uv.push(u,v);color.push(...c);
      if(i<cols && j<rows){const a=j*(cols+1)+i,b=a+1,c0=a+cols+1,d=c0+1;
        if(reverse) ix.push(a,b,c0,b,d,c0);else ix.push(a,c0,b,b,c0,d);}
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setAttribute('color',new T.Float32BufferAttribute(color,3));g.setIndex(ix);g.computeVertexNormals();g.computeBoundingSphere();
    const m=new T.Mesh(g,material);m.name=name;out.add(m);return m;
  }
  // The front spans 200+ m of depth. The crest continues down a separate north
  // face, and both tips taper into the ground well outside the painting's frame.
  const xAt=u=>mix(-360,W+360,u);
  grid('Painted escarpments and wooded valley',354,42,(u,t)=>{
    const x=xAt(u), wing=Math.abs(x-clamp(x,0,W)),atten=smooth((wing-135)/220),p=vertex(x,t);
    const cp=p.clone().sub(camera),d=cp.dot(forward),py=(1-cp.dot(up)/(d*fov))*H*.5;
    const px=(1+cp.dot(right)/(d*fov*16/9))*W*.5;
    return [p,sourceX(px)/W,clamp(py/438,0,1),[1-atten*.25,1-atten*.19,1-atten*.16]];
  },paint);
  const backDark=new T.Color('#617b76'),backLight=new T.Color('#a1b391');
  grid('North-facing backs of the highlands',177,25,(u,t)=>{
    const x=xAt(u), a=vertex(x,0), far=80+19*Math.sin(x*.028)+12*Math.cos(x*.019);
    const p=a.clone().addScaledVector(forward,far*t);p.y=mix(a.y,-12,smooth(t))+(Math.sin(x*.031+t*8)*3+Math.cos(x*.053)*2)*Math.sin(t*Math.PI);
    const c=backDark.clone().lerp(backLight,clamp(.37+.18*t+.11*Math.cos(x*.022)+.05*Math.sin(x*.079+4*t),0,1));
    return [p,u,t,c.toArray()];
  },paintBack,true);

  const silk=new T.MeshStandardMaterial({name:'Reference waterfall curtain',map:water,transparent:true,depthWrite:false,side:T.DoubleSide,roughness:.43,metalness:0});
  const fallVertex=(x,y,off)=>vertex(x,clamp((y-interp(crest,x))/(interp(cut,x)-interp(crest,x))*F,0,F+.05),off);
  const curtain=grid('Spring cascade | projected water curtain',34,42,(u,v)=>{
    const x=mix(980,1050,u), y=mix(154,224,v), bulge=2.7+.87*Math.sin(v*Math.PI)+.35*Math.sin(30*u+.6*Math.sin(v*5));
    return [fallVertex(x,y,bulge),u,v,[1,1,1]];
  },silk);curtain.renderOrder=1;
  const poolColor=new T.MeshStandardMaterial({name:'Foam at the plunge pool',color:0xb1d4c9,roughness:.59});
  const pool=grid('Stony plunge shelf with whitewater',30,4,(u,v)=>{
    const a=u*Math.PI*2, r=v, center=fallVertex(998.8,218.3,3.5), rx=9.2,rz=3.0;
    const p=center.clone().addScaledVector(right,Math.cos(a)*r*rx).addScaledVector(forward,Math.sin(a)*r*rz);
    p.y+=.33*Math.sin(a*4+.7)*v+.22*(1-v);return [p,u,v,[1,1,1]];
  },poolColor);pool.material.side=T.DoubleSide;
  return out;
}
