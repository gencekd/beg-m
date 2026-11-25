// ---------------------------------------------------------------------------
// Uygulama girişi: sahne grafiği, ölçek sistemi, render döngüsü ve arayüz.
//
// Sahne grafiği:
//   scene
//   ├── modelRoot (scale = viewScale: 70 insan gözü / 1 maket)   <- 1:70 maket içeriği
//   │   ├── ground (zemin + 1 m grid)
//   │   └── architecture (örnek sahne veya yüklenen .glb)
//   └── rig (konum x/z + yaw; ölçek HER ZAMAN 1)                <- locomotion bunu hareket ettirir
//       └── xrSpace (WebXR referans uzayı; 'local' fallback'te y ofseti)
//           ├── camera (XR'de pozu doğrudan head pose'dan gelir)
//           │   └── StatusHUD
//           └── XR el eklemleri (InstancedMesh)
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { SCALE, VIEW_MODES, LOCOMOTION, GESTURES } from './config.js';
import { GestureEngine } from './gestures.js';
import { Locomotion, forwardFromQuaternion } from './locomotion.js';
import { XRManager } from './xr-manager.js';
import { XRHandTracker } from './hand-tracking.js';
import { DesktopHands } from './desktop-hands.js';
import { StatusHUD } from './hud.js';
import { buildGround, buildSampleArchitecture, loadArchitectureModel, SPAWN, R } from './scene.js';

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const els = {
  canvasHost: $('scene'),
  btnVR: $('btn-vr'),
  btnStartCam: $('btn-start-cam'),
  btnStopCam: $('btn-stop-cam'),
  btnReset: $('btn-reset'),
  scaleSelect: $('scale-select'),
  walkTurn: $('walk-turn'),
  notice: $('notice'),
  consent: $('consent'),
  consentOk: $('consent-ok'),
  consentCancel: $('consent-cancel'),
  camWrap: $('cam-wrap'),
  video: $('cam-video'),
  overlay: $('cam-overlay'),
  dbg: {
    xr: $('dbg-xr'), ref: $('dbg-ref'), ht: $('dbg-ht'), src: $('dbg-src'), hand: $('dbg-hand'),
    pinch: $('dbg-pinch'), ratios: $('dbg-ratios'), speed: $('dbg-speed'), turn: $('dbg-turn'),
    scale: $('dbg-scale'), eye: $('dbg-eye'), fps: $('dbg-fps'), cam: $('dbg-cam'),
  },
};

// ---------------------------------------------------------------- Renderer & sahne
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setFoveation(1);
els.canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd6ea);
scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x6f6a5c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-0.4, 1, 0.6);
scene.add(sun);

const modelRoot = new THREE.Group();
modelRoot.name = 'modelRoot';
scene.add(modelRoot);
modelRoot.add(buildGround());

const rig = new THREE.Group();
rig.name = 'rig';
scene.add(rig);
const xrSpace = new THREE.Group();
xrSpace.name = 'xrSpace';
rig.add(xrSpace);

// Near plane 1 cm: maket modunda (23 cm'lik bina) bile kırpma olmaz.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 300);
camera.rotation.order = 'YXZ';
camera.position.set(0, LOCOMOTION.DESKTOP_EYE_HEIGHT, 0);
xrSpace.add(camera);

// ---------------------------------------------------------------- Sistemler
const xr = new XRManager(renderer, xrSpace);
const xrHands = new XRHandTracker(xrSpace);
const hud = new StatusHUD(camera);
const desktopHands = new DesktopHands(els.video, els.overlay);
const gestures = new GestureEngine({ ...GESTURES });
const locomotion = new Locomotion(rig);

const state = {
  viewMode: VIEW_MODES.human,
  architecture: null,
  xrWarning: '',
  xrStartTime: 0,
  alignHeadOnXRStart: null,
  lastXRHead: null,
  keys: new Set(),
  inputSource: 'yok',
  fps: 0,
  lastHeadLocal: { position: { x: 0, y: LOCOMOTION.DESKTOP_EYE_HEIGHT, z: 0 }, forward: { x: 0, y: 0, z: -1 } },
  savedCamera: null,
};

// ---------------------------------------------------------------- Bildirimler
let noticeTimer = 0;
function notify(message, kind = 'info', ms = 6000) {
  els.notice.textContent = message;
  els.notice.dataset.kind = kind;
  els.notice.hidden = false;
  clearTimeout(noticeTimer);
  if (ms > 0) noticeTimer = setTimeout(() => { els.notice.hidden = true; }, ms);
  (kind === 'error' ? console.warn : console.info)(`[app] ${message}`);
}

// ---------------------------------------------------------------- Ölçek
function worldFromReal(real) { return R(real) * state.viewMode.viewScale; }

function setViewMode(id) {
  const next = VIEW_MODES[id];
  if (!next || next === state.viewMode) return;
  const ratio = next.viewScale / state.viewMode.viewScale;
  // Kullanıcının maket içindeki konumu korunur: başın dünya x/z'si orana göre ölçeklenir.
  const head = locomotion.headWorld(state.lastHeadLocal.position);
  state.viewMode = next;
  modelRoot.scale.setScalar(next.viewScale);
  locomotion.setViewScale(next.viewScale);
  locomotion.placeHeadAt(head.x * ratio, head.z * ratio, rig.rotation.y, state.lastHeadLocal.position);
}

function resetPosition() {
  if (!xr.isPresenting) {
    camera.rotation.set(0, 0, 0);
    state.lastHeadLocal = headFromCamera();
  }
  locomotion.placeHeadAt(worldFromReal(SPAWN.xReal), worldFromReal(SPAWN.zReal), SPAWN.yaw, state.lastHeadLocal.position);
  gestures.reset();
}

// ---------------------------------------------------------------- Mimari içerik
async function loadArchitecture() {
  const params = new URLSearchParams(location.search);
  const modelUrl = params.get('model');
  if (modelUrl) {
    try {
      const units = params.get('units') === 'real' ? 'real' : 'model';
      const m = await loadArchitectureModel(modelUrl, { units });
      setArchitecture(m);
      notify(`Model yüklendi: ${modelUrl} (${units === 'real' ? 'gerçek ölçü → 1:70' : '1:70 maket ölçüsü'})`);
      return;
    } catch (e) {
      notify(`Model yüklenemedi (${modelUrl}): ${e.message || e}. Örnek sahne gösteriliyor.`, 'error', 9000);
    }
  }
  setArchitecture(buildSampleArchitecture());
}

function setArchitecture(arch) {
  if (state.architecture) {
    state.architecture.group.removeFromParent();
    state.architecture.dispose();
  }
  state.architecture = arch;
  modelRoot.add(arch.group);
}

// ---------------------------------------------------------------- Baş pozu (rig-yerel)
const _q = new THREE.Quaternion();
function headFromCamera() {
  _q.copy(camera.quaternion);
  return {
    position: { x: camera.position.x + xrSpace.position.x, y: camera.position.y + xrSpace.position.y, z: camera.position.z + xrSpace.position.z },
    forward: forwardFromQuaternion(_q),
  };
}

/** XR'de doğrudan bu karenin viewer pose'u kullanılır (ölçeklenmeden). */
function headFromXR(frame, refSpace) {
  const pose = frame.getViewerPose(refSpace);
  if (!pose) return null;
  const p = pose.transform.position;
  const o = pose.transform.orientation;
  return {
    position: { x: p.x + xrSpace.position.x, y: p.y + xrSpace.position.y, z: p.z + xrSpace.position.z },
    forward: forwardFromQuaternion(o),
    emulated: pose.emulatedPosition,
  };
}

function headingYaw(headLocal) {
  const f = headLocal.forward;
  // yerel yaw + rig yaw (three.js: +yaw = sola)
  return Math.atan2(-f.x, -f.z) + rig.rotation.y;
}

// ---------------------------------------------------------------- XR yaşam döngüsü
xr.addEventListener('sessionstart', () => {
  desktopHands.stop(); // webcam ile çakışmayı önle
  els.camWrap.hidden = true;
  gestures.reset();
  locomotion.stop();
  state.savedCamera = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov };
  const head = locomotion.headWorld(state.lastHeadLocal.position);
  state.alignHeadOnXRStart = { x: head.x, z: head.z, yaw: headingYaw(state.lastHeadLocal) };
  xrHands.reset();
  hud.visible = true;
  state.xrWarning = '';
  state.xrStartTime = performance.now();
  updateButtons();
});

xr.addEventListener('sessionend', () => {
  hud.visible = false;
  xrHands.reset();
  gestures.reset();
  locomotion.stop();
  // Masaüstü kamerayı geri yükle; kullanıcı VR'de nerede ve nereye bakıyorsa oradan devam et.
  if (state.savedCamera) {
    camera.position.copy(state.savedCamera.position);
    camera.fov = state.savedCamera.fov;
  }
  camera.rotation.set(0, 0, 0);
  camera.updateProjectionMatrix();
  const last = state.lastXRHead;
  const local = headFromCamera();
  if (last) locomotion.placeHeadAt(last.x, last.z, last.yaw, local.position);
  state.lastHeadLocal = local;
  state.lastXRHead = null;
  onResize();
  updateButtons();
  if (state.xrWarning) notify(`VR oturumu bitti. Uyarı: ${state.xrWarning}`, 'error', 9000);
});

xr.addEventListener('error', (e) => notify(e.detail.message, 'error', 9000));
xr.addEventListener('warning', (e) => { state.xrWarning = 'El takibi kapalı'; notify(e.detail.message, 'error', 9000); });
xr.addEventListener('statechange', updateButtons);

function checkXRHandWarnings(now) {
  if (now - state.xrStartTime < 4000) return;
  if (xrHands.handsSeen) {
    if (state.xrWarning && state.xrWarning !== 'El takibi kapalı') state.xrWarning = '';
    return;
  }
  if (xr.handTrackingEnabled === false) state.xrWarning = 'El takibi kapalı';
  else if (xrHands.controllersSeen) state.xrWarning = 'Kontrolcüleri bırakın (el takibi)';
  else state.xrWarning = 'Eller algılanmadı';
}

// ---------------------------------------------------------------- Masaüstü kamera
desktopHands.addEventListener('error', (e) => {
  notify(e.detail.message, 'error', 10000);
  els.camWrap.hidden = true;
});
desktopHands.addEventListener('statechange', () => {
  els.camWrap.hidden = !(desktopHands.state === 'running' || desktopHands.state === 'loading');
  els.camWrap.dataset.state = desktopHands.state;
  if (desktopHands.state !== 'running') gestures.reset();
  updateButtons();
});

function askCameraConsent() {
  return new Promise((resolve) => {
    els.consent.hidden = false;
    const done = (ok) => {
      els.consent.hidden = true;
      els.consentOk.removeEventListener('click', onOk);
      els.consentCancel.removeEventListener('click', onCancel);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    els.consentOk.addEventListener('click', onOk);
    els.consentCancel.addEventListener('click', onCancel);
    els.consentOk.focus();
  });
}

// ---------------------------------------------------------------- Arayüz
function updateButtons() {
  const presenting = xr.isPresenting;
  if (xr.state === 'unsupported') {
    els.btnVR.disabled = true;
    els.btnVR.textContent = 'VR desteklenmiyor';
    els.btnVR.title = xr.lastError || '';
  } else {
    els.btnVR.disabled = xr.state === 'starting' || xr.state === 'ending';
    els.btnVR.textContent = presenting ? 'Exit VR' : xr.state === 'starting' ? 'Başlatılıyor…' : 'Enter VR';
    els.btnVR.title = '';
  }
  const camState = desktopHands.state;
  els.btnStartCam.disabled = presenting || camState === 'running' || camState === 'loading';
  els.btnStartCam.textContent = camState === 'loading' ? 'Yükleniyor…' : 'Start Camera';
  els.btnStopCam.disabled = !(camState === 'running' || camState === 'loading');
}

els.btnVR.addEventListener('click', () => {
  if (xr.isPresenting) xr.end();
  else xr.start();
});
els.btnStartCam.addEventListener('click', async () => {
  if (!window.isSecureContext) {
    notify('Kamera yalnızca HTTPS veya localhost üzerinde kullanılabilir.', 'error');
    return;
  }
  const ok = await askCameraConsent();
  if (!ok) { notify('Kamera başlatılmadı (izin verilmedi).'); return; }
  els.camWrap.hidden = false;
  await desktopHands.start();
  if (desktopHands.running) notify(`El takibi başladı (MediaPipe, ${desktopHands.delegate}).`);
});
els.btnStopCam.addEventListener('click', () => desktopHands.stop());
els.btnReset.addEventListener('click', resetPosition);
els.scaleSelect.addEventListener('change', () => setViewMode(els.scaleSelect.value));
els.walkTurn.addEventListener('change', () => {
  gestures.cfg = { ...GESTURES, allowWalkWhileTurning: els.walkTurn.checked };
});

// Klavye (yalnızca hata ayıklama): W/↑ ileri, A/← sola, D/→ sağa, R sıfırla
const KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (KEYMAP[e.code]) { state.keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.code === 'KeyR') resetPosition();
});
window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) state.keys.delete(KEYMAP[e.code]); });
window.addEventListener('blur', () => state.keys.clear());

// Masaüstünde fare ile bakış (yalnızca kamera yerel yaw/pitch; yürüyüş yatay kalır)
let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (xr.isPresenting) return;
  drag = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag || xr.isPresenting) return;
  const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  camera.rotation.y -= dx * 0.004;
  camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - dy * 0.004, -1.4, 1.4);
});
renderer.domElement.addEventListener('pointerup', () => { drag = null; });
renderer.domElement.addEventListener('pointercancel', () => { drag = null; });

function onResize() {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

window.addEventListener('pagehide', () => {
  desktopHands.dispose();
  if (xr.session) xr.end();
});

// ---------------------------------------------------------------- Debug paneli
const ACTION_LABEL = { forward: 'İleri (başparmak+işaret)', turnRight: 'Sağa (başparmak+serçe)', turnLeft: 'Sola (başparmak+yüzük)', none: '—' };
const REASON_LABEL = { 'conflict-turn': 'çakışma: iki yön', 'turn-priority': 'dönüş öncelikli', ambiguous: 'belirsiz pinch', 'no-hands': 'el yok' };
let lastDebug = 0;
const fmtRatio = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
function updateDebug(now, g, cmdSource) {
  if (now - lastDebug < 100) return; // DOM'u 10 Hz ile güncelle
  lastDebug = now;
  const d = els.dbg;
  d.xr.textContent = xr.isPresenting ? 'immersive-vr aktif' : (xr.state === 'unsupported' ? 'desteklenmiyor' : xr.state === 'starting' ? 'başlatılıyor' : 'masaüstü');
  d.ref.textContent = xr.refSpaceType || '—';
  let ht;
  if (xr.isPresenting) {
    const n = xrHands.lastHands.filter((h) => h.tracked).length;
    ht = `WebXR: ${n}/2 el${xr.handTrackingEnabled === false ? ' (özellik verilmedi)' : ''}${state.xrWarning ? ` · ${state.xrWarning}` : ''}`;
  } else if (desktopHands.state === 'running') {
    ht = `MediaPipe: ${g.trackedCount}/2 el · ${desktopHands.delegate} ${desktopHands.inferenceMs.toFixed(0)} ms`;
  } else {
    ht = desktopHands.state === 'loading' ? 'MediaPipe yükleniyor…' : 'kapalı';
  }
  d.ht.textContent = ht;
  d.src.textContent = cmdSource;
  const tracked = g.hands.filter((h) => h.tracked);
  d.hand.textContent = tracked.length ? tracked.map((h) => `${h.id === 'left' ? 'sol' : h.id === 'right' ? 'sağ' : h.id}${h.active ? '*' : ''}`).join(', ') : 'yok';
  const middleOnly = g.action === 'none' && tracked.some((h) => h.active === 'middle');
  d.pinch.textContent = middleOnly ? 'orta parmak (eşlenmemiş, yok sayıldı)' : `${ACTION_LABEL[g.action] || g.action}${REASON_LABEL[g.reason] ? ` (${REASON_LABEL[g.reason]})` : ''}`;
  d.ratios.textContent = tracked.length
    ? tracked.map((h) => `${h.id[0].toUpperCase()}: i ${h.ratios.index.toFixed(2)} o ${fmtRatio(h.ratios.middle)} y ${h.ratios.ring.toFixed(2)} s ${h.ratios.pinky.toFixed(2)}`).join(' | ')
    : '—';
  d.speed.textContent = `${locomotion.currentSpeed.toFixed(3)} m/s dünya · ${locomotion.realSpeed().toFixed(2)} m/s bina ölçeğinde`;
  d.turn.textContent = `${locomotion.currentTurnRate.toFixed(0)} °/s ${locomotion.currentTurnRate < 0 ? '(sağa)' : locomotion.currentTurnRate > 0 ? '(sola)' : ''}`;
  d.scale.textContent = `1:${Math.round(1 / SCALE.MODEL_RATIO)} · ${state.viewMode.label}`;
  const eyeWorld = state.lastHeadLocal.position.y;
  const eyeModel = eyeWorld / state.viewMode.viewScale;
  const eyeReal = eyeModel / SCALE.MODEL_RATIO;
  d.eye.textContent = `${eyeWorld.toFixed(2)} m dünya → maket ${(eyeModel * 1000).toFixed(1)} mm → bina ${eyeReal.toFixed(2)} m${xr.isPresenting ? '' : ' (masaüstü sabit)'}`;
  d.fps.textContent = state.fps.toFixed(0);
  d.cam.textContent = desktopHands.state;
}

// ---------------------------------------------------------------- Render döngüsü
let prevTime = performance.now();
let fpsFrames = 0; let fpsStart = prevTime;

function frameLoop(_time, frame) {
  const now = performance.now();
  const dt = (now - prevTime) / 1000;
  prevTime = now;

  // 1) El verisi: XR'de WebXR joint'leri, masaüstünde MediaPipe
  let hands = [];
  let head;
  if (frame && renderer.xr.isPresenting) {
    const refSpace = renderer.xr.getReferenceSpace();
    hands = xrHands.update(frame, refSpace, gestures.lastResult);
    head = headFromXR(frame, refSpace) || state.lastHeadLocal;
    state.inputSource = 'WebXR hand-tracking';
    checkXRHandWarnings(now);
    if (state.alignHeadOnXRStart && head !== state.lastHeadLocal) {
      // VR'ye girerken kullanıcının sahnedeki konumu ve bakış yönü korunur.
      const a = state.alignHeadOnXRStart;
      const localYaw = Math.atan2(-head.forward.x, -head.forward.z);
      locomotion.placeHeadAt(a.x, a.z, a.yaw - localYaw, head.position);
      state.alignHeadOnXRStart = null;
    }
  } else {
    if (desktopHands.running) {
      hands = desktopHands.update(now, gestures.lastResult);
      state.inputSource = 'MediaPipe webcam';
    } else {
      state.inputSource = 'yok';
    }
    head = headFromCamera();
  }
  state.lastHeadLocal = head;

  // 2) Ortak jest motoru
  const g = gestures.update(hands, now);

  // 3) Komut (klavye yalnızca hata ayıklama içindir ve jestleri geçersiz kılar)
  let cmd = { forward: g.forward, turn: g.turn };
  let cmdSource = g.action !== 'none' ? state.inputSource : '—';
  if (state.keys.size) {
    const turn = (state.keys.has('l') ? 1 : 0) + (state.keys.has('r') ? -1 : 0);
    cmd = { forward: state.keys.has('f'), turn };
    cmdSource = 'klavye (debug)';
  }

  // 4) Hareket (deltaTime ile, frame-rate bağımsız)
  locomotion.update(cmd, dt, head);

  if (renderer.xr.isPresenting) {
    const hw = locomotion.headWorld(head.position);
    state.lastXRHead = { x: hw.x, z: hw.z, yaw: headingYaw(head) };
    const action = cmd.turn < 0 ? 'turnRight' : cmd.turn > 0 ? 'turnLeft' : cmd.forward ? 'forward' : 'none';
    hud.update({
      action,
      hands: hands.filter((h) => h.tracked).length,
      warning: state.xrWarning,
      scaleLabel: state.viewMode.id === 'human' ? '1:70 insan' : '1:1 maket',
      speed: locomotion.realSpeed(),
      turnRate: Math.abs(locomotion.currentTurnRate),
    });
  }

  // 5) FPS + debug
  fpsFrames++;
  if (now - fpsStart >= 500) {
    state.fps = (fpsFrames * 1000) / (now - fpsStart);
    fpsFrames = 0; fpsStart = now;
  }
  updateDebug(now, g, cmdSource);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- Başlat
async function init() {
  modelRoot.scale.setScalar(state.viewMode.viewScale);
  locomotion.setViewScale(state.viewMode.viewScale);
  els.scaleSelect.value = state.viewMode.id;
  for (const opt of els.scaleSelect.options) opt.textContent = VIEW_MODES[opt.value].label;
  resetPosition();
  updateButtons();
  renderer.setAnimationLoop(frameLoop);
  await loadArchitecture();

  const supported = await xr.checkSupport();
  updateButtons();
  if (!supported) {
    els.dbg.xr.textContent = 'desteklenmiyor';
    console.info(`[app] WebXR: ${xr.lastError}`);
  }
  if (!window.isSecureContext) notify('Sayfa HTTPS üzerinden açılmadı: VR ve kamera devre dışı.', 'error', 0);
  window.__app = { THREE, scene, rig, camera, modelRoot, gestures, locomotion, xr, desktopHands, state, setViewMode };
}

init().catch((e) => {
  console.error(e);
  notify(`Başlatma hatası: ${e.message || e}`, 'error', 0);
});
