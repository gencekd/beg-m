// ---------------------------------------------------------------------------
// Örnek 1:70 mimari sahne + .glb/.gltf model yükleyici.
//
// Tüm içerik modelRoot grubunun altında MAKET biriminde (1:70) tanımlanır.
// Okunabilirlik için ölçüler gerçek metre olarak yazılır ve R() ile maket
// birimine çevrilir: R(3.0) = 3.0 / 70 m (maket üzerinde 4.3 cm'lik duvar).
// modelRoot.scale = viewScale (70 veya 1) ile dünya boyutu belirlenir.
//
// Performans: statik mimari (duvarlar, kapılar, kutular, oklar, insan figürleri)
// vertex color ile TEK bir BufferGeometry'de birleştirilir -> 1 draw call.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SCALE } from './config.js';

/** Gerçek metre -> maket birimi. */
export const R = (realMeters) => realMeters * SCALE.MODEL_RATIO;

const COLORS = {
  ground: 0x8a9a7b,
  slab: 0xd9d4c7,
  wall: 0xeeeae2,
  wallInner: 0xe3ddd0,
  doorFrame: 0x8b5a2b,
  lintel: 0xcfc6b5,
  boxA: 0x4f86c6,
  boxB: 0xe39b3b,
  boxC: 0x7bb662,
  boxD: 0xc95f5f,
  boxE: 0x9b6fc2,
  arrow: 0xf2c230,
  human: 0x2f3e4e,
  skin: 0xe0b48c,
  poleA: 0x222222,
  poleB: 0xf5f5f5,
  north: 0xd64545,
  east: 0x3b7dd8,
  south: 0x3fae5a,
  west: 0xe0a030,
};

/** Birleştirilecek geometri toplayıcı (vertex color). */
class GeometryBatch {
  constructor() { this.parts = []; }

  add(geometry, color, matrix) {
    const g = geometry;
    if (matrix) g.applyMatrix4(matrix);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(g);
  }

  /** Kutu: gerçek metre cinsinden boyut ve taban-merkez konumu. */
  box(w, h, d, x, y0, z, color, rotY = 0) {
    const g = new THREE.BoxGeometry(R(w), R(h), R(d));
    const m = new THREE.Matrix4().makeRotationY(rotY).setPosition(R(x), R(y0 + h / 2), R(z));
    this.add(g, color, m);
  }

  build(material) {
    const merged = mergeGeometries(this.parts, false);
    this.parts.forEach((p) => p.dispose());
    this.parts = [];
    merged.computeBoundingSphere();
    return new THREE.Mesh(merged, material);
  }
}

/** Kanvas dokulu etiket (sprite). heightReal: gerçek metre cinsinden yazı yüksekliği. */
function makeLabel(text, { x, y, z, heightReal = 0.35, color = '#1d2733', bg = 'rgba(255,255,255,0.85)' }) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontPx = 64;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width = THREE.MathUtils.ceilPowerOfTwo(tw + 48);
  canvas.height = 128;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.fillStyle = bg;
  const pad = (canvas.width - tw - 48) / 2;
  ctx.beginPath();
  ctx.roundRect(pad, 16, tw + 48, 96, 24);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const hWorld = R(heightReal);
  sprite.scale.set(hWorld * (canvas.width / canvas.height), hWorld, 1);
  sprite.position.set(R(x), R(y), R(z));
  sprite.name = `label:${text}`;
  return sprite;
}

/** Zemin üzerinde düz ok (gerçek metre). */
function arrowShape(len, width) {
  const s = new THREE.Shape();
  const hw = width / 2;
  const head = Math.min(len * 0.45, width * 1.2);
  // Uç +Y yönünde; zemine yatırıldığında -Z (ileri) yönünü gösterir.
  s.moveTo(-hw * 0.45, 0);
  s.lineTo(hw * 0.45, 0);
  s.lineTo(hw * 0.45, len - head);
  s.lineTo(hw, len - head);
  s.lineTo(0, len);
  s.lineTo(-hw, len - head);
  s.lineTo(-hw * 0.45, len - head);
  s.closePath();
  return s;
}

function addFloorArrow(batch, x, z, yaw, color, len = 1.2, width = 0.6) {
  const shape = arrowShape(len, width);
  const g = new THREE.ShapeGeometry(shape);
  // XY düzlemindeki şekli zemine yatır: Rx(-90°) ile +Y -> -Z, normal +Z -> +Y.
  const m = new THREE.Matrix4()
    .makeTranslation(R(x), R(0.012), R(z))
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
    .multiply(new THREE.Matrix4().makeScale(R(1), R(1), R(1)));
  batch.add(g, color, m);
}

/** 1.70 m insan figürü (ölçek referansı). */
function addHuman(batch, x, z, yaw = 0) {
  const H = SCALE.REFERENCE_HUMAN_HEIGHT;
  const legH = 0.82; const torsoH = 0.6; const headR = 0.11;
  const rot = new THREE.Matrix4().makeRotationY(yaw);
  const place = (lx, ly, lz) => new THREE.Matrix4().makeTranslation(R(x), 0, R(z)).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(R(lx), R(ly), R(lz)));
  batch.add(new THREE.CylinderGeometry(R(0.07), R(0.06), R(legH), 8), COLORS.human, place(-0.1, legH / 2, 0));
  batch.add(new THREE.CylinderGeometry(R(0.07), R(0.06), R(legH), 8), COLORS.human, place(0.1, legH / 2, 0));
  batch.add(new THREE.BoxGeometry(R(0.42), R(torsoH), R(0.24)), COLORS.human, place(0, legH + torsoH / 2, 0));
  const neckTop = legH + torsoH;
  const headY = H - headR; // başın tepesi tam 1.70 m
  batch.add(new THREE.CylinderGeometry(R(0.05), R(0.05), R(headY - headR - neckTop + 0.02), 6), COLORS.skin, place(0, (neckTop + headY - headR) / 2, 0));
  batch.add(new THREE.SphereGeometry(R(headR), 12, 8), COLORS.skin, place(0, headY, 0));
}

/** 0.5 m bantlı ölçüm direği. */
function addMeasuringPole(batch, x, z, heightReal = 3) {
  const band = 0.5;
  for (let i = 0; i < heightReal / band; i++) {
    batch.box(0.08, band, 0.08, x, i * band, z, i % 2 ? COLORS.poleB : COLORS.poleA);
  }
}

/** Duvar parçası (x1..x2 veya z1..z2 boyunca). Kapı boşlukları atlanır. */
function addWallX(batch, z, x1, x2, h, t, color, doors = []) {
  // doors: [{ from, to, height }]
  const segs = [];
  let cursor = x1;
  for (const d of [...doors].sort((a, b) => a.from - b.from)) {
    if (d.from > cursor) segs.push([cursor, d.from]);
    cursor = d.to;
  }
  if (cursor < x2) segs.push([cursor, x2]);
  for (const [a, b] of segs) batch.box(b - a, h, t, (a + b) / 2, 0, z, color);
  for (const d of doors) {
    const w = d.to - d.from;
    batch.box(w, h - d.height, t, (d.from + d.to) / 2, d.height, z, COLORS.lintel);
    // kapı kasası
    batch.box(0.06, d.height, t + 0.04, d.from + 0.03, 0, z, COLORS.doorFrame);
    batch.box(0.06, d.height, t + 0.04, d.to - 0.03, 0, z, COLORS.doorFrame);
    batch.box(w, 0.06, t + 0.04, (d.from + d.to) / 2, d.height - 0.06, z, COLORS.doorFrame);
  }
}

function addWallZ(batch, x, z1, z2, h, t, color, doors = []) {
  const segs = [];
  let cursor = z1;
  for (const d of [...doors].sort((a, b) => a.from - b.from)) {
    if (d.from > cursor) segs.push([cursor, d.from]);
    cursor = d.to;
  }
  if (cursor < z2) segs.push([cursor, z2]);
  for (const [a, b] of segs) batch.box(t, h, b - a, x, 0, (a + b) / 2, color);
  for (const d of doors) {
    const w = d.to - d.from;
    batch.box(t, h - d.height, w, x, d.height, (d.from + d.to) / 2, COLORS.lintel);
    batch.box(t + 0.04, d.height, 0.06, x, 0, d.from + 0.03, COLORS.doorFrame);
    batch.box(t + 0.04, d.height, 0.06, x, 0, d.to - 0.03, COLORS.doorFrame);
    batch.box(t + 0.04, 0.06, w, x, d.height - 0.06, (d.from + d.to) / 2, COLORS.doorFrame);
  }
}

/** Başlangıç noktası (gerçek metre) ve yönü. */
export const SPAWN = Object.freeze({ xReal: 0, zReal: 10, yaw: 0 });

/**
 * Örnek mimari sahneyi oluşturur.
 * @returns {{ group: THREE.Group, dispose: Function }}
 */
export function buildSampleArchitecture() {
  const group = new THREE.Group();
  group.name = 'sample-architecture';
  const batch = new GeometryBatch();

  const WALL_H = 3.0; const T = 0.2; const DOOR_H = 2.1;

  // Bina döşemesi (16 × 12 m)
  batch.box(16, 0.04, 12, 0, 0, 0, COLORS.slab);

  // Dış duvarlar
  addWallX(batch, -6, -8.1, 8.1, WALL_H, T, COLORS.wall);
  addWallX(batch, 6, -8.1, 8.1, WALL_H, T, COLORS.wall, [{ from: -0.6, to: 0.6, height: DOOR_H }]);
  addWallZ(batch, -8, -6, 6, WALL_H, T, COLORS.wall);
  addWallZ(batch, 8, -6, 6, WALL_H, T, COLORS.wall, [{ from: 2, to: 3, height: DOOR_H }]);

  // İç duvarlar: z=0 bölme (iki kapı), arka odada x=3 bölme (kapı)
  addWallX(batch, 0, -7.9, 7.9, WALL_H, 0.12, COLORS.wallInner, [
    { from: -0.5, to: 0.5, height: DOOR_H },
    { from: -5.5, to: -4.6, height: DOOR_H },
  ]);
  addWallZ(batch, 3, -5.9, -0.06, WALL_H, 0.12, COLORS.wallInner, [{ from: -3.5, to: -2.6, height: DOOR_H }]);

  // Farklı yükseklikte kutular (etiketli)
  const boxes = [
    { w: 0.45, h: 0.45, d: 0.45, x: -5.5, z: 3.5, c: COLORS.boxA, label: '0.45 m (oturma)' },
    { w: 1.6, h: 0.75, d: 0.8, x: -5.0, z: 1.8, c: COLORS.boxB, label: '0.75 m (masa)' },
    { w: 0.6, h: 1.1, d: 0.6, x: 5.5, z: 3.8, c: COLORS.boxC, label: '1.10 m (tezgâh)' },
    { w: 0.9, h: 2.0, d: 0.5, x: 6.5, z: 1.0, c: COLORS.boxD, label: '2.00 m (dolap)' },
    { w: 1.2, h: 1.2, d: 1.2, x: -4, z: -3.5, c: COLORS.boxE, label: '1.20 m' },
    { w: 1.0, h: 1.0, d: 1.0, x: 5.0, z: -4.0, c: COLORS.boxA, label: '1 m küp' },
    { w: 2.0, h: 3.5, d: 2.0, x: -11, z: 4, c: COLORS.boxD, label: '3.50 m (bina dışı)' },
    { w: 1.0, h: 1.0, d: 1.0, x: 3.5, z: 9, c: COLORS.boxC, label: '1 m³ referans küp' },
  ];
  for (const b of boxes) batch.box(b.w, b.h, b.d, b.x, 0, b.z, b.c);

  // Ölçek referansları: 1.70 m insan figürleri ve 3 m ölçüm direği
  addHuman(batch, 2.6, 8.6, -0.3);
  addHuman(batch, 2.2, 3.0, 0.8);
  addHuman(batch, -2.0, -3.0, 2.2);
  addMeasuringPole(batch, -2.6, 8.4, 3);

  // Yürüyüş yön okları: başlangıçtan kapılardan geçerek kuzeye
  for (const z of [8.8, 7.2, 4.5, 2.5, 1.0, -1.5, -3.5]) addFloorArrow(batch, 0, z, 0, COLORS.arrow);
  // Arka odada doğuya dönüş testi
  addFloorArrow(batch, 1.2, -4.5, -Math.PI / 2, COLORS.arrow);

  // Başlangıçta pusula: 8 yön, 45°'de bir işaret (dönüş testi)
  const compassR = 1.6;
  const dirColors = [COLORS.north, COLORS.east, COLORS.south, COLORS.west];
  for (let i = 0; i < 8; i++) {
    const yaw = -i * (Math.PI / 4); // i=0 kuzey(-Z), i=2 doğu(+X)
    const dx = -Math.sin(yaw) * compassR; // yaw=0 -> (0,-1)
    const dz = -Math.cos(yaw) * compassR;
    const color = i % 2 === 0 ? dirColors[i / 2] : 0x888888;
    addFloorArrow(batch, SPAWN.xReal + dx, SPAWN.zReal + dz, yaw, color, i % 2 === 0 ? 0.7 : 0.45, i % 2 === 0 ? 0.4 : 0.25);
  }

  // Ana yön direkleri (uzakta, renkli)
  const far = 18;
  batch.box(0.4, 4, 0.4, 0, 0, -far, COLORS.north);
  batch.box(0.4, 4, 0.4, far, 0, 0, COLORS.east);
  batch.box(0.4, 4, 0.4, 0, 0, far, COLORS.south);
  batch.box(0.4, 4, 0.4, -far, 0, 0, COLORS.west);

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const archMesh = batch.build(material);
  archMesh.name = 'architecture-merged';
  group.add(archMesh);

  // Etiketler (sprite)
  const labels = new THREE.Group();
  labels.name = 'labels';
  for (const b of boxes) labels.add(makeLabel(b.label, { x: b.x, y: b.h + 0.35, z: b.z, heightReal: 0.22 }));
  labels.add(makeLabel(`1.70 m insan (maket: ${(R(1.7) * 1000).toFixed(1)} mm)`, { x: 2.6, y: 2.05, z: 8.6, heightReal: 0.2 }));
  labels.add(makeLabel('3 m direk · 0.5 m bant', { x: -2.6, y: 3.3, z: 8.4, heightReal: 0.2 }));
  labels.add(makeLabel('Giriş kapısı 1.2 × 2.1 m', { x: 0, y: 2.45, z: 6.25, heightReal: 0.2 }));
  labels.add(makeLabel('K · KUZEY (−Z)', { x: 0, y: 4.6, z: -far, heightReal: 0.8, color: '#a51d1d' }));
  labels.add(makeLabel('D · DOĞU (+X)', { x: far, y: 4.6, z: 0, heightReal: 0.8, color: '#1d4fa5' }));
  labels.add(makeLabel('G · GÜNEY (+Z)', { x: 0, y: 4.6, z: far, heightReal: 0.8, color: '#1d7a35' }));
  labels.add(makeLabel('B · BATI (−X)', { x: -far, y: 4.6, z: 0, heightReal: 0.8, color: '#9a6a10' }));
  labels.add(makeLabel('Ölçek 1:70 · grid 1 m', { x: SPAWN.xReal, y: 0.6, z: SPAWN.zReal + 2.2, heightReal: 0.25 }));
  group.add(labels);

  return {
    group,
    dispose() {
      archMesh.geometry.dispose();
      material.dispose();
      labels.children.forEach((s) => { s.material.map.dispose(); s.material.dispose(); });
    },
  };
}

/** Zemin + 1 m grid (gerçek metre ölçeğinde, maket biriminde tanımlı). */
export function buildGround() {
  const group = new THREE.Group();
  group.name = 'ground';
  const size = 60;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(R(size), R(size)),
    new THREE.MeshLambertMaterial({ color: COLORS.ground }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -R(0.005);
  group.add(ground);

  const grid = new THREE.GridHelper(R(40), 40, 0x33402c, 0x5f6e55);
  grid.position.y = R(0.003);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  group.add(grid);
  return group;
}

/**
 * .glb/.gltf yükler ve maket birimine getirir.
 * @param {string} url  sayfaya göreli (ör. "assets/models/bina.glb")
 * @param {{units?: 'model'|'real'}} opts
 *   units='model' (varsayılan): dosya zaten 1:70 maket ölçüsünde (metre).
 *   units='real' : dosya gerçek ölçüde -> 1/70 ile maket birimine indirilir.
 */
export async function loadArchitectureModel(url, { units = 'model' } = {}) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(new URL(url, document.baseURI).href);
  const root = gltf.scene;
  root.name = `model:${url}`;
  if (units === 'real') root.scale.setScalar(SCALE.MODEL_RATIO);
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return {
    group: root,
    dispose() {
      root.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); });
        }
      });
    },
  };
}
