import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {crc32, deflateSync} from 'node:zlib';

const TAU = 2 * Math.PI;
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
const lerp = (a, b, t) => a + (b - a) * t;
const mod = (x, size) => (x % size + size) % size;
const smooth = (x) => x * x * (3 - 2 * x);
const range = (min, max, x) => smooth(clamp((x - min) / (max - min), 0, 1));

function hash(i, seed) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

// Periodic noise keeps each color and height field continuous on both UV axes.
function noise(columns, rows, seed) {
  const values = Float32Array.from({length: columns * rows}, (_, i) => hash(i, seed));
  return (u, v) => {
    const sx = u * columns, sy = v * rows;
    const x = Math.floor(sx), y = Math.floor(sy);
    const u0 = mod(x, columns), u1 = (u0 + 1) % columns;
    const r0 = mod(y, rows) * columns, r1 = ((mod(y, rows) + 1) % rows) * columns;
    const a = smooth(sx - x), b = smooth(sy - y);
    return lerp(lerp(values[r0 + u0], values[r0 + u1], a), lerp(values[r1 + u0], values[r1 + u1], a), b) - 0.5;
  };
}

function limePlaster() {
  const warp = noise(5, 5, 101), cloud = noise(9, 10, 21), trowel = noise(26, 18, 47);
  const sand = noise(93, 89, 160), pores = noise(169, 151, 64), patina = noise(12, 18, 302);
  return (u, v) => {
    const du = 0.075 * warp(u, v), dv = 0.055 * warp(u + 0.41, v + 0.32);
    const mottled = cloud(u + du, v + dv);
    const strokes = trowel(u + du, v + dv);
    const grains = sand(u, v), pit = range(0.225, 0.44, pores(u, v));
    const weather = range(0.17, 0.53, 0.65 * patina(u + du, v + dv) + 0.68 * mottled + 0.14 * strokes);
    const shade = 18 * mottled + 13 * strokes + 10 * grains - 4 * pit;
    return [218 + shade - 19 * weather, 203 + shade - 13 * weather, 170 + shade - 12 * weather,
      0.45 * strokes + 0.18 * mottled + 0.28 * grains - 0.16 * pit];
  };
}

function dressedLimestone() {
  const drift = noise(7, 8, 412), beds = noise(7, 27, 957), fossils = noise(31, 32, 82);
  const grit = noise(106, 96, 158), holes = noise(163, 159, 397), iron = noise(15, 19, 60);
  return (u, v) => {
    const earth = drift(u, v), layer = beds(u, v + 0.065 * drift(u + 0.33, v + 0.49));
    const speck = fossils(u, v), sand = grit(u, v);
    const pit = range(0.15, 0.445, holes(u, v) + 0.13 * speck);
    const mineral = range(0.17, 0.47, 0.45 * earth + 0.35 * layer + 0.65 * iron(u, v));
    const tone = 20 * earth + 13 * layer + 13 * speck + 13 * sand - 8 * pit;
    return [200 + tone - 5 * mineral, 185 + tone - 13 * mineral, 151 + tone - 20 * mineral,
      0.38 * speck + 0.26 * layer + 0.28 * sand - 0.25 * pit];
  };
}

function oldOak() {
  const sway = noise(9, 4, 128), fibers = noise(117, 7, 52), bands = noise(33, 5, 417);
  const age = noise(12, 6, 89), flakes = noise(95, 35, 876), pores = noise(171, 73, 364);
  const knots = [[0.18, 0.62, 0.040, 0.086], [0.62, 0.24, 0.031, 0.101], [0.86, 0.84, 0.027, 0.076]];
  return (u, v) => {
    let sweep = 0.013 * sway(u, v), knotTone = 0, knotHeight = 0;
    for (const [x, y, width, length] of knots) {
      const ku = mod(u - x + 0.5, 1) - 0.5, kv = mod(v - y + 0.5, 1) - 0.5;
      const radius = Math.hypot(ku / width, kv / length);
      if (radius < 2.3) {
        const fade = 1 - range(0.30, 2.3, radius);
        sweep += 0.019 * fade * Math.tanh(ku / width * 2);
        const rings = Math.sin(radius * 14.5 + 0.4 * Math.sin(TAU * (u + v)));
        knotTone += fade * (5.7 * rings - 25 * (1 - range(0.12, 0.65, radius)));
        knotHeight += fade * (0.10 * rings - 0.38 * (1 - range(0.13, 0.62, radius)));
      }
    }
    const latewood = bands(u + sweep, v), grain = fibers(u + sweep, v);
    const raised = flakes(u + sweep, v), faded = age(u, v);
    const split = range(0.23, 0.49, -(grain + 0.42 * latewood) + 0.1 * pores(u, v));
    const shade = 20 * latewood + 17 * grain + 11 * faded + 10 * raised - 12 * split + knotTone;
    return [86 + shade, 58 + shade * 0.84, 43 + shade * 0.68,
      0.32 * latewood + 0.21 * grain + 0.14 * raised - 0.11 * split + knotHeight];
  };
}

function kilnFiredClay() {
  const firing = noise(5, 6, 303), deposits = noise(20, 24, 1068), oxide = noise(12, 13, 309);
  const clay = noise(61, 75, 81), grit = noise(174, 163, 18), ribs = noise(38, 9, 741);
  return (u, v) => {
    const mottled = firing(u, v), pigment = deposits(u + 0.05 * mottled, v);
    const agglomerate = clay(u, v), sand = grit(u, v), ridges = ribs(u, v);
    const black = range(0.12, 0.59, 0.62 * pigment + 0.58 * oxide(u, v) - 0.45 * mottled);
    const shade = 23 * mottled + 19 * pigment + 12 * agglomerate + 9 * sand + 5 * ridges - 17 * black;
    return [153 + shade, 67 + shade * 0.71 - 4 * black, 47 + shade * 0.51 - 4 * black,
      0.21 * pigment + 0.26 * ridges + 0.26 * agglomerate + 0.16 * sand];
  };
}

function annealedGlass() {
  const warp = noise(4, 4, 106), ripple = noise(17, 8, 824), tint = noise(6, 5, 14);
  return (u, v) => {
    const cold = tint(u, v), pattern = 10 * warp(u, v) + 5 * ripple(u + 0.12 * cold, v);
    return [74 + pattern - 10 * cold, 85 + pattern + 5 * cold, 83 + 1.15 * pattern + 15 * cold];
  };
}

function agedIron() {
  const tarnish = noise(8, 9, 404), casting = noise(43, 39, 512), corrosion = noise(23, 21, 21);
  return (u, v) => {
    const tint = tarnish(u, v), texture = casting(u, v);
    const oxide = range(0.13, 0.46, corrosion(u, v) + 0.30 * tint);
    return [70 + 14 * tint + 16 * texture + 13 * oxide, 56 + 13 * tint + 13 * texture + 5 * oxide,
      43 + 10 * tint + 9 * texture + 2 * oxide];
  };
}

function chunk(tag, data) {
  const framed = Buffer.alloc(data.length + 12);
  framed.writeUInt32BE(data.length, 0);
  framed.write(tag, 4, 'ascii');
  data.copy(framed, 8);
  framed.writeUInt32BE(crc32(framed.subarray(4, framed.length - 4)), framed.length - 4);
  return framed;
}

function paeth(a, b, c) {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

function encodePng(size, pixels) {
  const row = size * 3, data = Buffer.alloc(size * (row + 1));
  const filters = [0, 1, 2, 4].map((id) => ({id, bytes: Buffer.alloc(row), cost: 0}));
  for (let y = 0; y < size; y++) {
    const offset = y * row;
    for (const f of filters) f.cost = 0;
    for (let x = 0; x < row; x++) {
      const a = x < 3 ? 0 : pixels[offset + x - 3], b = !y ? 0 : pixels[offset + x - row];
      const c = !y || x < 3 ? 0 : pixels[offset + x - row - 3];
      const v = pixels[offset + x];
      const values = [v, v - a, v - b, v - paeth(a, b, c)];
      for (let i = 0; i < filters.length; i++) {
        const residual = values[i] & 255;
        filters[i].bytes[x] = residual;
        filters[i].cost += Math.min(residual, 256 - residual);
      }
    }
    const best = filters.reduce((a, b) => (a.cost <= b.cost ? a : b));
    data[y * (row + 1)] = best.id;
    best.bytes.copy(data, y * (row + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(data, {level: 9})), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeSurface(output, key, size, sample, heightScale) {
  const color = Buffer.alloc(size * size * 3);
  const height = heightScale ? new Float32Array(size * size) : undefined;
  const paths = {[`${key}Color`]: join(output, `${key}-color.png`)};
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, [r, g, b, h] = sample((x + 0.5) / size, (y + 0.5) / size);
      color[3 * i] = clamp(Math.round(r), 0, 255);
      color[3 * i + 1] = clamp(Math.round(g), 0, 255);
      color[3 * i + 2] = clamp(Math.round(b), 0, 255);
      if (height) height[i] = h;
    }
  }
  await writeFile(paths[`${key}Color`], encodePng(size, color));
  if (height) {
    const normal = Buffer.alloc(size * size * 3), scale = size * heightScale * 0.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 3;
        const dx = (height[y * size + mod(x - 1, size)] - height[y * size + mod(x + 1, size)]) * scale;
        const dy = (height[mod(y - 1, size) * size + x] - height[mod(y + 1, size) * size + x]) * scale;
        const length = Math.hypot(dx, dy, 1);
        normal[offset] = Math.round(127.5 + 127.5 * dx / length);
        normal[offset + 1] = Math.round(127.5 + 127.5 * dy / length);
        normal[offset + 2] = Math.round(127.5 + 127.5 / length);
      }
    }
    paths[`${key}Normal`] = join(output, `${key}-normal.png`);
    await writeFile(paths[`${key}Normal`], encodePng(size, normal));
  }
  return paths;
}

export async function makeTextures(outputDir) {
  const output = resolve(outputDir);
  await mkdir(output, {recursive: true});
  const surfaces = [
    ['plaster', 512, limePlaster(), 0.015],
    ['stone', 512, dressedLimestone(), 0.017],
    ['wood', 512, oldOak(), 0.023],
    ['roof', 512, kilnFiredClay(), 0.016],
    ['glass', 128, annealedGlass(), 0],
    ['metal', 128, agedIron(), 0],
  ];
  return Object.assign({}, ...await Promise.all(surfaces.map((surface) => writeSurface(output, ...surface))));
}
