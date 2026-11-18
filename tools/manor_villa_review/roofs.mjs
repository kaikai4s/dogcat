const EPS = 1e-7;

// Clip in roof-face coordinates so tiles stop at hips and valleys with a true cut edge.
function clip(poly, distance) {
  const out = [];
  if (!poly.length) return out;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i], da = distance(a), db = distance(b);
    if ((da >= -EPS) !== (db >= -EPS)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (db >= -EPS) out.push(b);
  }
  return out.filter((p, i) => {
    const q = out[(i + out.length - 1) % out.length];
    return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > EPS;
  });
}

function random(i) {
  i ^= i >>> 16;
  i = Math.imul(i, 0x7feb352d);
  i ^= i >>> 15;
  i = Math.imul(i, 0x846ca68b);
  return ((i ^ i >>> 16) >>> 0) / 4294967296;
}

export function buildRoofs(THREE, materials = {}) {
  const {Vector3, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, Group} = THREE;
  const vec = (x, y, z) => new Vector3(x, y, z);
  const up = vec(0, 1, 0);
  const roof = new Group();
  roof.name = 'Roofs_terracotta_and_oak';

  const material = (source, name, color) => {
    const result = source?.isMaterial ? source.clone() : new MeshStandardMaterial({color, roughness: 0.87});
    result.name = name;
    result.vertexColors = true;
    return result;
  };
  const tileMaterial = material(materials.tile, 'Terracotta | hand-fired tiles and ridge caps', 0xa14b31);
  const tileDetail = Array.isArray(materials.tileDetail) ? materials.tileDetail[0] : materials.tileDetail;
  const valleyMaterial = material(tileDetail ?? materials.tile, 'Terracotta | valley flashing', 0x723820);
  const woodMaterial = material(materials.wood, 'Oak | roof structure and verge', 0x39281f);
  const edgeMaterial = material(materials.woodEdge ?? materials.wood, 'Oak | bevel and rafter ends', 0x654430);

  function batch(name, mat) {
    const positions = [], normals = [], colors = [], uv = [], indices = [];
    function face(points, target, uvs, color = [1, 1, 1], smooth = null) {
      if (points.length < 3) return;
      const axis = vec(0, 0, 0);
      const triangles = [];
      for (let j = 1; j + 1 < points.length; j++) {
        const a = points[j].clone().sub(points[0]), b = points[j + 1].clone().sub(points[0]);
        const cross = a.cross(b);
        if (cross.lengthSq() > 1e-12) {
          axis.add(cross);
          triangles.push(j);
        }
      }
      if (axis.lengthSq() < 1e-12) return;
      const forward = axis.dot(target) >= 0;
      axis.normalize().multiplyScalar(forward ? 1 : -1);
      const start = positions.length / 3;
      for (let i = 0; i < points.length; i++) {
        const p = points[i], n = smooth?.[i] ?? axis;
        positions.push(p.x, p.y, p.z);
        normals.push(n.x, n.y, n.z);
        colors.push(...color);
        uv.push(uvs[i][0], uvs[i][1]);
      }
      for (const j of triangles) {
        if (forward) indices.push(start, start + j, start + j + 1);
        else indices.push(start, start + j + 1, start + j);
      }
    }
    function finish() {
      if (!indices.length) return;
      const g = new BufferGeometry();
      for (const [key, arr, size] of [['position', positions, 3], ['normal', normals, 3], ['color', colors, 3], ['uv', uv, 2]]) {
        g.setAttribute(key, new Float32BufferAttribute(arr, size));
      }
      g.setIndex(indices);
      g.computeBoundingSphere();
      const mesh = new Mesh(g, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      roof.add(mesh);
    }
    return {face, finish};
  }

  const clay = batch('Clay tiles | staggered courses', tileMaterial);
  const valleys = batch('Valley channels and hip flashing', valleyMaterial);
  const oak = batch('Fascia boards and roof soffits', woodMaterial);
  const bevels = batch('Rafter ends and verge moulding', edgeMaterial);
  const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];

  function prism(a, b, height, width, target = oak, shade = 1) {
    const p = vec(...a), q = vec(...b), line = q.clone().sub(p);
    const side = line.clone().cross(up).normalize().multiplyScalar(width * 0.5);
    const depth = up.clone().multiplyScalar(height);
    const corners = [p.clone().add(side), q.clone().add(side), q.clone().sub(side), p.clone().sub(side)];
    const lower = corners.map(c => c.clone().sub(depth));
    const uv = [[0, 0], [line.length() / 1.9, 0], [line.length() / 1.9, 1], [0, 1]];
    const tint = [shade, shade, shade];
    target.face(corners, up, uv, tint);
    target.face(lower, up.clone().negate(), uv, tint);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const n = corners[j].clone().sub(corners[i]).cross(up);
      target.face([corners[i], corners[j], lower[j], lower[i]], n, i % 2 ? quad : uv, tint);
    }
  }

  function verge(a, b, depth = 0.23) {
    prism(a, b, depth, 0.15);
    const line = q => [q[0], q[1] - depth + 0.04, q[2]];
    prism(line(a), line(b), 0.055, 0.173, bevels, 0.91);
  }

  function eave(a, b, direction, {height = 0.19, step = 0.75} = {}) {
    verge(a, b, height);
    const length = vec(...a).distanceTo(vec(...b));
    const n = Math.max(1, Math.floor(length / step));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = a.map((value, j) => value + (b[j] - value) * t);
      p[1] -= height - 0.045;
      const q = [p[0] + direction[0] * 0.32, p[1] + 0.04, p[2] + direction[1] * 0.32];
      prism(p, q, 0.13, 0.125, bevels, 0.9 + random(i + 431) * 0.18);
    }
  }

  function patch(eaveA, eaveB, ridgeA, ridgeB, {sieves = [[]], width = 0.57, course = 0.405, seed = 0} = {}) {
    const o = vec(...eaveA), e = vec(...eaveB).sub(o), u = e.clone().normalize();
    const rise = vec(...ridgeA).sub(o);
    const v = rise.clone().addScaledVector(u, -rise.dot(u)).normalize();
    const n = u.clone().cross(v);
    if (n.y < 0) n.negate();
    const transform = ([along, upslope], h = 0) => o.clone().addScaledVector(u, along).addScaledVector(v, upslope).addScaledVector(n, h);
    const project = p => {
      const d = vec(...p).sub(o);
      return [d.dot(u), d.dot(v)];
    };
    const domain = [[0, 0], [e.length(), 0], project(ridgeB), project(ridgeA)];
    const regions = sieves.map(filters => filters.reduce((poly, fn) => clip(poly, point => fn(transform(point))), domain)).filter(poly => poly.length >= 3);
    const height = Math.max(...domain.map(p => p[1]));
    const minU = Math.min(...domain.map(p => p[0]));
    const maxU = Math.max(...domain.map(p => p[0]));

    for (const poly of regions) {
      const sheathingUV = poly.map(([along, upslope]) => [along / 2.3, upslope / 1.7]);
      oak.face(poly.map(p => transform(p, -0.014)), n, sheathingUV, [0.73, 0.66, 0.60]);
      oak.face(poly.map(p => transform(p, -0.145)), n.clone().negate(), sheathingUV, [0.83, 0.83, 0.83]);
    }

    const fullProfile = [0, 0.12, 0.84, 1];
    const profileHeights = [0.032, 0.059, 0.056, 0.030];
    for (let row = 0; row * course < height; row++) {
      const bottom = Math.max(0, row * course - 0.024), top = Math.min(height, (row + 1) * course + 0.035);
      const offset = row % 2 ? width * 0.5 : 0;
      for (let col = Math.floor((minU + offset) / width); col * width - offset < maxU; col++) {
        const left = col * width - offset + 0.003, right = left + width - 0.010;
        const b = [left, bottom], t = [right, top];
        const id = seed * 37337 + row * 59021 + col * 104729;
        const age = 0.76 + random(id) * 0.37;
        const iron = random(id + 191) * 0.19 - 0.065;
        const tint = [age * (1 + iron * 0.27), age * (1 - iron * 0.53), age * (1 - iron * 1.15)];
        const offsetH = 0.012 * (random(id + 83) - 0.5);
        const mapUV = ([x, y]) => [random(id + 13) < 0.5 ? (x - left) / (right - left) : (right - x) / (right - left), 1 - (y - bottom) / (top - bottom)];
        for (const region of regions) {
          let cell = clip(region, ([x]) => x - b[0]);
          cell = clip(cell, ([x]) => t[0] - x);
          cell = clip(cell, ([, y]) => y - bottom);
          cell = clip(cell, ([, y]) => top - y);
          if (cell.length < 3) continue;
          for (let band = 0; band + 1 < fullProfile.length; band++) {
            const l = left + fullProfile[band] * (right - left), r = left + fullProfile[band + 1] * (right - left);
            const blade = clip(clip(cell, ([x]) => x - l), ([x]) => r - x);
            if (blade.length < 3) continue;
            const heightAt = ([x, y]) => profileHeights[band] + (profileHeights[band + 1] - profileHeights[band]) * ((x - l) / (r - l))
              + Math.max(0, 1 - (y - bottom) / course) * 0.052 + offsetH;
            const points = blade.map(p => transform(p, heightAt(p)));
            clay.face(points, n, blade.map(mapUV), tint);
            for (let i = 0; i < blade.length; i++) {
              const j = (i + 1) % blade.length, p = blade[i], q = blade[j];
              if ((Math.abs(p[0] - q[0]) < EPS) &&
                  ((band > 0 && Math.abs(p[0] - l) < EPS) || (band + 2 < fullProfile.length && Math.abs(p[0] - r) < EPS))) continue;
              if (Math.abs(p[1] - top) < EPS && Math.abs(q[1] - top) < EPS) continue;
              const side = u.clone().multiplyScalar(q[1] - p[1]).addScaledVector(v, p[0] - q[0]);
              clay.face([points[i], points[j], transform(q, 0.008), transform(p, 0.008)], side, [mapUV(p), mapUV(q), mapUV(q), mapUV(p)], tint.map(c => c * 0.64));
            }
          }
        }
      }
    }
  }

  function cap(a, b, width = 0.185, height = 0.125, row = 0.49, seed = 0) {
    const from = vec(...a), axis = vec(...b).sub(from), length = axis.length();
    const side = axis.clone().cross(up).normalize();
    const count = Math.ceil(length / row), steps = 7;
    for (let i = 0; i < count; i++) {
      const back = i / count, front = (i + 1) / count;
      const base0 = from.clone().addScaledVector(axis, Math.max(0, back - 0.016 / length)).addScaledVector(up, 0.032);
      const base1 = from.clone().addScaledVector(axis, front).addScaledVector(up, 0.028);
      const tint = 0.80 + random(seed * 113 + i * 79) * 0.25;
      const normals = [], start = [], end = [];
      for (let j = 0; j <= steps; j++) {
        const angle = j / steps * Math.PI;
        const x = Math.cos(angle), y = Math.sin(angle);
        normals.push(side.clone().multiplyScalar(x / width).addScaledVector(up, y / height).normalize());
        start.push(base0.clone().addScaledVector(side, x * width).addScaledVector(up, y * height));
        end.push(base1.clone().addScaledVector(side, x * width * 0.91).addScaledVector(up, y * height * 0.89));
      }
      for (let j = 0; j < steps; j++) {
        clay.face([start[j], end[j], end[j + 1], start[j + 1]], normals[j],
          [[0, j / steps], [1, j / steps], [1, (j + 1) / steps], [0, (j + 1) / steps]], [tint, tint, tint],
          [normals[j], normals[j], normals[j + 1], normals[j + 1]]);
      }
      clay.face(start, axis.clone().negate(), start.map((_, j) => [j / steps, 0.16]), [tint * 0.75, tint * 0.66, tint * 0.61]);
      if (i + 1 === count) clay.face(end, axis, end.map((_, j) => [j / steps, 0.86]), [tint * 0.78, tint * 0.68, tint * 0.64]);
    }
  }

  function valley(a, b) {
    const p = vec(...a).addScaledVector(up, 0.013), q = vec(...b).addScaledVector(up, 0.013);
    const side = q.clone().sub(p).cross(up).normalize().multiplyScalar(0.117);
    for (const sign of [-1, 1]) {
      const edge = side.clone().multiplyScalar(sign).addScaledVector(up, 0.022);
      valleys.face([p, q, q.clone().add(edge), p.clone().add(edge)], up, quad, [0.65, 0.56, 0.50]);
    }
  }

  const left = -6.65, right = 7.7, yE = 6.35, yR = 9.9, zF = 3.95, zB = -4.05;
  const gc = 5.17, gx0 = 2.55, gx1 = 7.8, gz0 = -4.89, gz1 = 5.5, gy = 9.95;
  const mainY = z => yR - (yR - yE) * z / (z >= 0 ? zF : zB);
  const gableX = y => gc - (gy - y) * (gc - gx0) / (gy - yE);
  for (const [z, seed] of [[zF, 1], [zB, 2]]) {
    patch([left, yE, z], [right, yE, z], [left, yR, 0], [right, yR, 0], {
      seed, sieves: [[p => gableX(p.y) - p.x]],
    });
    eave([left, yE, z], [gx0, yE, z], [0, -Math.sign(z)]);
    verge([left, yE, z], [left, yR, 0], 0.30);
    valley([gx0, yE, z], [gableX(yR), yR, 0]);
  }
  patch([gx0, yE, gz0], [gx0, yE, gz1], [gc, gy, gz0], [gc, gy, gz1], {
    seed: 3,
    sieves: [[p => p.z, p => p.y - (yR - (yR - yE) * p.z / zF)], [p => -p.z, p => p.y - (yR - (yR - yE) * p.z / zB)]],
  });
  patch([gx1, yE, gz0], [gx1, yE, gz1], [gc, gy, gz0], [gc, gy, gz1], {seed: 4});
  eave([gx1, yE, gz0], [gx1, yE, gz1], [-1, 0]);
  for (const [a, b] of [[gz0, zB], [zF, gz1]]) eave([gx0, yE, a], [gx0, yE, b], [1, 0], {step: 0.58});
  for (const z of [gz0, gz1]) {
    verge([gx0, yE, z], [gc, gy, z], 0.29);
    verge([gx1, yE, z], [gc, gy, z], 0.29);
  }
  cap([left, yR, 0], [gc - 0.055, yR, 0], 0.192, 0.135, 0.51, 10);
  cap([gc, gy, gz0], [gc, gy, gz1], 0.192, 0.135, 0.51, 11);
  // Back the small change in height where the two ridge caps intersect.
  prism([gc-.34,yR+.05,0],[gc+.071,gy+.035,0],.20,.30,clay,.83);

  const lx0 = -10.65, lx1 = -6.0, ly0 = 4.85, ly1 = 7.0, lz = 3.8;
  const wingCenter = -8.75, wingSpan = 1.75, wingPeak = 6.78, wingVerge = 4.35;
  const wingY = z => ly1 - (ly1 - ly0) * z / lz;
  for (const [z, seed] of [[lz, 5], [-lz, 6]]) {
    const sieves = z > 0 ? [-1, 1].map(sign => [p => sign * (p.x - wingCenter), p => p.y - (wingPeak - (wingPeak - ly0) * sign * (p.x - wingCenter) / wingSpan)]) : [[]];
    patch([lx0, ly0, z], [lx1, ly0, z], [lx0, ly1, 0], [lx1, ly1, 0], {seed, width: 0.50, course: 0.37, sieves});
    if (z > 0) {
      eave([lx0, ly0, z], [wingCenter - wingSpan, ly0, z], [0, -1]);
      eave([wingCenter + wingSpan, ly0, z], [lx1, ly0, z], [0, -1]);
    } else eave([lx0, ly0, z], [lx1, ly0, z], [0, 1]);
    verge([lx0, ly0, z], [lx0, ly1, 0], 0.22);
  }
  const wingMeet = lz * (ly1 - wingPeak) / (ly1 - ly0);
  for (const sign of [-1, 1]) {
    const x = wingCenter + wingSpan * sign;
    patch([x, ly0, wingMeet], [x, ly0, wingVerge], [wingCenter, wingPeak, wingMeet], [wingCenter, wingPeak, wingVerge], {
      seed: 7 + (sign === 1), width: 0.50, course: 0.36, sieves: [[p => p.y - wingY(p.z)]],
    });
    verge([x, ly0, wingVerge], [wingCenter, wingPeak, wingVerge], 0.22);
    eave([x, ly0, lz], [x, ly0, wingVerge], [-sign, 0]);
    valley([x, ly0, lz], [wingCenter, wingPeak, wingMeet]);
  }
  cap([lx0, ly1, 0], [lx1, ly1, 0], 0.145, 0.105, 0.46, 12);
  cap([wingCenter, wingPeak, wingMeet], [wingCenter, wingPeak, wingVerge], 0.145, 0.105, 0.46, 13);

  const tx = -1.65, tz = -0.15, dx = 1.60, dz = 1.48, ty = 11.25, tr = 12.75;
  const tl = [tx - 0.42, tr, tz], th = [tx + 0.42, tr, tz];
  for (const sign of [-1, 1]) {
    const low = [tx - dx, ty, tz + dz * sign], high = [tx + dx, ty, tz + dz * sign];
    patch(low, high, tl, th, {width: 0.435, course: 0.315, seed: 15 + sign});
    eave(low, high, [0, -sign], {height: 0.19, step: 0.53});
    cap(low, tl, 0.122, 0.09, 0.39, 22 + sign);
    cap(high, th, 0.122, 0.09, 0.39, 26 + sign);
    const a = [tx + dx * sign, ty, tz - dz], b = [tx + dx * sign, ty, tz + dz], summit = sign < 0 ? tl : th;
    patch(a, b, summit, summit, {width: 0.435, course: 0.315, seed: 19 + sign});
    eave(a, b, [-sign, 0], {height: 0.19, step: 0.53});
  }
  cap(tl, th, 0.125, 0.102, 0.38, 28);

  const px0 = -5.75, px1 = 2.9, py0 = 3.12, py1 = 3.9, pz0 = 5.25, pz1 = 3.6;
  patch([px0, py0, pz0], [px1, py0, pz0], [px0, py1, pz1], [px1, py1, pz1], {width: 0.47, course: 0.325, seed: 22});
  eave([px0, py0, pz0], [px1, py0, pz0], [0, -1], {height: 0.17, step: 0.64});
  for (const x of [px0, px1]) verge([x, py0, pz0], [x, py1, pz1], 0.16);

  const dc = -2.25, dw = 0.82, dy = 8.02, dr = 8.75, df = 2.98;
  const dormerMeet = zF * (yR - dr) / (yR - yE), dormerFoot = zF * (yR - dy) / (yR - yE);
  for (const sign of [-1, 1]) {
    const x = dc + dw * sign;
    patch([x, dy, dormerMeet], [x, dy, df], [dc, dr, dormerMeet], [dc, dr, df], {
      seed: 25 + sign, width: 0.375, course: 0.275, sieves: [[p => p.y - mainY(p.z)]],
    });
    eave([x, dy, dormerFoot], [x, dy, df], [-sign, 0], {height: 0.145, step: 0.55});
    verge([x, dy, df], [dc, dr, df], 0.165);
    valley([x, dy, dormerFoot], [dc, dr, dormerMeet]);
  }
  cap([dc, dr, dormerMeet], [dc, dr, df], 0.107, 0.082, 0.33, 31);

  clay.finish();
  oak.finish();
  bevels.finish();
  valleys.finish();
  return roof;
}
