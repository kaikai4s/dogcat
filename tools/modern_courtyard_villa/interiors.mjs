import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Metres in plan coordinates: east is +x, south is +z, floor surface is y=0.
const H = Math.PI / 2;
const material = (name, color, roughness = .78, options = {}) =>
  new THREE.MeshStandardMaterial({ name, color, roughness, ...options });
const wood = material('Furniture · warm walnut', 0x885a40);
const edge = material('Furniture · smoked walnut', 0x503528);
const pale = material('Furniture · pale oak', 0xb69068);
const rattan = material('Furniture · woven cane', 0xcaa97c);
const linen = material('Furniture · flax linen', 0xded1be, .98);
const chalk = material('Furniture · cotton and porcelain', 0xf4eade, .66);
const charcoal = material('Furniture · graphite', 0x3d4240);
const sage = material('Furniture · sage twill', 0x868e74, .95);
const moss = material('Furniture · ink green', 0x415c50, .95);
const rust = material('Furniture · fired clay and ochre', 0xad7153, .9);
const slate = material('Furniture · blue grey', 0x6b8487, .94);
const stone = material('Furniture · light travertine', 0xd1cbc0, .66);
const clay = material('Furniture · ceramic celadon', 0x7a9785, .36);
const brass = material('Furniture · bronze', 0xa88358, .43, { metalness: .56 });
const metal = material('Furniture · brushed nickel', 0x9b9d93, .38, { metalness: .63 });
const mirror = material('Furniture · smoked mirror', 0x9baea7, .23, { metalness: .36 });
const glass = material('Furniture · shower glass', 0xbdcfc5, .35,
  { transparent: true, opacity: .26, depthWrite: false });
const soil = material('Furniture · soil', 0x544d3f, .99);
const leaf = material('Furniture · pine and leaves', 0x405f46, .95);
const fresh = material('Furniture · young pine and grass', 0x708459, .97);
const diffuser = (name, color) => material('Lamp:' + name, color, .44,
  { emissive: color, emissiveIntensity: 1 });
const lamp = diffuser('Opal', 0xffd7a3);
const strip = diffuser('WarmLinear', 0xffbb80);
const theater = diffuser('MediaAccent', 0xe6a16f);

const cube = new THREE.BoxGeometry(1, 1, 1);
const sphere = new THREE.SphereGeometry(1, 10, 6);
const circle = new THREE.CylinderGeometry(1, 1, 1, 20);
const taper = new THREE.CylinderGeometry(1, .68, 1, 14);
const stemGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
const loopGeo = new THREE.TorusGeometry(1, .12, 6, 20);
const armGeo = new THREE.TorusGeometry(1, .065, 6, 20, Math.PI * 1.21);
const rounded = new Map();

function part(parent, geo, mat, x, y, z, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  parent.add(m);
  return m;
}
const box = (p, m, x, y, z, w, h, d) => part(p, cube, m, x, y, z, w, h, d);
const orb = (p, m, x, y, z, w, h, d) => part(p, sphere, m, x, y, z, w, h, d);
const disc = (p, m, x, y, z, r, h, geo = circle) => part(p, geo, m, x, y, z, r, h, r);
function soft(p, m, x, y, z, w, h, d, radius = .045) {
  const r = Math.min(radius, w / 2, h / 2, d / 2) * .98;
  const key = [w, h, d, r].join(',');
  if (!rounded.has(key)) rounded.set(key, new RoundedBoxGeometry(w, h, d, 1, r));
  return part(p, rounded.get(key), m, x, y, z);
}
function place(p, x, z, yaw = 0, y = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  p.add(g);
  return g;
}
function rod(p, m, a, b, radius) {
  const d = new THREE.Vector3(...b).sub(new THREE.Vector3(...a));
  const n = part(p, stemGeo, m, a[0] + d.x / 2, a[1] + d.y / 2, a[2] + d.z / 2,
    radius, d.length(), radius);
  n.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, d.normalize());
}
function rug(p, x, z, w, d, mat = linen) {
  box(p, pale, x, .007, z, w + .09, .014, d + .09);
  box(p, mat, x, .015, z, w, .012, d);
  for (const s of [-1, 1]) box(p, chalk, x + s * (w / 2 - .10), .022, z, .016, .002, d - .09);
}
function legs(p, w, d, h, mat = edge, spread = .075) {
  for (const x of [-w / 2 + spread, w / 2 - spread]) for (const z of [-d / 2 + spread, d / 2 - spread]) {
    box(p, mat, x, h / 2, z, .047, h, .047);
  }
}
function table(p, x, z, w, d, h, yaw = 0, top = wood) {
  const g = place(p, x, z, yaw);
  legs(g, w, d, h - .035);
  soft(g, top, 0, h - .033, 0, w, .066, d, .031);
  return g;
}
function roundTable(p, x, z, r, h, top = wood) {
  const g = place(p, x, z);
  disc(g, edge, 0, .035, 0, r * .64, .07);
  disc(g, wood, 0, h / 2, 0, r * .22, h);
  disc(g, top, 0, h - .028, 0, r, .056);
  return g;
}
function pillow(p, mat, x, y, z, w = .36, roll = 0) {
  const m = soft(p, mat, x, y, z, w, .31, .12, .048);
  m.rotation.set(-.19, 0, roll);
}
function sofa(p, x, z, w, d, yaw, fabric, accent = sage, chaise = false) {
  const g = place(p, x, z, yaw);
  const n = Math.max(1, Math.round(w / .86));
  const seat = (w - .26) / n;
  legs(g, w, d, .15);
  soft(g, wood, 0, .205, 0, w, .12, d);
  soft(g, fabric, 0, .40, 0, w, .29, d);
  soft(g, fabric, 0, .64, -.34 * d, w - .08, .49, .24);
  for (const s of [-1, 1]) soft(g, fabric, s * (w / 2 - .065), .52, .02, .13, .26, d - .07);
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * seat;
    soft(g, fabric, a, .52, .055, seat - .022, .115, d - .25);
    soft(g, fabric, a, .70, -.235 * d, seat - .023, .34, .11);
  }
  if (n > 1) pillow(g, accent, -.29 * w, .70, -.08, .34, .2);
  pillow(g, n === 1 ? accent : linen, .27 * (n > 1 ? w : 0), .69, -.08, .32, -.15);
  if (chaise) {
    const a = w / 2 - .49;
    soft(g, wood, a, .205, d / 2 + .24, .84, .12, .57);
    soft(g, fabric, a, .39, d / 2 + .24, .84, .26, .57);
    soft(g, fabric, a, .52, d / 2 + .21, .81, .11, .60);
    for (const dx of [-.31, .31]) box(g, edge, a + dx, .09, d / 2 + .43, .055, .18, .055);
  }
  return g;
}
function chair(p, x, z, yaw, seat = linen, wrap = false) {
  const g = place(p, x, z, yaw);
  const w = wrap ? .67 : .48;
  const d = wrap ? .66 : .49;
  legs(g, w, d, .39);
  soft(g, wood, 0, .395, 0, w, .07, d);
  soft(g, seat, 0, .455, .015, w - .075, .08, d - .08);
  if (wrap) {
    const a = part(g, armGeo, wood, 0, .690, -.015, .35, .295, .35);
    a.rotation.set(-H, 0, Math.PI * -.105);
    for (const dx of [-.303, .303]) rod(g, wood, [dx, .41, .01], [dx, .69, .02], .024);
    soft(g, rattan, 0, .59, -.267, .42, .29, .064);
  } else {
    for (const dx of [-.19, .19]) box(g, wood, dx, .62, -.205, .042, .45, .043);
    soft(g, rattan, 0, .706, -.21, .37, .225, .055);
  }
  return g;
}
function paddedBench(p, x, z, w, d, yaw, mat = linen) {
  const g = table(p, x, z, w, d, .40, yaw);
  soft(g, mat, 0, .432, 0, w - .09, .078, d - .075);
  return g;
}
function cabinet(p, x, z, w, d, h, yaw = 0, count = 2, finish = wood, top = finish) {
  const g = place(p, x, z, yaw);
  box(g, edge, 0, .048, 0, w - .10, .096, d - .10);
  box(g, finish, 0, h / 2 + .028, 0, w, h - .093, d - .031);
  const door = (w - .034) / count;
  for (let i = 0; i < count; i++) {
    const a = (i - (count - 1) / 2) * door;
    box(g, i % 2 ? finish : pale, a, h / 2 + .032, d / 2 - .012, door - .013, h - .133, .026);
    box(g, brass, a + door * .27, h > 1.25 ? 1.05 : h * .72, d / 2 + .012,
      .019, h > 1.25 ? .16 : .061, .026);
  }
  soft(g, top, 0, h - .024, 0, w + .026, .048, d + .018, .017);
  return g;
}
function books(p, x, y, z, n, width, height = .24) {
  const colors = [sage, chalk, rust, edge, slate];
  for (let i = 0; i < n; i++) {
    const h = height * (.67 + .10 * ((i * 13) % 4));
    const a = x + i * width;
    box(p, colors[i % colors.length], a, y + h / 2, z, width - .009, h, .157);
    box(p, pale, a, y + .041, z + .080, width - .014, .013, .006);
  }
}
function bookcase(p, x, z, w, d, h, yaw = 0, bays = 2) {
  const g = place(p, x, z, yaw);
  box(g, edge, 0, h / 2, -d / 2 + .025, w, h, .05);
  const bw = w / bays;
  for (let i = 0; i <= bays; i++) box(g, wood, -w / 2 + bw * i, h / 2, 0, .053, h, d);
  for (let row = 0; row <= 3; row++) {
    const y = .075 + row * (h - .095) / 3;
    box(g, wood, 0, y, 0, w, .054, d);
    if (row === 3) continue;
    for (let col = 0; col < bays; col++) {
      const a = -w / 2 + col * bw;
      if ((row + col) % 3 === 1) {
        disc(g, clay, a + bw * .56, y + .14, .03, .079, .22, taper);
      } else books(g, a + .10, y + .028, .04, Math.min(7, Math.floor((bw - .12) / .069)), .069, Math.min(h * .22, .33));
    }
  }
  return g;
}
function cup(p, x, y, z, mat = chalk, r = .046) {
  disc(p, mat, x, y + r * .57, z, r, r * 1.14, taper);
  disc(p, edge, x, y + r * 1.15, z, r * .78, .004);
  part(p, loopGeo, mat, x + r * .97, y + r * .58, z, r * .44, r * .49, r * .49);
}
function teaSet(p, y) {
  soft(p, edge, 0, y + .018, 0, .43, .036, .27, .017);
  orb(p, clay, -.081, y + .120, -.035, .087, .081, .082);
  disc(p, clay, -.081, y + .198, -.035, .043, .022);
  rod(p, clay, [-.142, y + .116, -.035], [-.212, y + .174, -.035], .02);
  part(p, loopGeo, clay, -.008, y + .141, -.035, .049, .061, .059);
  for (const [x, z] of [[.09, -.054], [.087, .075], [-.019, .072]]) cup(p, x, y + .034, z, chalk, .034);
}
function vase(p, x, y, z, mat = clay, h = .30) {
  orb(p, mat, x, y + h * .37, z, h * .275, h * .37, h * .25);
  disc(p, mat, x, y + h * .78, z, h * .12, h * .31);
  for (let i = 0; i < 3; i++) {
    const a = (i - 1) * h * .33;
    rod(p, edge, [x, y + h * .86, z], [x + a, y + h * (1.43 + .17 * i), z + a / 2], .006);
    orb(p, i % 2 ? fresh : moss, x + a * 1.08 + .018, y + h * (1.45 + .17 * i), z + a / 2,
      h * .16, h * .076, h * .099);
  }
}
function plant(p, x, z, h = .75, kind = 'grass') {
  const g = place(p, x, z);
  const r = h * .235;
  disc(g, kind === 'pine' ? stone : charcoal, 0, h * .14, 0, r, h * .28, taper);
  disc(g, soil, 0, h * .283, 0, r * .91, .018);
  foliage(g, 0, h * .28, 0, h, kind);
}
function foliage(g, x, y, z, h, kind) {
  const pine = kind === 'pine';
  if (pine) rod(g, edge, [x, y, z], [x + h * .09, y + h * .64, z], h * .042);
  for (let i = 0; i < (pine ? 6 : 9); i++) {
    const a = i * 2.399963;
    const r = h * (.12 + (i % 5) * .042);
    const dx = Math.cos(a) * r;
    const dz = Math.sin(a) * r;
    const tall = h * (.32 + (i % 4) * .13);
    rod(g, pine ? edge : moss, [x, y + (pine ? tall * .55 : 0), z], [x + dx, y + tall, z + dz], h * (pine ? .017 : .009));
    const l = orb(g, i % 3 === 1 ? fresh : leaf, x + dx, y + tall, z + dz,
      h * (pine ? .20 : .052), h * (pine ? .095 : .19), h * (pine ? .155 : .034));
    if (!pine) l.rotation.set(Math.sin(a) * .55, a, -Math.cos(a) * .55);
  }
}
function planter(p, x, z, w, d, kinds) {
  const g = place(p, x, z);
  soft(g, stone, 0, .165, 0, w, .33, d, .055);
  box(g, soil, 0, .335, 0, w - .09, .014, d - .09);
  kinds.forEach((kind, i) => foliage(g, (i - (kinds.length - 1) / 2) * (w - .28) / kinds.length,
    .335, 0, kind === 'pine' ? .84 : .50 + .09 * (i % 2), kind));
}
function pendant(p, x, z, top, shade) {
  disc(p, brass, x, top - .018, z, .08, .035);
  rod(p, brass, [x, shade + .13, z], [x, top - .034, z], .012);
  disc(p, wood, x, shade + .094, z, .141, .074, taper);
  orb(p, lamp, x, shade, z, .157, .10, .157);
}
function linear(p, x, z, w, ceiling, height) {
  for (const a of [-w * .36, w * .36]) {
    box(p, brass, x + a, (ceiling + height) / 2, z, .012, ceiling - height, .012);
    disc(p, brass, x + a, ceiling - .018, z, .047, .033);
  }
  box(p, edge, x, height, z, w, .075, .096);
  box(p, strip, x, height - .038, z, w - .066, .021, .068);
}
function pin(p, x, z, ceiling) {
  disc(p, brass, x, ceiling - .039, z, .085, .070);
  disc(p, lamp, x, ceiling - .078, z, .066, .014);
}
function standingLamp(p, x, z, h, yaw = 0, base = 0) {
  const g = place(p, x, z, yaw, base);
  disc(g, charcoal, 0, .024, 0, .126, .048);
  rod(g, brass, [0, .045, 0], [0, h, 0], .016);
  rod(g, brass, [0, h, 0], [.15, h, .03], .013);
  disc(g, wood, .15, h - .040, .03, .138, .12, taper);
  disc(g, lamp, .15, h - .106, .03, .102, .036);
}
function nightstand(p, x, z, yaw, y = .52, color = wood) {
  const g = cabinet(p, x, z, .46, .42, y, yaw, 1, color, color);
  disc(g, brass, 0, y + .017, 0, .069, .031);
  disc(g, charcoal, 0, y + .078, 0, .021, .119);
  orb(g, lamp, 0, y + .164, 0, .104, .103, .104);
}
function bed(p, x, z, w, yaw, mat, runner = linen, long = 2.10) {
  const g = place(p, x, z, yaw);
  legs(g, w + .05, long, .17);
  soft(g, edge, 0, .24, 0, w + .105, .23, long + .093);
  soft(g, chalk, 0, .436, .009, w, .235, long);
  soft(g, wood, 0, .62, -long / 2 - .027, w + .19, 1.189, .11);
  soft(g, linen, 0, .67, -long / 2 + .043, w - .035, .62, .073);
  soft(g, mat, 0, .568, .264, w + .03, .10, long - .51);
  soft(g, runner, 0, .623, .691, w + .05, .045, .43);
  for (const s of [-1, 1]) {
    const cushion = soft(g, chalk, s * w * .239, .602, -.722, w * .413, .143, .38, .066);
    cushion.rotation.x = .105;
    const accent = soft(g, runner, s * w * .25, .656, -.53, .292, .132, .245);
    accent.rotation.y = s * .15;
  }
  return g;
}
function writing(p, x, z, yaw, w = 1.28, d = .59, mat = wood) {
  const g = table(p, x, z, w, d, .75, yaw, mat);
  box(g, charcoal, -.17, .761, -.02, .40, .022, .27);
  box(g, chalk, -.22, .78, -.012, .22, .019, .16).rotation.y = -.14;
  const a = w * .352;
  disc(g, edge, a, .763, -.12, .096, .026);
  rod(g, brass, [a, .78, -.12], [a, 1.12, -.12], .013);
  rod(g, brass, [a, 1.12, -.12], [a - .14, 1.13, -.06], .013);
  disc(g, edge, a - .155, 1.119, -.057, .084, .055, taper);
  disc(g, lamp, a - .155, 1.085, -.057, .063, .017);
  return g;
}
function artwork(p, x, z, y, w, h, yaw, hanging = false) {
  const g = place(p, x, z, yaw);
  box(g, hanging ? linen : edge, 0, y, 0, w, h, .037);
  box(g, chalk, 0, y, .023, w - .064, h - .064, .021);
  const peaks = [[-.45, -.36], [-.39, -.12], [-.24, .18], [-.08, -.05], [.067, .30], [.24, .004], [.43, -.31]];
  for (const [mat, shift, scale, depth] of [[slate, .10, .88, .035], [moss, 0, .92, .04], [sage, -.13, .55, .045]]) {
    const shape = new THREE.Shape();
    shape.moveTo(-w * .45, y - h * .41);
    for (const [px, py] of peaks) shape.lineTo(px * w, y + (py * scale + shift) * h);
    shape.lineTo(w * .43, y - h * .41);
    shape.closePath();
    part(g, new THREE.ShapeGeometry(shape), mat, 0, 0, depth);
  }
  disc(g, rust, w * .23, y + h * .245, .043, Math.min(w, h) * .05, .012).rotation.x = H;
  if (hanging) for (const s of [-1, 1]) rod(g, edge, [-w * .55, y + s * h / 2, .022], [w * .55, y + s * h / 2, .022], .024);
}
function lattice(p, x, z, w, h, yaw, mat = wood) {
  const g = place(p, x, z, yaw);
  for (const y of [.075, h - .053]) box(g, edge, 0, y, 0, w, .104, .077);
  const n = Math.ceil(w / .087);
  for (let i = 0; i <= n; i++) box(g, mat, -w / 2 + i * w / n, h / 2, 0, .035, h, .059);
}
function basin(p, x, y, z, w, d) {
  soft(p, stone, x, y + .019, z, w + .044, .039, d + .038, .019);
  soft(p, mirror, x, y + .045, z, w, .027, d, .013);
  soft(p, chalk, x, y + .061, z, w - .075, .013, d - .07, .0065);
  disc(p, metal, x, y + .071, z, .018, .006);
  rod(p, metal, [x, y + .042, z - d / 2 - .028], [x, y + .22, z - d / 2 - .028], .013);
  rod(p, metal, [x, y + .22, z - d / 2 - .028], [x, y + .22, z - d / 2 + .080], .013);
  rod(p, metal, [x, y + .22, z - d / 2 + .080], [x, y + .182, z - d / 2 + .080], .012);
}
function vanity(p, x, z, w, yaw = 0, finish = wood) {
  const g = cabinet(p, x, z, w, .47, .83, yaw, 2, finish, stone);
  basin(g, -.07 + w * .11, .818, .013, Math.min(w * .62, .55), .31);
  soft(g, edge, 0, 1.468, -.207, w - .07, .73, .038);
  soft(g, mirror, 0, 1.468, -.178, w - .114, .682, .027);
  box(g, brass, 0, 1.885, -.147, w - .15, .06, .103);
  box(g, lamp, 0, 1.851, -.123, w - .21, .016, .062);
  disc(g, clay, -w * .325, .902, .09, .038, .122);
  disc(g, brass, -w * .325, .968, .09, .022, .018);
  return g;
}
function toilet(p, x, z, yaw) {
  const g = place(p, x, z, yaw);
  soft(g, chalk, 0, .34, -.11, .326, .67, .206);
  soft(g, chalk, 0, .15, .06, .248, .30, .335);
  orb(g, chalk, 0, .3, .13, .188, .15, .266);
  const ring = part(g, loopGeo, chalk, 0, .439, .139, .154, .207, .19);
  ring.rotation.x = -H;
  orb(g, mirror, 0, .401, .139, .13, .037, .181);
  disc(g, metal, 0, .68, -.112, .024, .014);
}
function shower(p, x, z, yaw = -H) {
  const g = place(p, x, z, yaw);
  soft(g, stone, 0, .032, 0, 1.0, .064, 1.04);
  for (const a of [-.48, .48]) {
    box(g, edge, a, .974, 0, .031, 1.867, 1.034);
    box(g, glass, a, 1.01, .005, .042, 1.77, 1.005);
  }
  rod(g, metal, [0, .94, -.447], [0, 2.01, -.447], .017);
  rod(g, metal, [0, 2.01, -.447], [0, 2.01, -.17], .016);
  disc(g, metal, 0, 1.984, -.17, .116, .026);
  box(g, charcoal, .25, .071, .25, .082, .017, .082);
}
function towelRail(p, x, z, y, yaw) {
  const g = place(p, x, z, yaw);
  rod(g, brass, [-.30, y, 0], [.30, y, 0], .015);
  for (const a of [-.27, .27]) box(g, brass, a, y, -.04, .047, .044, .092);
  soft(g, linen, -.061, y - .152, .017, .272, .317, .049, .016);
  box(g, sage, -.061, y - .258, .044, .251, .035, .005);
}

// Batch each room by finish to keep the furniture detailed without a draw call per cushion.
function room(parent, name, build) {
  const parts = new THREE.Group();
  build(parts);
  parts.updateMatrixWorld(true);
  const batches = new Map();
  parts.traverse((m) => {
    if (!m.isMesh) return;
    if (!batches.has(m.material)) batches.set(m.material, []);
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.deleteAttribute('uv');
    batches.get(m.material).push(g.applyMatrix4(m.matrixWorld));
  });
  const g = new THREE.Group();
  g.name = name;
  for (const [mat, copies] of batches) {
    const combined = mergeGeometries(copies);
    copies.forEach((copy) => copy.dispose());
    const indexed = mergeVertices(combined, .0001);
    combined.dispose();
    const m = new THREE.Mesh(indexed, mat);
    m.name = name + ' · ' + mat.name;
    m.castShadow = !mat.transparent && !mat.name.startsWith('Lamp:');
    m.receiveShadow = !mat.transparent;
    g.add(m);
  }
  parent.add(g);
}

function laundryUnit(p, x, z, mat) {
  const g = place(p, x, z);
  soft(g, chalk, 0, .43, 0, .60, .86, .63);
  disc(g, metal, 0, .38, .327, .208, .055).rotation.x = H;
  disc(g, charcoal, 0, .38, .363, .175, .031).rotation.x = H;
  disc(g, mat, 0, .38, .382, .135, .018).rotation.x = H;
  disc(g, brass, -.199, .748, .318, .043, .025).rotation.x = H;
  box(g, charcoal, .112, .746, .321, .19, .055, .013);
}
function planterLight(p, x, z) {
  box(p, charcoal, x, .19, z, .089, .38, .088);
  box(p, strip, x, .32, z + .044, .050, .064, .012);
}

function firstFloor(p) {
  room(p, '玄关', (g) => {
    rug(g, 7.75, 2.99, .66, 4.55, sage);
    paddedBench(g, 7.11, .79, .97, .25, H);
    artwork(g, 7.0, .785, 1.37, .73, .64, H);
    disc(g, brass, 7.14, .179, 2.86, .147, .357, taper);
    disc(g, charcoal, 7.14, .355, 2.86, .128, .019);
    rod(g, moss, [7.14, .075, 2.86], [7.14, .72, 2.77], .018);
    rod(g, edge, [7.15, .074, 2.86], [7.16, .63, 2.92], .018);
    box(g, strip, 7.01, .113, .80, .025, .025, .78);
    pin(g, 7.76, .82, 3.32);
    pin(g, 7.76, 3.51, 3.32);
  });
  room(p, '厨房', (g) => {
    const work = cabinet(g, .51, 1.70, 2.91, .64, .91, H, 5, wood, stone);
    basin(work, -.69, .905, 0, .47, .36);
    soft(work, charcoal, .62, .929, -.02, .57, .028, .43, .014);
    for (const [x, z, r] of [[.48, -.124, .081], [.77, -.124, .086], [.48, .085, .063], [.77, .085, .063]]) {
      disc(work, metal, x, .947, z, r, .006);
      disc(work, charcoal, x, .952, z, r - .012, .006);
    }
    cabinet(g, .34, 1.68, 2.81, .35, .67, H, 5, wood).position.y = 1.54;
    box(g, strip, .49, 1.538, 1.68, .046, .018, 2.67);
    const tall = cabinet(g, 3.67, .441, .84, .56, 2.26, 0, 2, wood);
    box(tall, charcoal, 0, 1.26, .295, .67, .38, .033);
    box(tall, metal, 0, 1.383, .328, .532, .017, .036);
    const island = cabinet(g, 2.40, 1.67, 1.64, .70, .91, 0, 3, wood, stone);
    soft(island, pale, -.255, .929, -.05, .42, .035, .29, .016);
    disc(island, clay, .32, .957, .07, .147, .093, taper);
    for (let i = 0; i < 3; i++) orb(island, i % 2 ? rust : fresh, .24 + i * .068, 1.02, .07 + .035 * (i % 2), .044, .044, .044);
    linear(g, 2.40, 1.67, 1.42, 3.32, 2.34);
  });
  room(p, '家政 / 洗衣储藏', (g) => {
    laundryUnit(g, 4.81, .50, slate);
    laundryUnit(g, 5.43, .50, mirror);
    box(g, stone, 5.12, .889, .52, 1.26, .054, .66);
    const c = cabinet(g, 4.68, 2.45, 1.44, .62, 2.20, H, 3, pale);
    box(c, strip, 0, .114, .321, 1.31, .019, .021);
    disc(g, rattan, 5.94, .242, .48, .221, .48, taper);
    disc(g, linen, 5.94, .49, .48, .201, .035);
    box(g, linen, 4.81, .955, .47, .29, .084, .254);
    box(g, slate, 4.82, .998, .47, .26, .024, .222);
    pin(g, 5.78, 1.68, 3.32);
  });
  room(p, '餐厅', (g) => {
    const dining = table(g, 3.44, 5.31, 3.46, 1.01, .75);
    box(dining, linen, 0, .757, 0, 2.57, .014, .231);
    vase(dining, -.22, .765, 0, clay, .24);
    for (const x of [-1.10, 0, 1.10]) for (const s of [-1, 1]) {
      disc(dining, clay, x, .764, s * .296, .115, .019);
      disc(dining, chalk, x, .777, s * .296, .087, .012);
      chair(g, 3.44 + x, 5.31 + s * .838, s === 1 ? Math.PI : 0, linen);
    }
    for (const s of [-1, 1]) {
      disc(dining, clay, s * 1.508, .764, 0, .115, .019);
      disc(dining, chalk, s * 1.508, .777, 0, .087, .012);
      chair(g, 3.44 + s * 2.015, 5.31, -s * H, linen);
    }
    const c = cabinet(g, 5.43, 3.74, 1.83, .48, .77, 0, 3, wood, stone);
    vase(c, .62, .776, .034, rust, .30);
    artwork(g, 5.37, 3.51, 1.47, 1.33, .75, 0);
    linear(g, 3.44, 5.31, 2.78, 3.32, 2.18);
  });
  room(p, '客厅', (g) => {
    rug(g, 3.33, 10.39, 5.18, 3.47, sage);
    sofa(g, 3.26, 9.05, 3.66, .97, 0, linen, moss);
    chair(g, 1.09, 10.92, 1.78, linen, true);
    chair(g, 5.52, 11.10, -1.88, linen, true);
    const tea = table(g, 3.29, 10.66, 1.67, .75, .37, 0, edge);
    teaSet(tea, .37);
    soft(tea, moss, .55, .38, .073, .27, .041, .185);
    const c = cabinet(g, 6.56, 12.10, 2.04, .46, .57, -H, 3, wood, stone);
    vase(c, -.68, .576, .019, clay, .38);
    artwork(g, 6.797, 12.11, 1.55, 1.72, .95, -H);
    plant(g, .62, 12.53, .94, 'pine');
    standingLamp(g, 5.76, 9.19, 1.64, -1.5);
    pendant(g, 2.83, 10.19, 3.32, 2.49);
    pendant(g, 3.69, 10.62, 3.32, 2.56);
  });
  room(p, '客房 / 长辈房', (g) => {
    rug(g, 14.32, 2.36, 2.40, 2.45, chalk);
    bed(g, 14.24, 1.92, 1.50, H, sage, rust, 2.03);
    nightstand(g, 13.36, 2.99, H);
    cabinet(g, 15.58, 4.12, 1.61, .55, 2.18, -H, 3);
    chair(g, 15.38, .77, -.96, sage, true);
    artwork(g, 13.01, 1.91, 1.69, 1.08, .66, H);
    pin(g, 14.59, 3.11, 3.32);
  });
  room(p, '一层公卫', (g) => {
    vanity(g, 14.80, 5.61, 1.03);
    toilet(g, 13.64, 7.01, Math.PI);
    shower(g, 15.28, 6.68);
    towelRail(g, 14.42, 7.24, 1.24, Math.PI);
    pin(g, 14.20, 6.37, 3.31);
  });
  room(p, '茶室', (g) => {
    const platform = place(g, 14.46, 12.36);
    soft(platform, edge, 0, .077, 0, 2.75, .154, 2.69);
    soft(platform, pale, 0, .166, 0, 2.72, .052, 2.65, .025);
    for (let i = 0; i < 6; i++) box(platform, rattan, -.98 + i * .39, .194, 0, .378, .008, 2.49);
    box(platform, strip, 0, .103, -1.349, 2.43, .021, .018);
    const seatZone = place(g, 14.46, 12.34, 0, .20);
    const tea = table(seatZone, .005, .022, 1.25, .61, .38, 0, edge);
    teaSet(tea, .38);
    for (const x of [-.40, .40]) for (const z of [-.67, .67]) {
      soft(seatZone, z < 0 ? moss : linen, x, .097, z, .54, .194, .43, .083);
    }
    lattice(g, 13.05, 10.98, .94, 2.34, H);
    const c = cabinet(g, 14.51, 7.69, 1.72, .49, .54, 0, 3);
    vase(c, .59, .547, .016, chalk, .32);
    artwork(g, 14.40, 7.472, 1.62, .77, 1.42, 0, true);
    pendant(g, 14.48, 12.34, 3.32, 2.36);
  });
  room(p, '一层过厅', (g) => {
    lattice(g, 10.00, 9.17, 1.63, 2.38, 0);
    const c = cabinet(g, 10.17, 11.89, 1.64, .42, .57, 0, 3, wood, stone);
    vase(c, .32, .58, -.018, clay, .33);
    pin(g, 7.77, 7.82, 3.32);
    pin(g, 7.78, 11.86, 3.32);
    pin(g, 11.96, 4.18, 3.32);
  });
}

function secondFloor(p) {
  room(p, '次卧 A', (g) => {
    rug(g, 2.05, 2.46, 2.81, 2.63, chalk);
    bed(g, 1.97, 1.82, 1.50, H, slate, moss, 2.03);
    nightstand(g, 1.02, 2.94, H);
    cabinet(g, 5.13, .49, 2.20, .61, 2.23, 0, 4);
    writing(g, 5.52, 2.12, -H, 1.40, .57, pale);
    chair(g, 4.83, 2.14, H, slate);
    artwork(g, .11, 3.80, 1.53, .65, .83, H);
    pin(g, 3.39, 2.75, 3.02);
  });
  room(p, '次卧 B', (g) => {
    rug(g, 14.48, 6.01, 2.78, 2.32, linen);
    bed(g, 14.23, 5.99, 1.50, H, chalk, rust, 2.03);
    nightstand(g, 13.34, 4.99, H);
    writing(g, 15.56, 9.04, -H, 1.31, .59, wood);
    chair(g, 14.80, 9.02, H, rust);
    cabinet(g, 13.35, 9.66, 1.38, .52, 2.19, H, 2);
    bookcase(g, 13.25, 11.61, 1.23, .29, .84, H);
    plant(g, 15.49, 12.74, .69);
    artwork(g, 14.78, 4.12, 1.49, .86, .62, 0);
    pin(g, 14.70, 7.19, 3.02);
    pin(g, 14.50, 11.57, 3.02);
  });
  room(p, '主卧套房', (g) => {
    rug(g, 5.12, 10.83, 2.72, 2.98, linen);
    const headwall = place(g, 6.785, 10.80, -H);
    box(headwall, wood, 0, .97, 0, 2.66, 1.92, .065);
    for (const s of [-1, 1]) for (let i = 0; i < 5; i++) box(headwall, edge, s * (.96 + i * .074), .98, .043, .023, 1.86, .035);
    box(headwall, strip, 0, 1.929, .053, 2.57, .018, .019);
    bed(g, 5.56, 10.80, 1.83, -H, linen, moss, 2.12);
    nightstand(g, 6.48, 9.56, -H, .54);
    nightstand(g, 6.48, 12.02, -H, .54);
    paddedBench(g, 4.14, 10.80, 1.17, .42, -H, sage);
    writing(g, .91, 7.946, 0, 1.37, .56, wood);
    chair(g, .92, 8.68, Math.PI, linen);
    chair(g, 1.04, 10.76, .84, moss, true);
    const end = roundTable(g, 1.81, 10.62, .264, .47, stone);
    cup(end, 0, .47, 0);
    standingLamp(g, .60, 11.43, 1.49, 1.25);
    cabinet(g, .62, 12.60, 1.47, .36, .69, H, 3, wood, stone);
    pin(g, 3.46, 11.54, 3.02);
  });
  room(p, '主卫', (g) => {
    vanity(g, .85, 5.38, 1.34);
    shower(g, 2.52, 5.72);
    toilet(g, .38, 6.98, H);
    towelRail(g, 1.13, 7.436, 1.29, Math.PI);
    pin(g, 1.68, 6.47, 3.02);
  });
  room(p, '衣帽间', (g) => {
    cabinet(g, 4.36, 5.44, 2.17, .59, 2.23, 0, 4);
    paddedBench(g, 3.49, 6.84, 1.02, .36, H, sage);
    const fit = place(g, 5.48, 6.78, -H);
    box(fit, edge, 0, 1.23, 0, .62, 1.62, .042);
    box(fit, mirror, 0, 1.23, .027, .55, 1.54, .017);
    linear(g, 4.36, 6.45, 1.38, 3.02, 2.70);
  });
  room(p, '家庭卫浴', (g) => {
    vanity(g, 13.28, 1.23, 1.35, H);
    shower(g, 15.28, .94);
    toilet(g, 15.40, 3.66, Math.PI);
    towelRail(g, 15.86, 2.14, 1.27, -H);
    pin(g, 14.58, 2.59, 3.02);
  });
  room(p, '二层家庭厅', (g) => {
    rug(g, 8.11, 10.62, 2.27, 2.82, chalk);
    sofa(g, 7.84, 10.49, 1.78, .80, H, sage, linen);
    const coffee = roundTable(g, 8.83, 10.46, .35, .42, stone);
    teaSet(coffee, .42);
    bookcase(g, 12.64, 10.47, 1.62, .35, .96, -H);
    standingLamp(g, 7.74, 11.74, 1.58, H);
    plant(g, 12.22, 12.16, .77);
    pendant(g, 8.41, 10.48, 3.02, 2.39);
    pin(g, 10.42, 12.46, 3.02);
    pin(g, 12.14, 4.51, 3.02);
  });
  room(p, '南向阳台', (g) => {
    chair(g, 2.18, 15.02, 1.47, linen, true);
    chair(g, 3.77, 15.02, -1.36, sage, true);
    const tea = roundTable(g, 2.96, 15.00, .31, .52, stone);
    teaSet(tea, .52);
    planter(g, .88, 15.34, 1.05, .44, ['grass', 'grass']);
    plant(g, 15.57, 15.34, .67, 'pine');
    planterLight(g, 4.13, 15.66);
  });
}

function thirdFloor(p) {
  room(p, '书房', (g) => {
    rug(g, 2.70, 2.90, 3.67, 2.60, chalk);
    bookcase(g, 2.67, 5.54, 4.76, .46, 2.34, Math.PI, 6);
    const desk = writing(g, 2.65, 2.41, Math.PI, 2.54, .81);
    books(desk, -.998, .75, -.196, 5, .069, .18);
    chair(g, 2.18, 3.10, Math.PI, moss);
    chair(g, 3.14, 3.10, Math.PI, moss);
    const c = cabinet(g, 5.45, .59, 1.72, .54, .76, 0, 3, wood, stone);
    vase(c, .57, .776, .018, clay, .36);
    artwork(g, 6.787, 2.49, 1.55, .99, 1.12, -H, true);
    plant(g, .65, .70, .79, 'pine');
    linear(g, 2.64, 2.41, 1.77, 2.82, 2.34);
  });
  room(p, '多功能房', (g) => {
    rug(g, 1.94, 7.93, 2.70, 2.54, chalk);
    sofa(g, 1.79, 6.51, 2.42, .85, 0, sage, slate);
    const craft = table(g, 1.33, 7.91, 1.13, .67, .60, 0, pale);
    for (const x of [-.47, .47]) for (const z of [-.237, .237]) disc(craft, charcoal, x, .045, z, .039, .045).rotation.x = H;
    box(craft, rust, -.10, .614, .02, .33, .025, .23);
    box(craft, chalk, -.08, .635, .035, .248, .016, .18).rotation.y = .09;
    for (let i = 0; i < 3; i++) rod(craft, [moss, charcoal, pale][i], [.155 + i * .024, .629, -.069], [.15 + i * .023, .629, .073], .006);
    cabinet(g, 3.67, 6.60, 1.05, .42, .91, -H, 2, pale);
    standingLamp(g, .45, 7.19, 1.56, H);
    artwork(g, 1.77, 6.009, 1.59, 1.45, .64, 0);
    pin(g, 1.98, 8.20, 2.82);
  });
  room(p, '三层家庭起居', (g) => {
    rug(g, 6.27, 7.79, 3.66, 2.56, linen);
    sofa(g, 6.39, 6.87, 2.75, .88, 0, linen, moss, true);
    const coffee = table(g, 6.08, 8.12, 1.26, .59, .37, 0, edge);
    teaSet(coffee, .37);
    disc(coffee, stone, .42, .397, .03, .14, .054);
    const c = cabinet(g, 12.57, 9.17, 1.46, .39, .80, -H, 3);
    vase(c, .39, .803, .01, clay, .27);
    plant(g, 8.67, 9.26, .76, 'pine');
    pendant(g, 6.31, 7.71, 2.82, 2.33);
    pendant(g, 6.94, 7.48, 2.82, 2.37);
    pin(g, 10.42, 8.57, 2.82);
    pin(g, 12.19, 4.57, 2.82);
  });
  room(p, '影音 / 兴趣室', (g) => {
    rug(g, 14.45, 4.50, 2.57, 3.28, charcoal);
    sofa(g, 13.55, 3.63, .85, .96, 0, slate, linen, true);
    sofa(g, 15.18, 3.66, .85, .96, 0, moss, linen, true);
    const t = roundTable(g, 14.36, 3.98, .242, .45, edge);
    cup(t, 0, .45, 0);
    const media = cabinet(g, 14.43, 6.26, 2.32, .44, .54, Math.PI, 4, edge);
    box(media, charcoal, 0, .581, 0, .52, .077, .19);
    box(media, theater, .178, .585, .101, .079, .011, .012);
    const screen = place(g, 14.44, 6.43, Math.PI);
    box(screen, charcoal, 0, 1.403, 0, 2.32, 1.28, .042);
    box(screen, chalk, 0, 1.403, .029, 2.22, 1.184, .029);
    rod(screen, metal, [-1.17, 2.08, .022], [1.17, 2.08, .022], .048);
    lattice(g, 13.03, 2.50, 3.80, 2.29, H, edge);
    box(g, theater, 13.08, .14, 2.50, .024, .029, 3.67);
    box(g, theater, 14.44, .105, 6.01, 2.21, .029, .024);
  });
  room(p, '露台卫浴', (g) => {
    vanity(g, 13.96, 6.942, 1.53, 0, pale);
    toilet(g, 15.61, 8.91, -H);
    towelRail(g, 14.61, 9.89, 1.30, Math.PI);
    cabinet(g, 13.40, 9.35, .83, .43, .79, H, 2, pale, stone);
    pin(g, 14.44, 8.30, 2.82);
  });
  room(p, '屋顶花园露台', (g) => {
    planter(g, 2.20, 11.21, 2.35, .68, ['pine', 'grass', 'grass']);
    planter(g, 14.32, 10.89, 1.56, .49, ['grass', 'pine']);
    plant(g, 5.12, 11.82, .99, 'pine');
    paddedBench(g, 13.38, 12.57, 2.25, .47, Math.PI, sage);
    const tea = roundTable(g, 12.35, 11.60, .378, .48, stone);
    teaSet(tea, .48);
    planterLight(g, 3.60, 12.66);
    planterLight(g, 13.65, 13.42);
  });
}

/** Populate a storey's furniture group in the building's local coordinates. */
export function furnish(group, level) {
  const build = [firstFloor, secondFloor, thirdFloor][level - 1];
  if (!build) throw new RangeError('Villa furniture requires storey 1, 2, or 3');
  build(group);
  return group;
}
