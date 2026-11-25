// İsteğe bağlı tarayıcı duman testi (Playwright + IWER WebXR emülatörü). Ayrıntı: README "Testler".
// Duman testi: masaüstü (sahte webcam) + WebXR emülasyonu (IWER, Quest 3 el pozları).
// CDN istekleri yerel npm kopyalarından sunulur (sandbox CDN'e erişemiyor).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');

const ROOT = process.argv[2];
// MIRROR: three@0.170.0, @mediapipe/tasks-vision@0.10.14, iwer kurulu bir npm klasörü + hand_landmarker.task
const MIRROR = process.env.CDN_MIRROR || path.resolve('cdnmirror');
const OUT = process.env.OUT_DIR || path.resolve('smoke-out');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
// GitHub Pages alt dizinini taklit et: /webxr-quest3/
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/webxr-quest3/')) { res.writeHead(404); return res.end(); }
  let p = path.join(ROOT, decodeURIComponent(u.pathname.slice('/webxr-quest3/'.length)));
  if (p.endsWith('/') || fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(8765);

function mapCdn(url) {
  let m;
  if ((m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\/(.*)$/))) return path.join(MIRROR, 'node_modules/three', m[1]);
  if ((m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@0\.10\.14\/(.*)$/))) return path.join(MIRROR, 'node_modules/@mediapipe/tasks-vision', m[1]);
  if (url.startsWith('https://storage.googleapis.com/mediapipe-models/hand_landmarker/')) return path.join(MIRROR, 'hand_landmarker.task');
  return null;
}

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser, { xr = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
  await ctx.route('https://**/*', async (route) => {
    const f = mapCdn(route.request().url());
    if (f && fs.existsSync(f)) return route.fulfill({ path: f, headers: { 'access-control-allow-origin': '*', 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } });
    console.log('  [blocked]', route.request().url());
    return route.abort();
  });
  if (xr) {
    await ctx.addInitScript({ path: path.join(MIRROR, 'node_modules/iwer/build/iwer.min.js') });
    await ctx.addInitScript(() => {
      const d = new IWER.XRDevice(IWER.metaQuest3);
      d.installRuntime({ forceInstall: true });
      d.primaryInputMode = 'hand';
      window.__xrDevice = d;
    });
  }
  const page = await ctx.newPage();
  const logs = { errors: [], warnings: [], all: [] };
  page.on('console', (m) => { logs.all.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') logs.errors.push(m.text()); if (m.type() === 'warning') logs.warnings.push(m.text()); });
  page.on('pageerror', (e) => logs.errors.push(`pageerror: ${e.message}`));
  return { ctx, page, logs };
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// ------------------------------------------------------------ A) Masaüstü
{
  const { page, logs, ctx } = await newPage(browser);
  await page.goto('http://localhost:8765/webxr-quest3/');
  await page.waitForFunction(() => window.__app && window.__app.state.architecture, null, { timeout: 20000 });
  await sleep(800);
  const info = await page.evaluate(() => ({
    vr: document.getElementById('btn-vr').textContent,
    vrDisabled: document.getElementById('btn-vr').disabled,
    calls: window.__app && null,
    scale: window.__app.modelRoot.scale.x,
    head: { x: window.__app.rig.position.x, z: window.__app.rig.position.z },
  }));
  check('Masaüstü: sayfa alt dizinde yüklendi, sahne kuruldu', true, JSON.stringify(info));
  check('Masaüstü: modelRoot ölçeği 70 (1:70 insan gözü)', info.scale === 70);
  check('Masaüstü: WebXR yokken Enter VR devre dışı + açıklama', info.vrDisabled && /desteklenmiyor/.test(info.vr), info.vr);
  await page.screenshot({ path: `${OUT}/desktop-start.png` });

  // Klavye debug ile ileri yürü (aynı locomotion)
  const z0 = await page.evaluate(() => window.__app.rig.position.z);
  await page.keyboard.down('KeyW'); await sleep(1000); await page.keyboard.up('KeyW');
  const z1 = await page.evaluate(() => window.__app.rig.position.z);
  check('Masaüstü: ileri hareket -Z yönünde', z1 < z0 - 0.5, `Δz=${(z1 - z0).toFixed(2)} m`);
  await page.keyboard.down('KeyD'); await sleep(700); await page.keyboard.up('KeyD');
  const yaw = await page.evaluate(() => window.__app.rig.rotation.y);
  check('Masaüstü: sağa dönüş (yaw < 0)', yaw < -0.2, `yaw=${(yaw * 180 / Math.PI).toFixed(1)}°`);
  await page.click('#btn-reset');

  // Ölçek modu değişimi
  await page.selectOption('#scale-select', 'model');
  await sleep(200);
  const s2 = await page.evaluate(() => ({ s: window.__app.modelRoot.scale.x, z: window.__app.rig.position.z }));
  check('Masaüstü: 1:1 maket modu (modelRoot ölçeği 1, konum orantılı)', s2.s === 1 && Math.abs(s2.z - 10 / 70) < 1e-3, JSON.stringify(s2));
  await page.screenshot({ path: `${OUT}/desktop-model-mode.png` });
  await page.selectOption('#scale-select', 'human');

  // Kamera: izin penceresi -> vazgeç
  await page.click('#btn-start-cam');
  const consentVisible = await page.isVisible('#consent');
  check('Kamera: başlamadan önce açık izin penceresi', consentVisible);
  await page.click('#consent-cancel');
  check('Kamera: vazgeçince kamera başlamaz', (await page.evaluate(() => window.__app.desktopHands.state)) === 'stopped');

  // Kamera: onayla (sahte webcam) -> MediaPipe çalışmalı
  await page.click('#btn-start-cam');
  await page.click('#consent-ok');
  await page.waitForFunction(() => ['running', 'error'].includes(window.__app.desktopHands.state), null, { timeout: 60000 });
  const cam = await page.evaluate(() => ({ st: window.__app.desktopHands.state, del: window.__app.desktopHands.delegate }));
  await sleep(2500);
  const camInfo = await page.evaluate(() => ({ inf: window.__app.desktopHands.inferenceMs, ht: document.getElementById('dbg-ht').textContent, raw: !!window.__app.desktopHands.lastRaw }));
  check('Kamera: sahte webcam + MediaPipe Hand Landmarker çalışıyor', cam.st === 'running' && camInfo.raw, `${JSON.stringify(cam)} ${JSON.stringify(camInfo)}`);
  await page.screenshot({ path: `${OUT}/desktop-camera.png` });
  await page.click('#btn-stop-cam');
  await sleep(300);
  const stopped = await page.evaluate(() => ({ st: window.__app.desktopHands.state, tracks: !!document.getElementById('cam-video').srcObject }));
  check('Kamera: Stop Camera akışı serbest bırakır', stopped.st === 'stopped' && !stopped.tracks, JSON.stringify(stopped));

  check('Masaüstü: konsolda hata yok', logs.errors.length === 0, logs.errors.join(' | '));
  fs.writeFileSync(`${OUT}/desktop-console.txt`, logs.all.join('\n'));
  await ctx.close();
}

// ------------------------------------------------------------ B) Kamera izni reddi
{
  const ctx = await browser.newContext({ permissions: [] });
  await ctx.route('https://**/*', async (route) => {
    const f = mapCdn(route.request().url());
    return f ? route.fulfill({ path: f, headers: { 'access-control-allow-origin': '*', 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } }) : route.abort();
  });
  await ctx.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8765/webxr-quest3/');
  await page.waitForFunction(() => window.__app && window.__app.state.architecture);
  await page.click('#btn-start-cam');
  await page.click('#consent-ok');
  await page.waitForFunction(() => window.__app.desktopHands.state === 'error', null, { timeout: 60000 });
  const msg = await page.textContent('#notice');
  check('Kamera reddi: kullanıcıya anlaşılır hata', /reddedildi/.test(msg), msg);
  await ctx.close();
}

// ------------------------------------------------------------ C) WebXR emülasyonu (IWER, Quest 3 el takibi)
{
  const { page, logs, ctx } = await newPage(browser, { xr: true });
  await page.goto('http://localhost:8765/webxr-quest3/');
  await page.waitForFunction(() => window.__app && window.__app.state.architecture);
  await page.waitForFunction(() => document.getElementById('btn-vr').textContent === 'Enter VR' && !document.getElementById('btn-vr').disabled, null, { timeout: 10000 });
  await page.click('#btn-vr');
  await page.waitForFunction(() => window.__app.xr.isPresenting, null, { timeout: 10000 });
  await sleep(500);
  const s = await page.evaluate(() => ({ ref: window.__app.xr.refSpaceType, ht: window.__app.xr.handTrackingEnabled, feats: window.__app.xr.session.enabledFeatures }));
  check('XR (emüle): immersive-vr başladı', true, JSON.stringify(s));

  const measure = async (pose, hand = 'right', ms = 1500) => {
    await page.evaluate(({ pose, hand }) => {
      const d = window.__xrDevice;
      for (const h of ['left', 'right']) { d.hands[h].poseId = 'open'; d.hands[h].updatePinchValue?.(0); }
      if (pose) d.hands[hand].poseId = pose;
    }, { pose, hand });
    await sleep(300);
    const a = await page.evaluate(() => ({ x: window.__app.rig.position.x, z: window.__app.rig.position.z, yaw: window.__app.rig.rotation.y }));
    await sleep(ms);
    const b = await page.evaluate(() => ({
      x: window.__app.rig.position.x, z: window.__app.rig.position.z, yaw: window.__app.rig.rotation.y,
      g: window.__app.gestures.lastResult,
    }));
    const ratios = b.g.hands.filter((h) => h.tracked).map((h) => `${h.id}: i=${h.ratios.index.toFixed(2)} r=${h.ratios.ring.toFixed(2)} p=${h.ratios.pinky.toFixed(2)}`).join(' ; ');
    return { dist: Math.hypot(b.x - a.x, b.z - a.z), dyaw: (b.yaw - a.yaw) * 180 / Math.PI, action: b.g.action, tracked: b.g.trackedCount, ratios };
  };

  const poses = await page.evaluate(() => window.__xrDevice.hands.right.poseIds);
  console.log('  IWER pozları:', poses.join(', '));

  let r = await measure(null);
  check('XR: açık el -> hareket yok', r.action === 'none' && r.dist < 1e-6 && Math.abs(r.dyaw) < 1e-6, JSON.stringify(r));
  check('XR: iki el WebXR joint verisiyle izleniyor', r.tracked === 2, r.ratios);

  r = await measure('pinch');
  check('XR: başparmak+işaret pinch -> ileri yürü', r.action === 'forward' && r.dist > 1, JSON.stringify(r));
  await page.screenshot({ path: `${OUT}/xr-walk.png` });

  r = await measure('pinch-pinky');
  check('XR: başparmak+serçe -> sağa dönüş', r.action === 'turnRight' && r.dyaw < -30, JSON.stringify(r));

  r = await measure('pinch-ring');
  check('XR: başparmak+yüzük -> sola dönüş', r.action === 'turnLeft' && r.dyaw > 30, JSON.stringify(r));

  r = await measure('pinch-middle');
  check('XR: başparmak+orta parmak -> eşlenmemiş, hareket yok', r.action === 'none' && r.dist < 0.01, JSON.stringify(r));

  r = await measure('pinch', 'left');
  check('XR: sol elle de ileri yürünebilir', r.action === 'forward' && r.dist > 1, JSON.stringify(r));

  for (const p of ['fist', 'point', 'ok', 'default', 'flat']) {
    r = await measure(p, 'right', 600);
    console.log(`  bilgi: '${p}' pozu -> ${r.action} (${r.ratios})`);
  }

  // Pinch bırakıldığında anında dur
  await measure('pinch', 'right', 500);
  await page.evaluate(() => { window.__xrDevice.hands.right.poseId = 'open'; });
  await sleep(150);
  const stop = await page.evaluate(() => window.__app.locomotion.currentSpeed);
  check('XR: pinch bırakılınca hız 0', stop === 0, `speed=${stop}`);

  // Baş dönüşü: yürüme yönü başın yatay yönünü izler, pitch etkilemez
  await page.evaluate(() => {
    const d = window.__xrDevice;
    const q = window.__app.THREE ? null : null;
    // Başı 90° sola + 40° aşağı çevir
    const e = new (window.__app.THREE.Euler)(-0.7, Math.PI / 2, 0, 'YXZ');
    const qq = new (window.__app.THREE.Quaternion)().setFromEuler(e);
    d.quaternion.x = qq.x; d.quaternion.y = qq.y; d.quaternion.z = qq.z; d.quaternion.w = qq.w;
  });
  await sleep(200);
  const yaw0 = await page.evaluate(() => window.__app.rig.rotation.y);
  const pos0 = await page.evaluate(() => ({ x: window.__app.rig.position.x, y: window.__app.rig.position.y, z: window.__app.rig.position.z }));
  await page.evaluate(() => { window.__xrDevice.hands.right.poseId = 'pinch'; });
  await sleep(1200);
  await page.evaluate(() => { window.__xrDevice.hands.right.poseId = 'open'; });
  const pos1 = await page.evaluate(() => ({ x: window.__app.rig.position.x, y: window.__app.rig.position.y, z: window.__app.rig.position.z }));
  const dirWorld = Math.atan2(-(pos1.x - pos0.x), -(pos1.z - pos0.z)) * 180 / Math.PI;
  const expected = (yaw0 * 180 / Math.PI + 90);
  const diff = ((dirWorld - expected + 540) % 360) - 180;
  check('XR: yürüme yönü baş yaw’ını izler, aşağı bakış (pitch) dikey hareket yaratmaz', Math.abs(diff) < 3 && pos1.y === pos0.y, `yön=${dirWorld.toFixed(1)}°, beklenen=${expected.toFixed(1)}°, Δy=${pos1.y - pos0.y}`);
  await page.screenshot({ path: `${OUT}/xr-head-turned.png` });

  // Ölçek: başın gerçek yüksekliği korunur (XR pose ölçeklenmez)
  const eye = await page.evaluate(() => ({ dev: window.__xrDevice.position.y, app: window.__app.state.lastHeadLocal.position.y }));
  check('XR: göz yüksekliği cihazdan aynen gelir (ölçeklenmez)', Math.abs(eye.dev - eye.app) < 0.02, JSON.stringify(eye));

  // Oturumu kapat
  await page.click('#btn-vr').catch(() => {});
  await page.evaluate(() => window.__app.xr.session && window.__app.xr.end());
  await page.waitForFunction(() => !window.__app.xr.isPresenting, null, { timeout: 10000 });
  await sleep(500);
  const after = await page.evaluate(() => ({ btn: document.getElementById('btn-vr').textContent, camY: window.__app.camera.position.y, fov: window.__app.camera.fov }));
  check('XR: oturum kapandı, masaüstü kamera geri yüklendi', after.btn === 'Enter VR' && Math.abs(after.camY - 1.6) < 1e-6 && Math.abs(after.fov - 70) < 1e-6, JSON.stringify(after));
  await page.screenshot({ path: `${OUT}/xr-after-exit.png` });
  // ikinci kez gir/çık
  await page.click('#btn-vr');
  await page.waitForFunction(() => window.__app.xr.isPresenting, null, { timeout: 10000 });
  await sleep(300);
  await page.evaluate(() => window.__app.xr.end());
  await page.waitForFunction(() => !window.__app.xr.isPresenting, null, { timeout: 10000 });
  check('XR: ikinci giriş/çıkış sorunsuz', true);
  check('XR: konsolda hata yok', logs.errors.length === 0, logs.errors.join(' | '));
  fs.writeFileSync(`${OUT}/xr-console.txt`, logs.all.join('\n'));
  await ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti`);
process.exit(failed.length ? 1 : 0);
