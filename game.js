// RocketSim-Web demo
// Física de balón y auto EXACTA (RocketSim/WASM). Render simple: caja = hitbox real de
// Octane, piso de referencia, balón del radio real.
//
// Cámara y controles inspirados en ArcAr-Android (game_engine.cpp RebuildCamera() +
// InputMapper.java). El loop de cada frame está escrito para asignar la MÍNIMA memoria nueva
// posible (todo se reutiliza en buffers fijos).
//
// FIX 2026-09-27: 1 snapshot por frame + fallback automático a get*StateInto.
// - Si el WASM tiene getBallStateInto/getCarStateInto → zero alloc (ideal).
// - Si no → usa getBallState/getCarState (compatible con WASM viejo).
// Antes: getState 2-4x/frame → GC spikes ~32ms. Ahora 1x/frame (+ Into cuando haya).

import RocketSimModule from './dist/rocketsim.js';
import { pollGamepad } from './gamepad.js?v=5';

const TICK_RATE = 120;
const TICK_TIME = 1 / TICK_RATE;
const UU_TO_M = 1 / 50; // solo cosmético, para que la escena de three.js tenga una escala cómoda

// ---------- conversión de coordenadas RocketSim (Z-arriba) -> three.js (Y-arriba) ----------
// Nota: todas estas funciones escriben en un objeto/array que se les pasa (out), en vez de
// crear uno nuevo, para no generar basura en el loop de cada frame.
function rsToThreeInto(x, y, z, out) {
  out.x = x * UU_TO_M; out.y = z * UU_TO_M; out.z = -y * UU_TO_M;
  return out;
}
function rsDirToThreeInto(x, y, z, out) {
  out.x = x; out.y = z; out.z = -y;
  return out;
}

const _tmpMat = new THREE.Matrix4();
const _tmpX = new THREE.Vector3();
const _tmpY = new THREE.Vector3();
const _tmpZ = new THREE.Vector3();
const _dirTmp = { x: 0, y: 0, z: 0 };
// rot9: Float32Array(9) = [forward(3), right(3), up(3)] en espacio RocketSim.
// BoxGeometry: eje local X = largo (hb.x, "adelante" del auto), Y = ancho (hb.y, "derecha"),
// Z = alto (hb.z, "arriba"). Los ejes de la base van en ESE orden -- (forward, right, up) tal
// cual, sin negar nada: RocketSim cumple forward × right = up, y la transformación de
// coordenadas usada aquí tiene determinante +1 (es una rotación propia, no un espejo), así
// que preserva el producto cruz.
function rsRotToThreeQuat(rot9, outQuat) {
  rsDirToThreeInto(rot9[0], rot9[1], rot9[2], _dirTmp);
  _tmpX.set(_dirTmp.x, _dirTmp.y, _dirTmp.z);
  rsDirToThreeInto(rot9[3], rot9[4], rot9[5], _dirTmp);
  _tmpY.set(_dirTmp.x, _dirTmp.y, _dirTmp.z);
  rsDirToThreeInto(rot9[6], rot9[7], rot9[8], _dirTmp);
  _tmpZ.set(_dirTmp.x, _dirTmp.y, _dirTmp.z);
  _tmpMat.makeBasis(_tmpX, _tmpY, _tmpZ);
  outQuat.setFromRotationMatrix(_tmpMat);
  return outQuat;
}

// ---------- cámara: adaptación de la cámara de rl-replay-viewer (@rlrml/player 1.2.0) ----------
// Unidades en UU y ejes de RocketSim (Z arriba). Solo se convierte a three.js al aplicar la cámara.
// Valores de la referencia: distancia 260 · altura 90 · ángulo -4° · stiffness 0.45 · swivel 4.3 · transición 1.3.
// (La referencia guarda stiffness pero su cálculo de seguimiento no lo usa; aquí se conserva igual.)
// Se pueden ajustar por URL: ?fov=110&dist=260&height=90&angle=-4&stiff=0.45&swivel=4.3&trans=1.3
const CAM_PRESETS = {
  pro: { fov: 110, distance: 260, height: 90, angle: -4.0, stiffness: 0.45, swivel: 4.3, transition: 1.3 },
  zen: { fov: 110, distance: 270, height: 100, angle: -3.0, stiffness: 0.35, swivel: 4.0, transition: 1.2 },
};
const CAM_CFG = (() => {
  const q = new URLSearchParams(location.search);
  const cfg = Object.assign({}, CAM_PRESETS[q.get('preset')] || CAM_PRESETS.pro);
  const num = (k, key) => { const v = parseFloat(q.get(k)); if (isFinite(v)) cfg[key] = v; };
  num('fov', 'fov'); num('dist', 'distance'); num('height', 'height'); num('angle', 'angle');
  num('stiff', 'stiffness'); num('swivel', 'swivel'); num('trans', 'transition');
  cfg.stiffness = Math.min(Math.max(cfg.stiffness, 0), 1);
  return cfg;
})();

const DEG = Math.PI / 180;
const DBG_CAM = new URLSearchParams(location.search).get('dbgcam'); // vista de depuración: top | side | corner
const CAM_MIN_HEIGHT = 50;        // UU: la cámara nunca baja de esta altura
const CAM_BASE_DURATION = 0.5;    // s: duración base de la transición (se divide por transition)
const cam = {
  ballCam: true,                  // C / botón del mando lo alternan
  lastIsBallCam: null, blend: 1,  // mezcla Player Cam (0) <-> Ball Cam (1)
  smoothedYaw: 0, hasYaw: false,  // rumbo suavizado de la Player Cam (rad, plano XY de RocketSim)
  lastCarPos: [0, 0, 0], hasLast: false,
  carCamPos: [0, 0, 0], carCamLook: [0, 0, 0],    // candidato Player Cam (UU, RocketSim)
  ballCamPos: [0, 0, 0], ballCamLook: [0, 0, 0],  // candidato Ball Cam (UU, RocketSim)
  pos: [0, 0, 0],                                 // posición final mezclada (UU, RocketSim)
  ready: false,
};
const _cqCar = new THREE.Quaternion(), _cqBall = new THREE.Quaternion(), _cqOut = new THREE.Quaternion();
const _cMat = new THREE.Matrix4();
const _cEye = new THREE.Vector3(), _cTgt = new THREE.Vector3(), _cUp = new THREE.Vector3(0, 1, 0);
const _c3 = { x: 0, y: 0, z: 0 };

// Ángulo más corto de a hacia b (rad), en (-π, π].
function angDiff(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

// Player Cam: sigue el rumbo del auto; detecta marcha atrás; si el auto está invertido/en el aire usa la dirección de movimiento.
function computePlayerCam(carPos, fwd, upZ, onGround, dt) {
  if (!cam.hasLast) { cam.lastCarPos[0] = carPos[0]; cam.lastCarPos[1] = carPos[1]; cam.lastCarPos[2] = carPos[2]; cam.hasLast = true; }
  let mx = carPos[0] - cam.lastCarPos[0], my = carPos[1] - cam.lastCarPos[1];
  let moved = Math.hypot(mx, my);
  if (moved > 600) moved = 0;                        // teletransporte (saque/reinicio): no usarlo como movimiento
  const heading = Math.atan2(fwd[1], fwd[0]);        // rumbo del frente del auto
  const unstable = upZ < 0.5 || !onGround;           // invertido / de lado / en el aire
  let desired;
  if (unstable && moved > 0.01) {
    desired = Math.atan2(my, mx);                    // dirección de movimiento
  } else if (moved > 0.05) {
    const b = angDiff(heading, Math.atan2(my, mx));
    desired = Math.abs(b) > Math.PI / 2 ? heading + Math.PI : heading;   // marcha atrás: la cámara se queda detrás del movimiento
  } else {
    desired = heading;
  }
  cam.lastCarPos[0] = carPos[0]; cam.lastCarPos[1] = carPos[1]; cam.lastCarPos[2] = carPos[2];
  if (!cam.hasYaw) { cam.smoothedYaw = desired; cam.hasYaw = true; }
  const swivel = unstable ? CAM_CFG.swivel * 0.4 : CAM_CFG.swivel;
  cam.smoothedYaw += angDiff(cam.smoothedYaw, desired) * Math.min(1, swivel * dt);
  const cx = Math.cos(cam.smoothedYaw), cy = Math.sin(cam.smoothedYaw);
  cam.carCamPos[0] = carPos[0] - cx * CAM_CFG.distance;
  cam.carCamPos[1] = carPos[1] - cy * CAM_CFG.distance;
  cam.carCamPos[2] = Math.max(carPos[2] + CAM_CFG.height, CAM_MIN_HEIGHT);
  cam.carCamLook[0] = carPos[0] + cx * 50;
  cam.carCamLook[1] = carPos[1] + cy * 50;
  cam.carCamLook[2] = carPos[2];
}

// Ball Cam: detrás del auto respecto al balón; baja progresivamente si el balón está alto; mira entre balón y auto.
function computeBallCam(carPos, ballPos) {
  const ox = carPos[0] - ballPos[0], oy = carPos[1] - ballPos[1], len = Math.hypot(ox, oy);
  if (len < 1e-3) {                                  // balón justo encima del auto: sin dirección, usar la Player Cam
    for (let i = 0; i < 3; i++) { cam.ballCamPos[i] = cam.carCamPos[i]; cam.ballCamLook[i] = cam.carCamLook[i]; }
    return;
  }
  const l = Math.min(1, Math.max(0, (ballPos[2] - carPos[2]) / 800));   // 0 = balón a la altura del auto, 1 = ≥800 uu más alto
  cam.ballCamPos[0] = carPos[0] + (ox / len) * CAM_CFG.distance;
  cam.ballCamPos[1] = carPos[1] + (oy / len) * CAM_CFG.distance;
  cam.ballCamPos[2] = Math.max(carPos[2] + CAM_CFG.height - l * 100, CAM_MIN_HEIGHT);
  const k = l * 0.6;                                 // punto de mira: del balón hacia (auto + 100 de altura)
  cam.ballCamLook[0] = ballPos[0] + (carPos[0] - ballPos[0]) * k;
  cam.ballCamLook[1] = ballPos[1] + (carPos[1] - ballPos[1]) * k;
  cam.ballCamLook[2] = ballPos[2] + (carPos[2] + 100 - ballPos[2]) * k;
}

// Orientación "mira desde eye hacia target" en three.js (arriba = +Y), a partir de puntos en RocketSim.
function lookQuatFromRS(ex, ey, ez, tx, ty, tz, outQuat) {
  rsToThreeInto(ex, ey, ez, _c3); _cEye.set(_c3.x, _c3.y, _c3.z);
  rsToThreeInto(tx, ty, tz, _c3); _cTgt.set(_c3.x, _c3.y, _c3.z);
  _cMat.lookAt(_cEye, _cTgt, _cUp);
  return outQuat.setFromRotationMatrix(_cMat);
}

// Cada fotograma: dos candidatos (Player/Ball), transición temporal smoothstep, slerp por el camino corto.
function updateCamera(camera, carPos, fwd, upZ, ballPos, onGround, dt) {
  dt = Math.min(Math.max(dt || 1 / 60, 0), 0.05);
  const isBall = cam.ballCam;
  if (!cam.ready) cam.blend = isBall ? 1 : 0;        // arrancar sin transición
  if (cam.lastIsBallCam !== null && cam.lastIsBallCam !== isBall && !isBall) {
    // Ball -> Player: arrancar el rumbo desde donde está mirando la cámara, para que no salte
    const fx = cam.pos[0] - carPos[0], fy = cam.pos[1] - carPos[1];
    if (Math.hypot(fx, fy) > 0.01) cam.smoothedYaw = Math.atan2(-fy, -fx);
  }
  cam.lastIsBallCam = isBall;

  computePlayerCam(carPos, fwd, upZ, onGround, dt);
  computeBallCam(carPos, ballPos);

  // Transición: duración = clamp(0.5 / transition, 0.15, 0.6) s, curva smoothstep
  const target = isBall ? 1 : 0;
  const dur = Math.max(0.15, Math.min(0.6, CAM_BASE_DURATION / CAM_CFG.transition));
  const step = dt / dur;
  if (cam.blend < target) cam.blend = Math.min(cam.blend + step, target);
  else if (cam.blend > target) cam.blend = Math.max(cam.blend - step, target);
  const sm = cam.blend * cam.blend * (3 - 2 * cam.blend);

  // Posición: interpolación lineal entre candidatos (RocketSim)
  for (let i = 0; i < 3; i++) cam.pos[i] = cam.carCamPos[i] + (cam.ballCamPos[i] - cam.carCamPos[i]) * sm;
  if (cam.pos[2] < CAM_MIN_HEIGHT) cam.pos[2] = CAM_MIN_HEIGHT;

  // Orientación: slerp entre las dos orientaciones candidatas, corrigiendo el signo (camino corto)
  lookQuatFromRS(cam.carCamPos[0], cam.carCamPos[1], cam.carCamPos[2], cam.carCamLook[0], cam.carCamLook[1], cam.carCamLook[2], _cqCar);
  lookQuatFromRS(cam.ballCamPos[0], cam.ballCamPos[1], cam.ballCamPos[2], cam.ballCamLook[0], cam.ballCamLook[1], cam.ballCamLook[2], _cqBall);
  if (_cqCar.dot(_cqBall) < 0) _cqBall.set(-_cqBall.x, -_cqBall.y, -_cqBall.z, -_cqBall.w);
  _cqOut.copy(_cqCar).slerp(_cqBall, sm);

  // Aplicar a three.js (única conversión de ejes) y luego el ángulo de cámara (-4° => sube la mirada 4°)
  rsToThreeInto(cam.pos[0], cam.pos[1], cam.pos[2], _c3);
  camera.position.set(_c3.x, _c3.y, _c3.z);
  camera.quaternion.copy(_cqOut);
  if (CAM_CFG.angle !== 0) camera.rotateX(-CAM_CFG.angle * DEG);
  cam.ready = true;
}

// ---------- Loading progress (byte-accurate) ----------
const LOADING_ASSETS = [
  // name, url, sizeBytes (from actual files — used as fallback if no Content-Length)
  { name: 'Física WASM', url: 'dist/rocketsim.wasm', size: 841316 },
  { name: 'Fennec', url: 'assets/fennec.glb', size: 2780032 },
  { name: 'Estadio', url: 'assets/champions.glb', size: 6676848 },
  { name: 'Pelota', url: 'assets/ball.glb', size: 111276 },
  { name: 'Textura pelota', url: 'assets/ball_d.webp', size: 71312 },
  { name: 'Chasis D', url: 'assets/Chassis_Grain_D.webp', size: 110830 },
  { name: 'Chasis N', url: 'assets/Chassis_Grain_N.webp', size: 165808 },
  { name: 'Ruedas D', url: 'assets/Alpha_D.webp', size: 84596 },
  { name: 'Ruedas N', url: 'assets/Alpha_N.webp', size: 91916 },
  { name: 'Césped D', url: 'assets/grass_d.webp', size: 245232 },
  { name: 'Césped N', url: 'assets/grass_n.webp', size: 430096 },
  { name: 'Césped R', url: 'assets/grass_r.webp', size: 59888 },
  { name: 'Suelo', url: 'assets/ground_d.webp', size: 198752 },
  { name: 'Cielo', url: 'assets/sky.webp', size: 4282 },
];
const TOTAL_BYTES = LOADING_ASSETS.reduce((s, a) => s + a.size, 0);

const loadingUI = {
  bar: null, pct: null, status: null, el: null,
  loaded: 0,
  init() {
    this.el = document.getElementById('loading');
    this.bar = document.getElementById('loading-bar');
    this.pct = document.getElementById('loading-pct');
    this.status = document.getElementById('loading-status');
  },
  set(loadedBytes, statusText) {
    this.loaded = Math.min(loadedBytes, TOTAL_BYTES);
    const p = TOTAL_BYTES > 0 ? (this.loaded / TOTAL_BYTES) * 100 : 0;
    const rounded = Math.min(100, Math.round(p * 10) / 10); // 1 decimal for smoothness, exact
    if (this.bar) this.bar.style.width = rounded + '%';
    if (this.pct) this.pct.textContent = (rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)) + '%';
    if (statusText && this.status) this.status.textContent = statusText;
  },
  add(bytes, statusText) {
    this.set(this.loaded + bytes, statusText);
  },
  finish() {
    this.set(TOTAL_BYTES, 'Listo');
    if (this.el) {
      this.el.classList.add('done');
      setTimeout(() => { if (this.el && this.el.parentNode) this.el.remove(); }, 400);
    }
  }
};

/** Fetch a URL and report exact byte progress via onProgress(loaded, total). Returns ArrayBuffer. */
function fetchWithProgress(url, knownSize, onProgress) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    const total = Number(res.headers.get('Content-Length')) || knownSize || 0;
    if (!res.body || !res.body.getReader) {
      return res.arrayBuffer().then(buf => {
        onProgress(buf.byteLength, buf.byteLength);
        return buf;
      });
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) {
          const buf = new Uint8Array(received);
          let offset = 0;
          for (const c of chunks) { buf.set(c, offset); offset += c.length; }
          return buf.buffer;
        }
        chunks.push(value);
        received += value.length;
        onProgress(received, total || received);
        return pump();
      });
    }
    return pump();
  });
}

async function main() {
  loadingUI.init();
  loadingUI.set(0, 'Cargando física…');

  let Module;
  try {
    // Let RocketSimModule load the WASM itself. The deploy workflow renames
    // rocketsim.wasm → rocketsim.<BUILD_ID>.wasm and patches dist/rocketsim.js.
    // Hard-coding the original name causes HTTP 404 on GitHub Pages.
    Module = await RocketSimModule();
    loadingUI.set(841316, 'Física lista');
  } catch (err) {
    document.getElementById('stats').textContent = 'Error cargando el módulo WASM: ' + err;
    console.error(err);
    if (loadingUI.status) loadingUI.status.textContent = 'Error: ' + err.message;
    return;
  }

  Module.init();
  Module.createArena();
  const carId = Module.addCar(0);
  Module.setCarState(carId, 0, -2560, 100, 0, 0, 0);

  // Preload remaining assets with exact byte progress (browser cache serves them later).
  // WASM size already counted; deploy leaves assets/ paths unchanged.
  {
    let base = 841316;
    for (const asset of LOADING_ASSETS) {
      if (asset.url.endsWith('.wasm')) continue;
      try {
        await fetchWithProgress(asset.url, asset.size, (loaded) => {
          loadingUI.set(base + loaded, 'Cargando ' + asset.name + '…');
        });
        base += asset.size;
        loadingUI.set(base, asset.name + ' listo');
      } catch (e) {
        console.warn('Preload falló para', asset.url, e);
        base += asset.size;
        loadingUI.set(base, asset.name + ' (omitido)');
      }
    }
    loadingUI.set(TOTAL_BYTES, 'Preparando escena…');
  }

  const hb = Module.getOctaneHitboxSize(); // {x: largo, y: ancho, z: alto}, en UU

  const canvas = document.getElementById('c');
  // MEMORY: no antialias, pixelRatio=1, no PBR tone mapping, minimal lights
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'low-power',
    alpha: false,
    stencil: false,
    depth: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1); // fixed 1: biggest GPU memory saver on mobile
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);

  // Hemisphere + soft directional so MeshStandardMaterial (Fennec body/wheels) is not pitch-black
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
  dirLight.position.set(8, 18, 6);
  scene.add(dirLight);

  // Mapa de entorno procedural (cielo + paneles de luz) para que la pintura tenga reflejos.
  const carEnvMap = (() => {
    const envScene = new THREE.Scene();
    // Cielo con colores por vértice (MeshBasicMaterial pasa por la codificación correcta del PMREM;
    // un ShaderMaterial propio no, y daba valores enormes -> el auto salía blanco/saturado).
    const skyGeo = new THREE.SphereGeometry(50, 32, 16);
    const skyCols = [];
    const topC = new THREE.Color(1.0, 0.45, 0.72), horC = new THREE.Color(0.75, 0.28, 0.45), botC = new THREE.Color(0.10, 0.03, 0.05);
    const tmpC = new THREE.Color();
    const sp = skyGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const h = sp.getY(i) / 50;
      if (h > 0) tmpC.copy(horC).lerp(topC, Math.pow(h, 0.6));
      else tmpC.copy(horC).lerp(botC, Math.pow(-h, 0.5));
      skyCols.push(tmpC.r, tmpC.g, tmpC.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyCols, 3));
    const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
    envScene.add(sky);
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xff8fc4, side: THREE.DoubleSide });
    [[0, 30, 0, -Math.PI / 2, 0], [30, 12, 10, 0, -Math.PI / 2], [-30, 12, -10, 0, Math.PI / 2], [0, 14, -32, 0, 0]].forEach(([x, y, z, rx, ry]) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(26, 8), panelMat);
      p.position.set(x, y, z); p.rotation.set(rx, ry, 0);
      envScene.add(p);
    });
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0.02);
    pmrem.dispose();
    return rt.texture;
  })();

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
  // El FOV de Rocket League es horizontal (Hor+): se fija a 16:9 y en pantallas más anchas se ve más a los lados.
  function applyCameraFov() {
    camera.aspect = window.innerWidth / window.innerHeight;
    const effAspect = Math.min(camera.aspect, 16 / 9);
    camera.fov = 2 * Math.atan(Math.tan(CAM_CFG.fov * DEG / 2) / effAspect) / DEG;
    camera.updateProjectionMatrix();
  }
  applyCameraFov();

  // ---------- texturas ----------
  const MAX_ANISO = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  function loadTex(url, { srgb = true, repeat = null, onLoad = null } = {}) {
    const t = new THREE.TextureLoader().load(url, onLoad || undefined);
    if (srgb) t.encoding = THREE.sRGBEncoding;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    t.anisotropy = MAX_ANISO;
    return t;
  }
  // Promedio de brillo de una textura (0-1, en valores crudos) para usarla solo como "detalle" sobre un color base.
  function texAverage(tex, cb) {
    const img = tex.image; if (!img) return;
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
    cb(Math.max(sum / 64, 0.02));
  }
  // Mapeo triplanar (sin UV): sirve para el estadio (sin UVs) y para piezas del auto. Multiplica el
  // color base por el detalle de la textura (normalizado por su promedio, acotado para no explotar).
  //   space 'world': escala en repeticiones por metro · space 'object': repeticiones por unidad local.
  function triplanar(mat, tex, { scale = 0.25, amount = 0.8, space = 'world' } = {}) {
    const U = { uTpTex: { value: tex }, uTpScale: { value: scale }, uTpAmount: { value: amount }, uTpAvg: { value: 0.5 } };
    const setAvg = () => texAverage(tex, v => { U.uTpAvg.value = v; });
    if (tex.image) setAvg(); else { const prev = tex.onUpdate; tex.onUpdate = function () { setAvg(); tex.onUpdate = prev; }; }
    mat.customProgramCacheKey = () => 'tp_' + space;
    mat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec3 vTpP; varying vec3 vTpN;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (space === 'world'
          ? 'vTpP = (modelMatrix * vec4(position, 1.0)).xyz; vTpN = normalize(mat3(modelMatrix) * normal);'
          : 'vTpP = position; vTpN = normalize(normal);'));
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform sampler2D uTpTex; uniform float uTpScale; uniform float uTpAmount; uniform float uTpAvg;\nvarying vec3 vTpP; varying vec3 vTpN;\nvoid main() {')
        .replace('#include <map_fragment>', '#include <map_fragment>\n' +
          'vec3 tpW = pow(abs(vTpN), vec3(4.0)); tpW /= (tpW.x + tpW.y + tpW.z + 1e-5);\n' +
          'vec3 tpC = texture2D(uTpTex, vTpP.zy * uTpScale).rgb * tpW.x + texture2D(uTpTex, vTpP.xz * uTpScale).rgb * tpW.y + texture2D(uTpTex, vTpP.xy * uTpScale).rgb * tpW.z;\n' +
          'float tpL = dot(tpC, vec3(0.3, 0.59, 0.11)) / uTpAvg;\n' +
          'diffuseColor.rgb *= mix(1.0, clamp(tpL, 0.5, 1.8), uTpAmount);');
    };
    return mat;
  }
  // Cielo (equirectangular) como fondo; también da reflejos neutros a los metales.
  let skyEnvTex = null;
  loadTex('assets/sky.webp', { onLoad: t => {
    t.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = t;
    try {
      const pm = new THREE.PMREMGenerator(renderer);
      skyEnvTex = pm.fromEquirectangular(t).texture; pm.dispose();
      metalMats.forEach(m => { m.envMap = skyEnvTex; m.needsUpdate = true; });
    } catch (_) {}
  } });
  const metalMats = [];

  // ---------- cancha (medidas reales del mapa estándar competitivo de Rocket League) ----------
  // Todo esto es SOLO visual -- la física sigue usando los planos simples de RLConst que ya
  // tenía (ver patch en Arena.cpp); esto no cambia ninguna colisión, solo cómo se ve la cancha.
  const FIELD_HALF_X = 4096, FIELD_HALF_Y = 5120, CEILING_Z = 2048;
  // Longitud del plano de la esquina (1629.174uu a 45°) -> el recorte a lo largo de cada eje
  // es esa longitud * cos(45°).
  const CORNER_CUT = 1629.174 * Math.SQRT1_2; // ≈ 1152uu

  function fieldPoint(x, y) {
    // (x,y) en espacio RocketSim (X=ancho, Y=largo) -> three.js (X, 0, -Y), a escala UU_TO_M.
    return new THREE.Vector2(x * UU_TO_M, -y * UU_TO_M);
  }
  // Rectángulo con las 4 esquinas recortadas a 45°, en el orden en que three.js espera un Shape.
  const fieldShapePts = [
    fieldPoint(FIELD_HALF_X - CORNER_CUT, FIELD_HALF_Y),
    fieldPoint(-(FIELD_HALF_X - CORNER_CUT), FIELD_HALF_Y),
    fieldPoint(-FIELD_HALF_X, FIELD_HALF_Y - CORNER_CUT),
    fieldPoint(-FIELD_HALF_X, -(FIELD_HALF_Y - CORNER_CUT)),
    fieldPoint(-(FIELD_HALF_X - CORNER_CUT), -FIELD_HALF_Y),
    fieldPoint(FIELD_HALF_X - CORNER_CUT, -FIELD_HALF_Y),
    fieldPoint(FIELD_HALF_X, -(FIELD_HALF_Y - CORNER_CUT)),
    fieldPoint(FIELD_HALF_X, FIELD_HALF_Y - CORNER_CUT),
  ];
  const fieldShape = new THREE.Shape(fieldShapePts);
  // Pasto real (color + normal + rugosidad); los UV de la forma son metros, 1 tile = 5 m.
  const grassRep = [0.2, 0.2];
  const floor = new THREE.Mesh(
    new THREE.ShapeGeometry(fieldShape),
    new THREE.MeshStandardMaterial({
      map: loadTex('assets/grass_d.webp', { repeat: grassRep }),
      normalMap: loadTex('assets/grass_n.webp', { srgb: false, repeat: grassRep }),
      roughnessMap: loadTex('assets/grass_r.webp', { srgb: false, repeat: grassRep }),
      color: 0xd8e8c8, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  // Franjas de corte (claras/oscuras) a lo largo de la cancha: capa negra semitransparente.
  const mowCanvas = document.createElement('canvas'); mowCanvas.width = 2; mowCanvas.height = 2;
  { const g = mowCanvas.getContext('2d'); g.clearRect(0, 0, 2, 2); g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, 1, 2, 1); }
  const mowTex = new THREE.CanvasTexture(mowCanvas);
  mowTex.wrapS = mowTex.wrapT = THREE.RepeatWrapping; mowTex.magFilter = THREE.NearestFilter; mowTex.minFilter = THREE.NearestFilter;
  mowTex.repeat.set(1, 1 / 20);                      // 1 par de franjas cada 20 m (10 m cada una)
  const mow = new THREE.Mesh(new THREE.ShapeGeometry(fieldShape), new THREE.MeshBasicMaterial({
    map: mowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  mow.rotation.x = -Math.PI / 2; mow.position.y = 0.004;
  scene.add(mow);
  // Suelo de tierra alrededor (se ve por fuera del estadio y hacia el horizonte).
  const dirtRep = 600 / 10;
  const dirt = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({
    map: loadTex('assets/ground_d.webp', { repeat: [dirtRep, dirtRep] }), color: 0xbfae98, roughness: 1, metalness: 0,
  }));
  dirt.rotation.x = -Math.PI / 2; dirt.position.y = -0.12;
  scene.add(dirt);

  // Líneas de la cancha (borde + línea central), dibujadas encima del piso.
  const fieldOutline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      fieldShapePts.map(p => new THREE.Vector3(p.x, 0.01, p.y))
    ),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  scene.add(fieldOutline);
  const centerLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-FIELD_HALF_X * UU_TO_M, 0.01, 0),
      new THREE.Vector3(FIELD_HALF_X * UU_TO_M, 0.01, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  scene.add(centerLine);

  // Paredes laterales y traseras (solo el segmento recto; sin las curvas de esquina/rampa,
  // que aquí no importan porque no son parte de la colisión real usada).
  const wallMat = new THREE.MeshBasicMaterial({
    color: 0x6fa8ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
    alphaMap: loadTex('assets/glass_streaks.webp', { srgb: false }),
  });
  const H = CEILING_Z * UU_TO_M;
  // Lados largos (paredes en X = ±4096): tramo recto entre las esquinas.
  const sideWallGeo = new THREE.PlaneGeometry((2 * (FIELD_HALF_Y - CORNER_CUT)) * UU_TO_M, H);
  const wallXPos = new THREE.Mesh(sideWallGeo, wallMat);
  wallXPos.position.set(FIELD_HALF_X * UU_TO_M, H / 2, 0);
  wallXPos.rotation.y = Math.PI / 2;
  scene.add(wallXPos);
  const wallXNeg = wallXPos.clone();
  wallXNeg.position.x = -FIELD_HALF_X * UU_TO_M;
  scene.add(wallXNeg);

  // Paredes de fondo (Y = ±5120) con el hueco real del arco (892.755 de semiancho x 642.775 de alto).
  const GW = 892.755, GH = 642.775, BW = FIELD_HALF_X - CORNER_CUT;
  const backShape = new THREE.Shape([
    [-BW, 0], [-GW, 0], [-GW, GH], [GW, GH], [GW, 0], [BW, 0], [BW, CEILING_Z], [-BW, CEILING_Z],
  ].map(([x, y]) => new THREE.Vector2(x * UU_TO_M, y * UU_TO_M)));
  const backWallGeo = new THREE.ShapeGeometry(backShape);
  const wallYPos = new THREE.Mesh(backWallGeo, wallMat);
  wallYPos.position.set(0, 0, -FIELD_HALF_Y * UU_TO_M);
  scene.add(wallYPos);
  const wallYNeg = wallYPos.clone();
  wallYNeg.position.z = FIELD_HALF_Y * UU_TO_M;
  scene.add(wallYNeg);

  // Las 4 esquinas: planos a 45° (los de la colisión), del extremo de una pared al de la otra.
  const cornerLen = Math.hypot(CORNER_CUT, CORNER_CUT) * UU_TO_M;
  [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sy]) => {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(cornerLen, H), wallMat);
    const mx = sx * (FIELD_HALF_X - CORNER_CUT / 2), my = sy * (FIELD_HALF_Y - CORNER_CUT / 2);
    g.position.set(mx * UU_TO_M, H / 2, -my * UU_TO_M);
    g.rotation.y = (sx * sy > 0) ? -Math.PI / 4 : Math.PI / 4;
    scene.add(g);
  });

  // ---------- Hexágonos en el vidrio (para ver dónde está la pared) ----------
  const HEX_S = 1.6;                                   // lado del hexágono en metros (~138 uu de ancho)
  const hexCanvas = document.createElement('canvas'); hexCanvas.width = hexCanvas.height = 256;
  {
    const g = hexCanvas.getContext('2d');
    g.scale(256 / 3, 256 / Math.sqrt(3));              // 1 tile = 3 x sqrt(3) lados -> hexágonos regulares al repetir
    g.lineWidth = 0.085; g.lineJoin = 'round'; g.strokeStyle = 'rgba(190,230,255,1)';
    const hexAt = (cx, cy) => {
      g.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const px = cx + Math.cos(a), py = cy + Math.sin(a); k ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.closePath(); g.stroke();
    };
    [[0, 0], [3, 0], [0, Math.sqrt(3)], [3, Math.sqrt(3)], [1.5, Math.sqrt(3) / 2]].forEach(([x, y]) => hexAt(x, y));
  }
  const hexBase = new THREE.CanvasTexture(hexCanvas);
  hexBase.wrapS = hexBase.wrapT = THREE.RepeatWrapping; hexBase.anisotropy = MAX_ANISO;
  function hexMesh(geo, uvInMeters, wM, hM) {
    const t = hexBase.clone(); t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = MAX_ANISO;
    if (uvInMeters) t.repeat.set(1 / (3 * HEX_S), 1 / (Math.sqrt(3) * HEX_S));
    else t.repeat.set(wM / (3 * HEX_S), hM / (Math.sqrt(3) * HEX_S));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: t, color: 0x9fd8ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
  }
  {
    const lateralLen = 2 * (FIELD_HALF_Y - CORNER_CUT) * UU_TO_M;
    [1, -1].forEach(sx => {
      const m = hexMesh(sideWallGeo, false, lateralLen, H);
      m.position.set(sx * (FIELD_HALF_X * UU_TO_M - 0.03), H / 2, 0); m.rotation.y = Math.PI / 2; scene.add(m);
    });
    [1, -1].forEach(sz => {
      const m = hexMesh(backWallGeo, true);
      m.position.set(0, 0, sz * (FIELD_HALF_Y * UU_TO_M - 0.03)); scene.add(m);
    });
    [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sy]) => {
      const m = hexMesh(new THREE.PlaneGeometry(cornerLen, H), false, cornerLen, H);
      const mx = sx * (FIELD_HALF_X - CORNER_CUT / 2), my = sy * (FIELD_HALF_Y - CORNER_CUT / 2);
      m.position.set(mx * UU_TO_M, H / 2, -my * UU_TO_M);
      m.rotation.y = (sx * sy > 0) ? -Math.PI / 4 : Math.PI / 4; scene.add(m);
    });
    const ceil = hexMesh(new THREE.ShapeGeometry(fieldShape), true);   // techo (también es colisión)
    ceil.rotation.x = Math.PI / 2; ceil.position.y = H - 0.03; scene.add(ceil);
  }

  // Arcos: marco metálico (postes + travesaño + fondo) con las medidas reales, y red con transparencia.
  const GOAL_HALF_WIDTH = 892.755, GOAL_HEIGHT = 642.775, GOAL_DEPTH = 880;
  const metalDTex = loadTex('assets/metal_d.webp', { repeat: [1, 4] });
  const metalRTex = loadTex('assets/metal_r.webp', { srgb: false, repeat: [1, 4] });
  const metalMTex = loadTex('assets/metal_m.webp', { srgb: false, repeat: [1, 4] });
  function goalMetal(hex) {
    const m = new THREE.MeshStandardMaterial({ map: metalDTex, roughnessMap: metalRTex, metalnessMap: metalMTex, color: hex, roughness: 1, metalness: 1, envMap: skyEnvTex, envMapIntensity: 1.1 });
    metalMats.push(m); return m;
  }
  function netMat(wM, hM) {
    const t = loadTex('assets/net_a.webp', { srgb: false, repeat: [wM / 5, hM / 5] });   // 1 tile = 5 m (el navegador cachea la imagen)
    return new THREE.MeshBasicMaterial({ color: 0xf2f2f2, alphaMap: t, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 });
  }
  const _up = new THREE.Vector3(0, 1, 0), _bd = new THREE.Vector3();
  function bar(group, p1, p2, mat, r) {
    _bd.subVectors(p2, p1);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, _bd.length(), 8), mat);
    m.position.copy(p1).addScaledVector(_bd, 0.5);
    m.quaternion.setFromUnitVectors(_up, _bd.clone().normalize());
    group.add(m);
  }
  function buildGoal(goalY) {
    const sign = Math.sign(goalY) || 1;
    const gy = -goalY * UU_TO_M;               // línea de gol (three.z)
    const w = GOAL_HALF_WIDTH * UU_TO_M, h = GOAL_HEIGHT * UU_TO_M, d = GOAL_DEPTH * UU_TO_M * sign;
    const g = new THREE.Group();
    const mat = goalMetal(goalY < 0 ? 0xa8c8ff : 0xffc890);   // azul (defiende -Y) / naranja (+Y)
    const V = (x, y, z) => new THREE.Vector3(x, y, z), R = 0.3;
    [-w, w].forEach(x => {
      bar(g, V(x, 0, gy), V(x, h, gy), mat, R);                 // postes frontales
      bar(g, V(x, 0, gy + d), V(x, h, gy + d), mat, R * 0.8);   // postes traseros
      bar(g, V(x, h, gy), V(x, h, gy + d), mat, R * 0.8);       // laterales superiores
      bar(g, V(x, 0, gy), V(x, 0, gy + d), mat, R * 0.8);       // base
    });
    bar(g, V(-w, h, gy), V(w, h, gy), mat, R);                  // travesaño
    bar(g, V(-w, h, gy + d), V(w, h, gy + d), mat, R * 0.8);    // travesaño trasero
    // Red: fondo, techo y laterales
    const back = new THREE.Mesh(new THREE.PlaneGeometry(2 * w, h), netMat(2 * w, h));
    back.position.set(0, h / 2, gy + d); g.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(2 * w, Math.abs(d)), netMat(2 * w, Math.abs(d)));
    top.rotation.x = Math.PI / 2; top.position.set(0, h, gy + d / 2); g.add(top);
    [-w, w].forEach(x => {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(d), h), netMat(Math.abs(d), h));
      side.rotation.y = Math.PI / 2; side.position.set(x, h / 2, gy + d / 2); g.add(side);
    });
    scene.add(g);
  }
  buildGoal(FIELD_HALF_Y);
  buildGoal(-FIELD_HALF_Y);

  // ---------- Estadio (Champions Field) ----------
  // El modelo se escala por eje para que SU cancha coincida con la colisión actual:
  //   largo del modelo (X) -> 5120uu (línea de fondo), ancho (Z) -> 4096uu (pared lateral),
  //   alto -> 2048uu (techo). Su piso queda en z=0. La cancha propia del modelo (rampas/vidrio) se
  //   quitó: las paredes de vidrio de arriba son las de la colisión real. ?stadium=0 lo desactiva.
  const stadiumTex = { plastic: loadTex('assets/plastic_d.webp', { repeat: [1, 1] }), concrete: loadTex('assets/concrete_d.webp', { repeat: [1, 1] }), metal: loadTex('assets/metal_d.webp', { repeat: [1, 1] }) };
  Object.values(stadiumTex).forEach(t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; });
  const STADIUM = { halfLong: 1.2745, halfWide: 0.8425, floorY: 0.0155, glassTop: 0.4650 };
  if (new URLSearchParams(location.search).get('stadium') !== '0') (async () => {
    try {
      const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load('assets/champions.glb', res, undefined, rej));
      const kx = FIELD_HALF_Y / STADIUM.halfLong;                       // uu por unidad del modelo (largo)
      const kz = FIELD_HALF_X / STADIUM.halfWide;                       // (ancho)
      const ky = CEILING_Z / (STADIUM.glassTop - STADIUM.floorY);       // (alto)
      const model = gltf.scene;
      model.scale.set(kx * UU_TO_M, ky * UU_TO_M, kz * UU_TO_M);
      model.position.y = -STADIUM.floorY * ky * UU_TO_M;
      model.traverse(o => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        const m = o.material;
        m.metalness = 0; m.roughness = 0.9; m.side = THREE.DoubleSide;
        const c = m.color, near = (r, g2, b) => Math.abs(c.r - r) < 0.03 && Math.abs(c.g - g2) < 0.03 && Math.abs(c.b - b) < 0.03;
        if (near(0.02, 0.08, 0.40) || near(0.85, 0.28, 0.02)) triplanar(m, stadiumTex.plastic, { scale: 0.45, amount: 0.7 });       // asientos
        else if (near(0.36, 0.40, 0.46) || near(0.62, 0.62, 0.64)) triplanar(m, stadiumTex.concrete, { scale: 0.12, amount: 0.9 }); // concreto
        else if (near(0.09, 0.11, 0.14) || near(0.05, 0.06, 0.13)) { triplanar(m, stadiumTex.metal, { scale: 0.3, amount: 0.8 }); m.roughness = 0.55; }   // metal oscuro
      });
      const holder = new THREE.Group();
      holder.rotation.y = Math.PI / 2;      // largo del modelo (X) -> eje Z de three (= Y de RocketSim)
      holder.add(model);
      scene.add(holder);
      camera.far = 3000; camera.updateProjectionMatrix();
    } catch (err) { console.warn('No se pudo cargar el estadio:', err); }
  })();

  // Boost pads: grandes (dorado, 100%) y chicos (blanco, 12%) con las coordenadas dadas.
  // Los 34 chicos no vinieron todos con coordenadas exactas; se dibujan los de la línea
  // central (Y=0) que sí se dieron -- el resto de carriles quedaría por agregar si hace falta.
  // Shared materials + low-segment cylinders (memory)
  const padMatBig = new THREE.MeshBasicMaterial({ color: 0xffcc33 });
  const padMatSmall = new THREE.MeshBasicMaterial({ color: 0xdddddd });
  function addPad(x, y, big) {
    const r = (big ? 65 : 35) * UU_TO_M;
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.05, 8),
      big ? padMatBig : padMatSmall
    );
    pad.position.set(x * UU_TO_M, 0.03, -y * UU_TO_M);
    scene.add(pad);
  }
  const bigPadCoords = [
    [3072, 4096], [3072, -4096], [-3072, 4096], [-3072, -4096],
    [3584, 0], [-3584, 0],
  ];
  bigPadCoords.forEach(([x, y]) => addPad(x, y, true));
  const smallPadCoordsCenterLine = [
    [256, 0], [-256, 0], [1024, 0], [-1024, 0], [1792, 0], [-1792, 0],
  ];
  smallPadCoordsCenterLine.forEach(([x, y]) => addPad(x, y, false));

  const ballState0 = Module.getBallState();
  // Low-poly ball (MeshBasic = no lighting uniforms)
  const ball = new THREE.Group();
  const ballPlaceholder = new THREE.Mesh(
    new THREE.SphereGeometry(ballState0.radius * UU_TO_M, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xe8a020 })
  );
  ball.add(ballPlaceholder);
  scene.add(ball);
  // Modelo real de la pelota + atlas de textura (se reemplaza el placeholder al terminar de cargar).
  (async () => {
    try {
      const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load('assets/ball.glb', res, undefined, rej));
      const atlas = loadTex('assets/ball_d.webp');
      atlas.flipY = false;                                  // glTF usa UV con origen arriba
      atlas.wrapS = atlas.wrapT = THREE.RepeatWrapping;     // los UV del modelo están en [0..1]x[1..2]
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model), sz = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
      const k = (ballState0.radius * UU_TO_M * 2) / Math.max(sz.x, sz.y, sz.z);
      model.position.sub(ctr);                              // centrar en el origen
      const wrap = new THREE.Group(); wrap.add(model); wrap.scale.setScalar(k);
      model.traverse(o => {
        if (!o.isMesh) return;
        o.material = new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide });
      });
      ball.remove(ballPlaceholder);
      ball.add(wrap);
    } catch (err) { console.warn('No se pudo cargar la pelota:', err); }
  })();

  // Fennec visual. Local axes: X = forward, Y = right, Z = up.
  const rubberTex = loadTex('assets/rubber_d.webp'), carbonTex = loadTex('assets/carbon_d.webp');
  rubberTex.wrapS = rubberTex.wrapT = carbonTex.wrapS = carbonTex.wrapT = THREE.RepeatWrapping;
  const carMesh = new THREE.Group();
  scene.add(carMesh);
  const wheelRig = [];
  let wheelSpin = 0;
  (async () => {
    const L = hb.x * UU_TO_M, W = hb.y * UU_TO_M, H = hb.z * UU_TO_M;
    const textureLoader = new THREE.TextureLoader();
    const bodyMap = textureLoader.load('assets/Chassis_Grain_D.webp');
    const bodyNormal = textureLoader.load('assets/Chassis_Grain_N.webp');
    const wheelMap = textureLoader.load('assets/Alpha_D.webp');
    const wheelNormal = textureLoader.load('assets/Alpha_N.webp');
    bodyMap.encoding = THREE.sRGBEncoding;
    wheelMap.encoding = THREE.sRGBEncoding;
    bodyMap.flipY = bodyNormal.flipY = wheelMap.flipY = wheelNormal.flipY = false;

    // Evita que la luz "queme" el color a blanco: si un canal se pasa de 1, se reescala
    // conservando el tono (naranja sigue siendo naranja) y se empuja un poco hacia el rosado.
    const USE_PEARL = new URLSearchParams(location.search).get('pearl') === '1';   // acabado perlado opcional
    const keepHue = (mat, pink, pearl = false) => {
      mat.customProgramCacheKey = () => 'keephue' + pink + (pearl ? 'P' : '');
      mat.onBeforeCompile = shader => {
        // Anodized Pearl: el tono cambia con el ángulo de vista (naranja de frente -> dorado -> rosa/magenta de canto).
        const pearlCode = pearl ?
          // Anodized Pearl naranja (referencia): superficies que miran hacia ARRIBA (capó, techo) -> magenta;
          // costados -> cobre/naranja; de canto el rosa avanza un poco por los bordes. Se recolorea por brillo
          // para conservar el sombreado y los reflejos.
          'vec3 pN = normalize(normal); float pNV = clamp(dot(pN, normalize(vViewPosition)), 0.0, 1.0); float pFr = pow(1.0 - pNV, 2.5); ' +
          'vec3 pUpV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz); float pUp = smoothstep(0.30, 0.92, dot(pN, pUpV)); ' +
          'float pm = clamp(pUp * 0.95 + pFr * 0.45, 0.0, 1.0); ' +
          'vec3 pearlC = mix(vec3(1.0, 0.50, 0.17), vec3(1.0, 0.16, 0.82), pm); ' +
          'float pL = dot(oc, vec3(0.30, 0.59, 0.11)); ' +
          'oc = mix(oc, pearlC * clamp(pL * 1.55 + 0.03, 0.0, 0.92), 0.92); ' : '';
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          'vec3 oc = outgoingLight; float mx = max(oc.r, max(oc.g, oc.b)); if (mx > 0.95) oc *= 0.95 / mx; ' +
          'oc = mix(oc, oc * vec3(1.0, 0.72, 0.85), ' + pink.toFixed(2) + '); ' + pearlCode +
          'mx = max(oc.r, max(oc.g, oc.b)); if (mx > 0.98) oc *= 0.98 / mx; ' +
          'gl_FragColor = vec4( oc, diffuseColor.a );'
        );
      };
      return mat;
    };
    const gltf = await new Promise((resolve, reject) => {
      new THREE.GLTFLoader().load('assets/fennec.glb', resolve, undefined, reject);
    }).catch(err => { console.error('Fennec no cargó:', err); return null; });
    const source = gltf ? gltf.scene : new THREE.Group();
    const body = gltf ? source.getObjectByName('Fennec') : null;
    const wheelOrder = ['FR', 'FL', 'BR', 'BL'];
    const wheels = wheelOrder.map(code => {
      let match = null;
      source.traverse(child => {
        if (!match && child.name.startsWith('Alpha') && child.name.includes(code)) match = child;
      });
      return match;
    });

    if (body) {
      source.traverse(child => {
        if (!child.isMesh) return;
        const name = Array.isArray(child.material)
          ? child.material.map(material => material.name).join(' ')
          : child.material?.name || '';
        if (/Window/i.test(name)) {
          child.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
        } else if (/Headlight/i.test(name)) {
          child.material = new THREE.MeshStandardMaterial({ color: 0xf4fbff, emissive: 0x9ff0ff, emissiveIntensity: 1.6, roughness: 0.1, envMap: carEnvMap });
        } else if (/Alpha/i.test(name)) {
          // Aro: oscuro con borde naranja metálico (como el Fennec rojo)
          child.material = keepHue(new THREE.MeshStandardMaterial({ map: wheelMap, normalMap: wheelNormal, color: 0x050506, roughness: 0.4, metalness: 0.4, envMap: carEnvMap, envMapIntensity: 0.2 }), 0.0);
        } else if (/Dieci/i.test(name)) {
          child.geometry.computeBoundingBox();
          const bs = child.geometry.boundingBox.getSize(new THREE.Vector3());
          child.material = triplanar(new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.9, metalness: 0.0 }), rubberTex, { scale: 5 / Math.max(bs.x, bs.y, bs.z, 1e-3), amount: 0.9, space: 'object' });
        } else if (/Body/i.test(name)) {
          // Anodized Pearl: base naranja, reflejos y brillo perlado rosado
          child.material = keepHue(new THREE.MeshPhysicalMaterial({ normalMap: bodyNormal, normalScale: new THREE.Vector2(0.5, 0.5), color: 0xff4a00, emissive: 0x2a0a00, roughness: 0.3, metalness: 0.15, clearcoat: 1.0, clearcoatRoughness: 0.08, envMap: carEnvMap, envMapIntensity: 0.22 }), 0.0, USE_PEARL);
        } else {
          // Chasis / molduras: plástico negro semi-mate con detalle
          child.geometry.computeBoundingBox();
          const cs = child.geometry.boundingBox.getSize(new THREE.Vector3());
          child.material = triplanar(new THREE.MeshStandardMaterial({ normalMap: bodyNormal, color: 0x1a1a1d, roughness: 0.32, metalness: 0.3, envMap: carEnvMap, envMapIntensity: 0.18 }), carbonTex, { scale: 14 / Math.max(cs.x, cs.y, cs.z, 1e-3), amount: 1.0, space: 'object' });
        }
      });
      const box = new THREE.Box3().setFromObject(source);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = (L * 0.98) / size.x;
      source.scale.setScalar(scale);
      source.rotation.x = Math.PI / 2;
      source.position.set(-center.x * scale, center.z * scale, -box.min.y * scale - H * 0.48);
      carMesh.add(source);

      wheels.forEach((wheel, index) => {
        if (!wheel) return;
        wheelRig.push({
          wheel,
          baseY: wheel.position.y,
          baseQuaternion: wheel.quaternion.clone(),
          front: index < 2,
          right: index === 0 || index === 2,
          modelScale: scale,
        });
      });
    }
  })();

  // ---------- Boost "Alpha" (Gold Rush): estela de muchas imágenes 2D doradas ----------
  // El .upk que se subió es solo el ícono, así que la estela se arma por código: cientos de
  // sprites (billboards) muy densos que nacen en el escape, se quedan en el aire (por eso al girar/
  // hacer acrobacias forman un anillo de fuego) y van creciendo y apagándose a lo largo de la estela.
  const boostFx = new THREE.Group();            // ancla del escape (se mueve con el auto)
  boostFx.position.set(-hb.x * 0.5 * UU_TO_M, -hb.z * 0.1 * UU_TO_M, 0);
  carMesh.add(boostFx);
  const boostLight = new THREE.PointLight(0xffb020, 0, 14, 1.6);
  carMesh.add(boostLight);
  let boostLevel = 0;

  const trailTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0.00, 'rgba(255,255,255,1)');
    gr.addColorStop(0.30, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.65, 'rgba(255,255,255,0.28)');
    gr.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const TRAIL_N = 150, TRAIL_LIFE = 0.5, TRAIL_RATE = 260;   // partículas, segundos de vida, por segundo
  const SIZE0 = 22 * UU_TO_M, SIZE1 = 105 * UU_TO_M;           // crecen de ~22uu a ~135uu
  const cYoung = new THREE.Color(0xffe27a), cMid = new THREE.Color(0xffae00), cOld = new THREE.Color(0xff5a00);
  const trail = [];
  for (let i = 0; i < TRAIL_N; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: trailTex, blending: THREE.NormalBlending, depthWrite: false, transparent: true, opacity: 0,
    }));
    sp.visible = false; scene.add(sp);
    trail.push({ sp, age: TRAIL_LIFE, vx: 0, vy: 0, vz: 0, rot: 0 });
  }
  let trailIdx = 0, spawnAcc = 0, side = 1, havePrev = false;
  const _prevP = new THREE.Vector3(), _curP = new THREE.Vector3(), _bwd = new THREE.Vector3(), _side = new THREE.Vector3();
  const _tmpC = new THREE.Color();
  function updateBoostFx(active, dt) {
    boostLevel += ((active ? 1 : 0) - boostLevel) * Math.min(dt * 14, 1);
    boostLight.intensity = boostLevel * 3;
    boostFx.updateWorldMatrix(true, false);
    boostFx.getWorldPosition(_curP);
    if (active) {
      // dirección "hacia atrás" y lateral del auto, en el mundo
      _bwd.set(-1, 0, 0).transformDirection(carMesh.matrixWorld);
      _side.set(0, 0, 1).transformDirection(carMesh.matrixWorld);
      if (!havePrev) _prevP.copy(_curP);
      spawnAcc += TRAIL_RATE * dt;
      const n = Math.min(Math.floor(spawnAcc), 10);
      spawnAcc -= Math.floor(spawnAcc);
      for (let k = 0; k < n; k++) {
        const p = trail[trailIdx++ % TRAIL_N];
        const f = (k + 0.5) / n;                                  // reparte las partículas entre el cuadro anterior y este
        side = -side;
        p.sp.position.lerpVectors(_prevP, _curP, f).addScaledVector(_side, side * hb.y * 0.16 * UU_TO_M);
        p.sp.position.x += (Math.random() - 0.5) * 0.12; p.sp.position.y += (Math.random() - 0.5) * 0.12;
        p.sp.position.z += (Math.random() - 0.5) * 0.12;
        const sp = 2 + Math.random() * 3;                         // salen hacia atrás con algo de dispersión
        p.vx = _bwd.x * sp + (Math.random() - 0.5) * 1.5;
        p.vy = _bwd.y * sp + (Math.random() - 0.3) * 1.5;
        p.vz = _bwd.z * sp + (Math.random() - 0.5) * 1.5;
        p.rot = Math.random() * 6.28;
        p.age = f * dt; p.sp.visible = true;
      }
    } else spawnAcc = 0;
    havePrev = active;
    _prevP.copy(_curP);
    for (const p of trail) {
      if (p.age >= TRAIL_LIFE) continue;
      p.age += dt;
      if (p.age >= TRAIL_LIFE) { p.sp.visible = false; continue; }
      const t = p.age / TRAIL_LIFE;                               // 0 = recién nacida, 1 = se apaga
      p.sp.position.x += p.vx * dt; p.sp.position.y += p.vy * dt; p.sp.position.z += p.vz * dt;
      p.vx *= 1 - dt * 3; p.vy *= 1 - dt * 3; p.vz *= 1 - dt * 3;
      p.sp.scale.setScalar(SIZE0 + (SIZE1 - SIZE0) * Math.pow(t, 0.6));
      if (t < 0.4) _tmpC.copy(cYoung).lerp(cMid, t / 0.4); else _tmpC.copy(cMid).lerp(cOld, (t - 0.4) / 0.6);
      p.sp.material.color.copy(_tmpC);
      p.sp.material.rotation = p.rot + t * 1.5;
      p.sp.material.opacity = 0.5 * Math.min(t * 12, 1) * Math.pow(1 - t, 0.9);
    }
  }

  // ---------- Sombras (auto y pelota) + marcador circular de la pelota ----------
  const blobTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 9; g.shadowColor = 'rgba(160,220,255,0.9)'; g.shadowBlur = 10;
    g.beginPath(); g.arc(128, 128, 112, 0, Math.PI * 2); g.stroke();
    const t = new THREE.CanvasTexture(c); t.anisotropy = MAX_ANISO; return t;
  })();
  const groundMat = (map, extra = {}) => new THREE.MeshBasicMaterial(Object.assign({
    map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }, extra));
  const flat = new THREE.PlaneGeometry(1, 1); flat.rotateX(-Math.PI / 2);
  const ballShadow = new THREE.Mesh(flat, groundMat(blobTex)); ballShadow.renderOrder = 2; scene.add(ballShadow);
  const ballRing = new THREE.Mesh(flat, groundMat(ringTex, { color: 0xffffff })); ballRing.renderOrder = 3; scene.add(ballRing);
  const carShadowG = new THREE.Group(); scene.add(carShadowG);
  const carShadow = new THREE.Mesh(flat, groundMat(blobTex)); carShadow.renderOrder = 2; carShadowG.add(carShadow);
  const _fwdV = new THREE.Vector3();
  const BALL_R_M = ballState0.radius * UU_TO_M;
  function updateShadows() {
    // --- pelota: la sombra se agranda y se aclara con la altura; el aro se achica al acercarse al suelo
    const hb_m = Math.max(ball.position.y - BALL_R_M, 0);                 // altura sobre el piso (m)
    const hUU = hb_m / UU_TO_M;
    ballShadow.position.set(ball.position.x, 0.02, ball.position.z);
    const sh = BALL_R_M * 2 * (1.25 + Math.min(hUU, 1800) / 1800 * 1.1);
    ballShadow.scale.set(sh, 1, sh);
    ballShadow.material.opacity = 0.75 * (1 - Math.min(hUU, 1800) / 1800 * 0.65);
    ballRing.position.set(ball.position.x, 0.03, ball.position.z);
    const rr = BALL_R_M * 2 * (1.05 + Math.min(hUU, 1800) / 1800 * 3.4);  // diámetro del aro
    ballRing.scale.set(rr, 1, rr);
    ballRing.material.opacity = Math.min(1, hUU / 90) * 0.9;              // desaparece cuando la pelota toca el piso
    // --- auto: elipse orientada con el rumbo, más suave y grande cuanto más alto
    const hc = Math.max(carMesh.position.y, 0);
    const k = Math.min(hc / 15, 1);                                       // 0..1 hasta ~15 m de altura
    _fwdV.set(1, 0, 0).applyQuaternion(carMesh.quaternion);
    carShadowG.rotation.y = Math.atan2(-_fwdV.z, _fwdV.x);
    carShadowG.position.set(carMesh.position.x, 0.02, carMesh.position.z);
    const cL = hb.x * UU_TO_M * (1.3 + k * 0.6), cW = hb.y * UU_TO_M * (1.35 + k * 0.6);
    carShadow.scale.set(cL, 1, cW);
    carShadow.material.opacity = 0.7 * (1 - k * 0.8);
  }

  // ---------- Hit sparks (car↔ball / car↔wall) — bright Additive + bloom-like flash like RL ----------
  const BALL_RADIUS_UU = ballState0.radius || 91.25;
  const CAR_HIT_RADIUS_UU = Math.max(hb.x, hb.y) * 0.55; // approx outer radius of hitbox
  const SPARK_POOL = 8;
  const sparkTex = new THREE.TextureLoader().load('assets/spark.webp');
  sparkTex.encoding = THREE.sRGBEncoding;
  const sparkMat = new THREE.SpriteMaterial({
    map: sparkTex,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i++) {
    const s = new THREE.Sprite(sparkMat.clone());
    s.visible = false;
    s.scale.set(0.01, 0.01, 1);
    scene.add(s);
    sparks.push({
      sprite: s,
      life: 0,
      maxLife: 0.42,
      baseScale: 5.0,
      rotSpeed: 0,
    });
  }
  // Estallido de fuego en golpes fuertes: cuadros recortados de la hoja de sprites (fila amarilla/naranja).
  const FX_COLS = 26, FX_W = 578, FX_H = 292, FX_CELL = FX_W / FX_COLS, FX_Y0 = 47, FX_HH = 28, FX_FRAMES = 17;
  const bursts = [];
  for (let i = 0; i < 4; i++) {
    const t = new THREE.TextureLoader().load('assets/fx_sheet.png'); t.encoding = THREE.sRGBEncoding;
    t.repeat.set(FX_CELL / FX_W, FX_HH / FX_H);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 }));
    sp.visible = false; scene.add(sp);
    bursts.push({ sp, t, life: 0, max: 0.5, size: 4 });
  }
  let burstIdx = 0;
  function spawnBurst(x, y, z, intensity) {
    const b = bursts[burstIdx++ % bursts.length];
    rsToThreeInto(x, y, z, bp3);
    b.sp.position.set(bp3.x, bp3.y, bp3.z);
    b.size = 1.8 + intensity * 2.0; b.life = b.max; b.sp.visible = true;
  }
  function updateBursts(dt) {
    for (const b of bursts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.sp.visible = false; continue; }
      const f = Math.min(FX_FRAMES - 1, Math.floor((1 - b.life / b.max) * FX_FRAMES));
      b.t.offset.set(f * FX_CELL / FX_W, 1 - (FX_Y0 + FX_HH) / FX_H);
      b.sp.scale.set(b.size * (FX_CELL / FX_HH), b.size, 1);
      b.sp.material.opacity = 0.85 * Math.min(1, b.life / b.max * 2.2);
    }
  }
  if (new URLSearchParams(location.search).get('dbgsparks')) setInterval(() => spawnSpark(0, 0, 150, 1), 1200);
  // Strong flash light for heavy bloom-like overexposure
  const sparkLight = new THREE.PointLight(0xffeebb, 0, 28, 1.4);
  scene.add(sparkLight);
  let sparkLightLife = 0;

  // Hit detection state (UU space)
  let prevBallVel = { x: 0, y: 0, z: 0 };
  let prevCarVel = { x: 0, y: 0, z: 0 };
  let hitCooldown = 0; // seconds

  function spawnSpark(x, y, z, intensity = 1) {
    // Find free or oldest spark
    let best = sparks[0];
    for (const sp of sparks) {
      if (sp.life <= 0) { best = sp; break; }
      if (sp.life < best.life) best = sp;
    }
    const sp = best;
    rsToThreeInto(x, y, z, bp3); // reuse bp3 temp
    sp.sprite.position.set(bp3.x, bp3.y, bp3.z);
    sp.life = sp.maxLife;
    // Doubled size + extra intensity for strong bloom
    sp.baseScale = 0.9 + intensity * 1.5;
    sp.rotSpeed = (Math.random() - 0.5) * 12;
    sp.sprite.material.opacity = 1;
    sp.sprite.material.color.setHex(intensity > 0.7 ? 0xffffff : 0xfff0c0);
    sp.sprite.visible = true;
    sp.sprite.scale.set(sp.baseScale * 0.5, sp.baseScale * 0.5, 1);
    // Very strong flash light for heavy bloom overbright
    sparkLight.position.copy(sp.sprite.position);
    sparkLight.intensity = 1.2 + intensity * 3;
    sparkLight.distance = 14;
    sparkLightLife = 0.32;
  }

  function updateSparks(dt) {
    hitCooldown = Math.max(0, hitCooldown - dt);
    updateBursts(dt);
    sparkLightLife = Math.max(0, sparkLightLife - dt);
    if (sparkLightLife <= 0) sparkLight.intensity = 0;
    else sparkLight.intensity *= Math.max(0, 1 - dt * 6);

    for (const sp of sparks) {
      if (sp.life <= 0) {
        if (sp.sprite.visible) sp.sprite.visible = false;
        continue;
      }
      sp.life -= dt;
      const t = 1 - Math.max(sp.life, 0) / sp.maxLife; // 0→1
      // Longer bright hold then fade (stronger bloom feel)
      const fade = t < 0.18 ? 1 : Math.pow(1 - (t - 0.18) / 0.82, 1.4);
      sp.sprite.material.opacity = fade;
      const sc = sp.baseScale * (0.55 + t * 1.2);
      sp.sprite.scale.set(sc, sc, 1);
      sp.sprite.material.rotation += sp.rotSpeed * dt;
      if (sp.life <= 0) sp.sprite.visible = false;
    }
  }

  // ---------- Contención: tapa los huecos de la colisión del .wasm ----------
  // El módulo deja la zona del arco (x entre ~-800 y 800) como un hueco de TODA la altura en la pared de fondo
  // y no hay piso detrás: un auto podía salir del mapa y caer al vacío. El .wasm no se puede modificar, así que
  // aquí se aplica el volumen legal real de la cancha: octágono + techo + piso + caja del arco
  // (892.755 de semiancho, 642.775 de alto, 880 de fondo). Si el auto lo viola, se devuelve y rebota.
  const GOAL_HW = 892.755, GOAL_H = 642.775, GOAL_BACK = 6000;
  function containCar() {
    const cp = currState.carPos;
    const risk = Math.abs(cp.y) > 4300 || cp.z > 1700 || cp.z < 120 || Math.abs(cp.x) > 3700;
    if (!risk) return;
    const cs = Module.getCarState(carId);
    let x = cs.pos.x, y = cs.pos.y, z = cs.pos.z, vx = cs.vel.x, vy = cs.vel.y, vz = cs.vel.z, ch = false;
    const ay = Math.abs(y), sy = y < 0 ? -1 : 1, E = 0.35;
    const mouth = Math.abs(x) < GOAL_HW - 30 && z < GOAL_H - 25;
    if (ay > 5200) {                                     // dentro de la caja del arco
      const lim = GOAL_HW - 30;
      if (Math.abs(x) > lim) { x = Math.sign(x) * lim; if (vx * Math.sign(x) > 0) vx = -vx * E; ch = true; }
      if (z > GOAL_H - 25) { z = GOAL_H - 25; if (vz > 0) vz = -vz * E; ch = true; }
      if (ay > GOAL_BACK - 70) { y = sy * (GOAL_BACK - 70); if (vy * sy > 0) vy = -vy * E; ch = true; }
    } else if (ay > 5105 && !mouth) {                    // cruzó la línea de gol por donde no hay arco
      y = sy * 5105; if (vy * sy > 0) vy = -vy * E; ch = true;
    }
    if (Math.abs(x) > 4150 && ay <= 5105) { x = Math.sign(x) * 4150; if (vx * Math.sign(x) > 0) vx = -vx * E; ch = true; }
    if (z < 12) { z = 12; if (vz < 0) vz = 0; ch = true; }          // piso
    if (z > 2040) { z = 2040; if (vz > 0) vz = -vz * E; ch = true; } // techo
    if (ch) Module.setCarState(carId, x, y, z, vx, vy, vz);
  }

  // Gol y pelota fuera: no hay forma de fijar la pelota en el .wasm (solo resetBall), así que si cruza la línea
  // dentro del arco es gol, y si se escapa por un hueco se reinicia el saque.
  let goalTimer = 0;
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:14%;left:50%;transform:translateX(-50%);z-index:40;padding:10px 26px;border-radius:8px;' +
    'font:700 28px sans-serif;letter-spacing:3px;color:#fff;background:rgba(0,0,0,0.45);text-shadow:0 0 12px #6cf;display:none;pointer-events:none';
  document.body.appendChild(toast);
  let toastT = 0;
  function showToast(msg, secs) { toast.textContent = msg; toast.style.display = 'block'; toastT = secs; }
  function kickoff() {
    Module.resetBall();
    Module.setCarState(carId, 0, -2560, 100, 0, 0, 0);
  }
  function checkBall(dt) {
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) toast.style.display = 'none'; }
    if (goalTimer > 0) { goalTimer -= dt; if (goalTimer <= 0) kickoff(); return; }
    const b = currState.ballPos, r = 91.25, ay = Math.abs(b.y);
    const inMouth = Math.abs(b.x) < GOAL_HW && b.z < GOAL_H;
    // En el .wasm una rampa tapa la entrada del arco a ras de piso (la pelota se frena en |y|≈5100),
    // así que el gol se cuenta al llegar a la línea dentro de la boca del arco.
    if (ay > 5035 && inMouth) { showToast('¡GOL!', 1.6); goalTimer = 1.6; }
    else if (ay > 5120 + r) { showToast('Pelota fuera: nuevo saque', 1.2); kickoff();
    } else if (Math.abs(b.x) > 4400 || b.z > 2400 || b.z < -150) {
      showToast('Pelota fuera: nuevo saque', 1.2); kickoff();
    }
  }

  function checkHits() {
    const bx = currState.ballPos.x, by = currState.ballPos.y, bz = currState.ballPos.z;
    const cx = currState.carPos.x, cy = currState.carPos.y, cz = currState.carPos.z;
    const dx = bx - cx, dy = by - cy, dz = bz - cz;
    const dist = Math.hypot(dx, dy, dz);
    const contactDist = BALL_RADIUS_UU + CAR_HIT_RADIUS_UU;

    // --- car ↔ ball ---
    // Relative velocity + sudden change while close = impact (thresholds relaxed for reliable sparks)
    const rvx = currState.ballVel.x - currState.carVel.x;
    const rvy = currState.ballVel.y - currState.carVel.y;
    const rvz = currState.ballVel.z - currState.carVel.z;
    const relSpeed = Math.hypot(rvx, rvy, rvz);
    const prevRvx = prevBallVel.x - prevCarVel.x;
    const prevRvy = prevBallVel.y - prevCarVel.y;
    const prevRvz = prevBallVel.z - prevCarVel.z;
    const prevRel = Math.hypot(prevRvx, prevRvy, prevRvz);
    const velDelta = Math.abs(relSpeed - prevRel);
    const carSpeed = Math.hypot(currState.carVel.x, currState.carVel.y, currState.carVel.z);
    const ballSpeed = Math.hypot(currState.ballVel.x, currState.ballVel.y, currState.ballVel.z);

    // Golpe real = la pelota cambia de velocidad de golpe mientras está tocando el auto.
    // (Antes bastaba con ir rápido cerca de la pelota, y salían chispas sin tocarla.)
    const dBall = Math.hypot(currState.ballVel.x - prevBallVel.x, currState.ballVel.y - prevBallVel.y, currState.ballVel.z - prevBallVel.z);
    const touching = dist < contactDist + 45;
    if (hitCooldown <= 0 && touching && dBall > 260) {
      const t = Math.min(1, BALL_RADIUS_UU / (dist || 1));
      const hx = bx - dx * t * 0.6, hy = by - dy * t * 0.6, hz = bz - dz * t * 0.6;
      const intensity = Math.min(1, 0.12 + dBall / 3200);   // toque suave ≈ 0.2 · tiro fuerte ≈ 1
      spawnSpark(hx, hy, hz, intensity);
      hitCooldown = 0.3;
    }

    // --- car ↔ wall (side / back) ---
    const wallMargin = 90;
    const speedInto = Math.hypot(currState.carVel.x, currState.carVel.y);
    if (speedInto > 900) {
      let wallHit = false;
      let wx = cx, wy = cy, wz = cz;
      if (Math.abs(cx) > FIELD_HALF_X - wallMargin) {
        wallHit = true;
        wx = Math.sign(cx) * (FIELD_HALF_X - 20);
      } else if (Math.abs(cy) > FIELD_HALF_Y - wallMargin) {
        wallHit = true;
        wy = Math.sign(cy) * (FIELD_HALF_Y - 20);
      }
      // Detect impact by velocity component reversing or high speed near wall
      if (wallHit) {
        const intoX = Math.abs(cx) > FIELD_HALF_X - wallMargin && Math.sign(currState.carVel.x) === Math.sign(cx);
        const intoY = Math.abs(cy) > FIELD_HALF_Y - wallMargin && Math.sign(currState.carVel.y) === Math.sign(cy);
        const prevInto = (Math.abs(prevCarVel.x) > 400 && Math.sign(prevCarVel.x) === Math.sign(cx)) ||
                         (Math.abs(prevCarVel.y) > 400 && Math.sign(prevCarVel.y) === Math.sign(cy));
        if ((intoX || intoY) || (prevInto && speedInto > 1200)) {
          const intensity = Math.min(0.7, speedInto / 4000);
          spawnSpark(wx, wy, wz + 40, intensity);
          hitCooldown = 0.4;
        }
      }
    }

    prevBallVel.x = currState.ballVel.x; prevBallVel.y = currState.ballVel.y; prevBallVel.z = currState.ballVel.z;
    prevCarVel.x = currState.carVel.x; prevCarVel.y = currState.carVel.y; prevCarVel.z = currState.carVel.z;
  }

  window.addEventListener('resize', () => {
    applyCameraFov();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- controles (teclado + mobile UI) ----------
  const keys = new Set();
  // Modo boost infinito: ?infboost=0/1 en la URL, tecla B, o el botón del HUD. Se recuerda entre visitas.
  let infBoost = (() => {
    const q = new URLSearchParams(location.search).get('infboost');
    if (q !== null) return q !== '0';
    try { return localStorage.getItem('infboost') !== '0'; } catch (_) { return true; }
  })();
  const infBtn = document.createElement('button');
  infBtn.id = 'infBoostBtn';
  infBtn.style.cssText = 'margin-left:6px';
  const refreshInfBtn = () => { infBtn.textContent = 'Boost ∞: ' + (infBoost ? 'ON' : 'OFF'); };
  const toggleInfBoost = () => {
    infBoost = !infBoost; refreshInfBoost();
  };
  function refreshInfBoost() {
    refreshInfBtn();
    try { localStorage.setItem('infboost', infBoost ? '1' : '0'); } catch (_) {}
  }
  refreshInfBtn();
  infBtn.addEventListener('click', toggleInfBoost);
  const copyBtnEl = document.getElementById('copyLogBtn');
  if (copyBtnEl) copyBtnEl.insertAdjacentElement('afterend', infBtn);

  window.addEventListener('keydown', e => {
    keys.add(e.code);
    if (e.code === 'KeyB') toggleInfBoost();
    if (e.code === 'KeyR') Module.resetBall();
    if (e.code === 'KeyC') cam.ballCam = !cam.ballCam;
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  // Objeto de controles reutilizado (no se crea uno nuevo cada frame).
  const ctl = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };

  // ---- Mobile touch state (shared with keyboard; mobile overrides when active) ----
  const mobile = {
    // joystick: -1..1
    joyX: 0,   // steer
    joyY: 0,   // throttle (up = accel)
    // discrete buttons
    accel: false,
    decel: false,
    jump: false,
    boost: false,
    handbrake: false,
    airRollL: false,
    airRollR: false,
    // tracking
    joyActive: false,
    joyPointerId: null,
  };

  // Detect / force mobile UI
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
    window.matchMedia('(pointer: coarse)').matches;
  if (isTouchDevice) document.body.classList.add('show-mobile-ui');

  // ---- Virtual joystick ----
  const joyZone = document.getElementById('joystick-zone');
  const joyBase = document.getElementById('joystick-base');
  const joyKnob = document.getElementById('joystick-knob');
  const JOY_RADIUS = 55; // px max travel of knob center

  function setKnob(dx, dy) {
    const len = Math.hypot(dx, dy);
    let nx = dx, ny = dy;
    if (len > JOY_RADIUS) {
      nx = (dx / len) * JOY_RADIUS;
      ny = (dy / len) * JOY_RADIUS;
    }
    joyKnob.style.transform = `translate(${nx}px, ${ny}px)`;
    // Normalize to -1..1
    mobile.joyX = nx / JOY_RADIUS;
    mobile.joyY = -ny / JOY_RADIUS; // up = positive throttle
  }

  function resetKnob() {
    joyKnob.style.transform = 'translate(0px, 0px)';
    joyKnob.classList.remove('active');
    mobile.joyX = 0;
    mobile.joyY = 0;
    mobile.joyActive = false;
    mobile.joyPointerId = null;
  }

  function joyStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const t = e.changedTouches ? e.changedTouches[0] : e;
    mobile.joyPointerId = t.identifier !== undefined ? t.identifier : 'mouse';
    mobile.joyActive = true;
    joyKnob.classList.add('active');
    const rect = joyBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    setKnob(t.clientX - cx, t.clientY - cy);
  }

  function joyMove(e) {
    if (!mobile.joyActive) return;
    e.preventDefault();
    const touches = e.changedTouches || [e];
    for (const t of touches) {
      const id = t.identifier !== undefined ? t.identifier : 'mouse';
      if (id !== mobile.joyPointerId) continue;
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setKnob(t.clientX - cx, t.clientY - cy);
    }
  }

  function joyEnd(e) {
    if (!mobile.joyActive) return;
    const touches = e.changedTouches || [e];
    for (const t of touches) {
      const id = t.identifier !== undefined ? t.identifier : 'mouse';
      if (id === mobile.joyPointerId) {
        resetKnob();
        break;
      }
    }
  }

  if (joyZone) {
    joyZone.addEventListener('touchstart', joyStart, { passive: false });
    joyZone.addEventListener('touchmove', joyMove, { passive: false });
    joyZone.addEventListener('touchend', joyEnd, { passive: false });
    joyZone.addEventListener('touchcancel', joyEnd, { passive: false });
    // mouse support for desktop testing
    joyZone.addEventListener('mousedown', joyStart);
    window.addEventListener('mousemove', joyMove);
    window.addEventListener('mouseup', joyEnd);
  }

  // ---- Action & throttle buttons (pointer events so multi-touch works) ----
  function bindButton(el, onDown, onUp) {
    if (!el) return;
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('pressed');
      onDown();
    };
    const up = (e) => {
      e.preventDefault();
      el.classList.remove('pressed');
      onUp();
    };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
  }

  bindButton(document.getElementById('btn-jump'),
    () => { mobile.jump = true; },
    () => { mobile.jump = false; });
  bindButton(document.getElementById('btn-boost'),
    () => { mobile.boost = true; },
    () => { mobile.boost = false; });
  bindButton(document.getElementById('btn-powerslide'),
    () => { mobile.handbrake = true; },
    () => { mobile.handbrake = false; });
  bindButton(document.getElementById('btn-airroll-l'),
    () => { mobile.airRollL = true; },
    () => { mobile.airRollL = false; });
  bindButton(document.getElementById('btn-airroll-r'),
    () => { mobile.airRollR = true; },
    () => { mobile.airRollR = false; });
  bindButton(document.getElementById('btn-accel'),
    () => { mobile.accel = true; },
    () => { mobile.accel = false; });
  bindButton(document.getElementById('btn-decel'),
    () => { mobile.decel = true; },
    () => { mobile.decel = false; });

  // Prevent the canvas from stealing touches that should go to controls
  const canvasEl = document.getElementById('c');
  if (canvasEl) {
    canvasEl.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  }

  function readControls() {
    // Keyboard base
    let throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    let steer = -((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0));
    let roll = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    let jump = keys.has('Space');
    let boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
    let handbrake = keys.has('ControlLeft') || keys.has('ControlRight');

    // Mobile overrides / additions (combine with keyboard so both work)
    if (mobile.joyActive) {
      // Deadzone
      const dead = 0.12;
      const jx = Math.abs(mobile.joyX) < dead ? 0 : mobile.joyX;
      const jy = Math.abs(mobile.joyY) < dead ? 0 : mobile.joyY;
      steer = -jx;          // same sign convention as keyboard
      throttle = jy;
    }
    // Discrete accel/decel can reinforce or replace stick Y
    if (mobile.accel) throttle = Math.max(throttle, 1);
    if (mobile.decel) throttle = Math.min(throttle, -1);

    if (mobile.airRollL) roll = Math.min(roll, -1);
    if (mobile.airRollR) roll = Math.max(roll, 1);

    jump = jump || mobile.jump;
    boost = boost || mobile.boost;
    handbrake = handbrake || mobile.handbrake;

    let pitch = -throttle;
    let yaw = steer;

    // Mando (PS4 / gamepad estándar)
    const gp = pollGamepad();
    if (gp.connected) {
      if (gp.throttle !== 0) throttle = gp.throttle;
      if (gp.steer !== 0) { steer = gp.steer; yaw = gp.yaw; }
      if (gp.pitch !== 0) pitch = gp.pitch;
      if (gp.roll !== 0) roll = gp.roll;
      jump = jump || gp.jump;
      boost = boost || gp.boost;
      handbrake = handbrake || gp.handbrake;
      if (gp.resetPressed) Module.resetBall();
      if (gp.camPressed) cam.ballCam = !cam.ballCam;
    }

    ctl.throttle = throttle;
    ctl.steer = steer;
    ctl.roll = roll;
    ctl.pitch = pitch;
    ctl.yaw = yaw;
    ctl.jump = jump;
    ctl.boost = boost;
    ctl.handbrake = handbrake;
  }

  // ---------- estado físico (dos "casillas" fijas prev/curr) ----------
  // FIX GC: 1 snapshot/frame.
  // Prefer get*StatePtr + HEAPF32 (zero-alloc). If HEAPF32 missing or Ptr fails → legacy.
  function makeStateSlot() {
    return {
      ballPos: { x: 0, y: 0, z: 0 }, ballVel: { x: 0, y: 0, z: 0 },
      ballAngVel: { x: 0, y: 0, z: 0 }, ballRot: new Float32Array(9),
      carPos: { x: 0, y: 0, z: 0 }, carVel: { x: 0, y: 0, z: 0 }, carRot: new Float32Array(9),
      boost: 0, isOnGround: false, isSupersonic: false,
    };
  }
  function readVectorInto(embindVec, out) {
    for (let i = 0; i < 9; i++) out[i] = embindVec.get(i);
    embindVec.delete();
  }

  // Detect Ptr API + usable heap view.
  // Recent Emscripten keeps HEAPF32 private unless EXPORTED_RUNTIME_METHODS includes it.
  function getHeapF32() {
    if (Module.HEAPF32) return Module.HEAPF32;
    if (Module.HEAP8) return new Float32Array(Module.HEAP8.buffer);
    if (Module.HEAPU8) return new Float32Array(Module.HEAPU8.buffer);
    if (Module.wasmMemory) return new Float32Array(Module.wasmMemory.buffer);
    // Last resort: dig into wasm exports
    try {
      const mem = Module.asm?.memory || Module.wasmExports?.memory
        || Module.instance?.exports?.memory;
      if (mem && mem.buffer) return new Float32Array(mem.buffer);
    } catch (_) {}
    return null;
  }
  let _heapF32 = getHeapF32();
  // Re-resolve once more after a tick in case memory views are filled late
  if (!_heapF32 && typeof Module.getBallStatePtr === 'function') {
    try { Module.getBallStatePtr(); _heapF32 = getHeapF32(); } catch (_) {}
  }
  const hasPtr = typeof Module.getBallStatePtr === 'function'
              && typeof Module.getCarStatePtr === 'function'
              && _heapF32 != null;
  console.log('[RocketSim] HEAPF32 available:', !!_heapF32, 'hasPtr:', hasPtr);

  let _ballView = null, _carView = null, _heapBuf = null, _ballPtr = 0, _carPtr = 0;
  function viewAt(ptr, isBall) {
    // Refresh heap view if memory grew (ALLOW_MEMORY_GROWTH)
    // Layout (same as get*State): pos[0..2] vel[3..5] angVel[6..8] rot[9..17]
    // ball: +radius[18]  → need 19 floats
    // car:  +boost[18] isOnGround[19] ... isSupersonic[25] → need 26 floats
    const h = _heapF32 || getHeapF32();
    if (!h) throw new Error('no HEAPF32');
    const buf = h.buffer;
    if (buf !== _heapBuf) {
      _heapBuf = buf; _heapF32 = new Float32Array(buf);
      _ballView = null; _carView = null; _ballPtr = 0; _carPtr = 0;
    }
    if (isBall) {
      if (!_ballView || _ballPtr !== ptr) { _ballView = new Float32Array(buf, ptr, 19); _ballPtr = ptr; }
      return _ballView;
    }
    if (!_carView || _carPtr !== ptr) { _carView = new Float32Array(buf, ptr, 26); _carPtr = ptr; }
    return _carView;
  }

  function snapshotIntoLegacy(slot) {
    const bs = Module.getBallState();
    const cs = Module.getCarState(carId);
    slot.ballPos.x = bs.pos.x; slot.ballPos.y = bs.pos.y; slot.ballPos.z = bs.pos.z;
    if (bs.vel) {
      slot.ballVel.x = bs.vel.x; slot.ballVel.y = bs.vel.y; slot.ballVel.z = bs.vel.z;
    } else {
      slot.ballVel.x = slot.ballVel.y = slot.ballVel.z = 0;
    }
    if (bs.angVel) {
      slot.ballAngVel.x = bs.angVel.x; slot.ballAngVel.y = bs.angVel.y; slot.ballAngVel.z = bs.angVel.z;
    } else {
      slot.ballAngVel.x = slot.ballAngVel.y = slot.ballAngVel.z = 0;
    }
    readVectorInto(bs.rot, slot.ballRot);
    slot.carPos.x = cs.pos.x; slot.carPos.y = cs.pos.y; slot.carPos.z = cs.pos.z;
    slot.carVel.x = cs.vel.x; slot.carVel.y = cs.vel.y; slot.carVel.z = cs.vel.z;
    readVectorInto(cs.rot, slot.carRot);
    slot.boost = cs.boost;
    slot.isOnGround = cs.isOnGround;
    slot.isSupersonic = cs.isSupersonic;
  }

  function snapshotInto(slot) {
    if (hasPtr) {
      try {
        const bp = Module.getBallStatePtr();
        const cp = Module.getCarStatePtr(carId);
        if (bp && cp) {
          const b = viewAt(bp, true), c = viewAt(cp, false);
          // Layout: 0 pos, 3 vel, 6 angVel, 9 rot (9 floats), 18 extras
          slot.ballPos.x = b[0]; slot.ballPos.y = b[1]; slot.ballPos.z = b[2];
          slot.ballVel.x = b[3]; slot.ballVel.y = b[4]; slot.ballVel.z = b[5];
          slot.ballAngVel.x = b[6]; slot.ballAngVel.y = b[7]; slot.ballAngVel.z = b[8];
          for (let i = 0; i < 9; i++) slot.ballRot[i] = b[9 + i];
          slot.carPos.x = c[0]; slot.carPos.y = c[1]; slot.carPos.z = c[2];
          slot.carVel.x = c[3]; slot.carVel.y = c[4]; slot.carVel.z = c[5];
          for (let i = 0; i < 9; i++) slot.carRot[i] = c[9 + i];
          slot.boost = c[18];
          slot.isOnGround = c[19] !== 0;
          slot.isSupersonic = c[25] !== 0;
          return;
        }
      } catch (e) {
        console.warn('get*StatePtr failed, falling back to legacy:', e);
      }
    }
    snapshotIntoLegacy(slot);
  }

  const slotA = makeStateSlot();
  const slotB = makeStateSlot();
  snapshotInto(slotA);
  snapshotInto(slotB);
  let prevState = slotA, currState = slotB, useA = true;
  console.log('[RocketSim] state API:', hasPtr ? 'get*StatePtr (zero-alloc)' : 'legacy get*State');

  // Ball visual orientation: RocketSim disables sphere orientation updates by default
  // (expensive). We integrate angVel ourselves so the ball spins exactly like RL.
  const ballVisQuat = new THREE.Quaternion();
  const _ballOmega = new THREE.Vector3();
  const _ballDq = new THREE.Quaternion();
  const carQuatPrev = new THREE.Quaternion();
  const carQuatCurr = new THREE.Quaternion();
  const ballPosUU = { x: 0, y: 0, z: 0 };
  const carPosUU = { x: 0, y: 0, z: 0 };
  const bp3 = { x: 0, y: 0, z: 0 };
  const cp3 = { x: 0, y: 0, z: 0 };
  const carFwdBuf = [0, 0, 0];
  const carVelBuf = [0, 0, 0];
  const ballPosBuf = [0, 0, 0];
  const carPosBuf = [0, 0, 0];

  function lerpInto(a, b, t, out) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
  }

  // ---------- diagnóstico continuo, sin asignar memoria por frame ----------
  // Buffer circular de números planos (Float64Array): frame, tiempo, dt, step, ticks, acc.
  // El texto (que sí implica crear strings) solo se arma UNA vez, al tocar "Copiar".
  const LOG_CAPACITY = 600; // ~30s a 60fps
  const FIELDS = 14; // frame, t, dt, step, ticks, acc, speed, rawX,Y,Z, renderX,Y,Z, flipped
  const logBuf = new Float64Array(LOG_CAPACITY * FIELDS);
  let logCount = 0;
  const startTime = performance.now();

  const copyBtn = document.getElementById('copyLogBtn');
  copyBtn.addEventListener('click', () => {
    const n = Math.min(logCount, LOG_CAPACITY);
    const startIdx = logCount > LOG_CAPACITY ? logCount % LOG_CAPACITY : 0;
    const lines = new Array(n + 1);
    lines[0] = 'frame\ttiempo(s)\tdt(ms)\tstep(ms)\tticks\tacc_restante(ms)\tspeed(uu/s)\t' +
      'rawX\trawY\trawZ\trenderX\trenderY\trenderZ\tflip';
    for (let i = 0; i < n; i++) {
      const idx = ((startIdx + i) % LOG_CAPACITY) * FIELDS;
      lines[i + 1] =
        `${logBuf[idx]}\t${logBuf[idx + 1].toFixed(2)}\t${logBuf[idx + 2].toFixed(1)}\t` +
        `${logBuf[idx + 3].toFixed(2)}\t${logBuf[idx + 4]}\t${logBuf[idx + 5].toFixed(1)}\t` +
        `${logBuf[idx + 6].toFixed(1)}\t${logBuf[idx + 7].toFixed(2)}\t${logBuf[idx + 8].toFixed(2)}\t${logBuf[idx + 9].toFixed(2)}\t` +
        `${logBuf[idx + 10].toFixed(2)}\t${logBuf[idx + 11].toFixed(2)}\t${logBuf[idx + 12].toFixed(2)}\t${logBuf[idx + 13]}`;
    }
    const text = lines.join('\n');
    const done = () => { copyBtn.textContent = `Copiado (${n} líneas) ✓`; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    done();
  }

  let acc = 0;
  let last = performance.now();
  const statsEl = document.getElementById('stats');
  let hudCounter = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 0.25);
    acc += dt;

    readControls();
    Module.setCarControls(
      carId, ctl.throttle, ctl.steer, ctl.pitch, ctl.yaw, ctl.roll, ctl.jump, ctl.boost, ctl.handbrake
    );

    const dtMs = dt * 1000;
    const stepStart = performance.now();
    let ticks = 0;
    // FIX GC: solo hacemos Module.step() dentro del while. snapshotInto() se llama
    // UNA sola vez por frame (después del while). Antes se llamaba getBallState +
    // getCarState en CADA tick (2-4 veces/frame) → embind creaba objetos JS nuevos
    // constantemente → presión de GC → spikes de dt ~32ms. Con 1 snapshot/frame la
    // basura baja ~3-4x y los tirones casi desaparecen.
    // Trade-off: cuando hay catch-up de varios ticks, prevState queda a más de 1 tick
    // de distancia de currState. La interpolación con alpha (fracción de UN tick) no
    // es perfecta en esos frames raros, pero es mucho mejor que tener GC spikes
    // visibles. La mayoría de frames siguen teniendo ticks=1 o 2 y se ven fluidos.
    while (acc >= TICK_TIME && ticks < 8) {
      Module.step(1);
      containCar();
      acc -= TICK_TIME;
      ticks++;
    }
    if (ticks > 0) {
      const nextSlot = useA ? slotA : slotB;
      snapshotInto(nextSlot);
      prevState = currState;
      currState = nextSlot;
      useA = !useA;
    }
    checkBall(dt);
    // Boost infinito: el motor no deja fijar el boost, así que cuando se le acaba aplicamos
    // nosotros el mismo empuje (991.667 uu/s² hacia adelante, tope 2300 uu/s) vía setCarState.
    if (infBoost && ticks > 0 && ctl.boost && currState.boost < 1) {
      const dtB = ticks * TICK_TIME, v = currState.carVel, r = currState.carRot;
      let nvx = v.x + r[0] * 991.667 * dtB, nvy = v.y + r[1] * 991.667 * dtB, nvz = v.z + r[2] * 991.667 * dtB;
      const sp = Math.hypot(nvx, nvy, nvz);
      if (sp > 2300) { const k = 2300 / sp; nvx *= k; nvy *= k; nvz *= k; }
      Module.setCarState(carId, currState.carPos.x, currState.carPos.y, currState.carPos.z, nvx, nvy, nvz);
      v.x = nvx; v.y = nvy; v.z = nvz;
    }
    const stepMs = performance.now() - stepStart;
    const alpha = Math.min(Math.max(acc / TICK_TIME, 0), 1);

    // Posición/rotación RENDERIZADAS = interpolación entre el último tick y el anterior.
    lerpInto(prevState.ballPos, currState.ballPos, alpha, ballPosUU);
    lerpInto(prevState.carPos, currState.carPos, alpha, carPosUU);
    rsRotToThreeQuat(prevState.carRot, carQuatPrev);
    rsRotToThreeQuat(currState.carRot, carQuatCurr);
    // Un quaternion `q` y su opuesto `-q` representan exactamente la misma rotación, pero
    // setFromRotationMatrix puede "elegir" signos distintos para dos matrices casi iguales
    // (es una ambigüedad matemática conocida, pasa cerca de ciertos ángulos). Si eso ocurre
    // entre prevQuat y currQuat, el slerp interpola por el camino LARGO en vez del corto,
    // y se ve como un tirón/spin brusco en la orientación -- independiente del dispositivo o
    // del timing de frames, por eso aparecía igual en PC y celular. Forzamos que currQuat
    // quede siempre en el mismo "hemisferio" que prevQuat antes de mezclar.
    let flipped = 0;
    if (carQuatPrev.dot(carQuatCurr) < 0) {
      carQuatCurr.set(-carQuatCurr.x, -carQuatCurr.y, -carQuatCurr.z, -carQuatCurr.w);
      flipped |= 2;
    }

    // Integrar angVel de la pelota → orientación visual (RocketSim no actualiza rot de esfera).
    // angVel en espacio RocketSim (Z-arriba, rad/s). Convertimos a Three.js y aplicamos
    // dq = 0.5 * dt * omega_world * q  →  q += dq  (luego normalizar).
    if (ticks > 0) {
      const av = currState.ballAngVel;
      // RocketSim (x,y,z) → Three (x, z, -y)
      _ballOmega.set(av.x, av.z, -av.y);
      const halfDt = 0.5 * ticks * TICK_TIME;
      // omega_quat * q  (producto a izquierda, omega en mundo)
      _ballDq.set(
        _ballOmega.x * halfDt,
        _ballOmega.y * halfDt,
        _ballOmega.z * halfDt,
        0
      );
      _ballDq.multiply(ballVisQuat); // (0.5 dt omega) * q
      ballVisQuat.x += _ballDq.x;
      ballVisQuat.y += _ballDq.y;
      ballVisQuat.z += _ballDq.z;
      ballVisQuat.w += _ballDq.w;
      ballVisQuat.normalize();
    }

    // Log: solo escribe números en un Float64Array ya reservado, cero asignación. Va AQUÍ
    // (no antes) porque necesita carPosUU, que recién se calculó arriba -- comparar "raw"
    // (posición cruda del último tick de física) contra "render" (la ya interpolada, lo que
    // realmente se dibuja) es lo que permite distinguir un glitch de física real de uno que
    // solo vive en la interpolación/render.
    {
      const idx = (logCount % LOG_CAPACITY) * FIELDS;
      const speed = Math.hypot(currState.carVel.x, currState.carVel.y, currState.carVel.z);
      logBuf[idx] = logCount + 1;
      logBuf[idx + 1] = (now - startTime) / 1000;
      logBuf[idx + 2] = dtMs;
      logBuf[idx + 3] = stepMs;
      logBuf[idx + 4] = ticks;
      logBuf[idx + 5] = acc * 1000;
      logBuf[idx + 6] = speed;
      logBuf[idx + 7] = currState.carPos.x;
      logBuf[idx + 8] = currState.carPos.y;
      logBuf[idx + 9] = currState.carPos.z;
      logBuf[idx + 10] = carPosUU.x;
      logBuf[idx + 11] = carPosUU.y;
      logBuf[idx + 12] = carPosUU.z;
      logBuf[idx + 13] = flipped;
      logCount++;
    }

    rsToThreeInto(ballPosUU.x, ballPosUU.y, ballPosUU.z, bp3);
    ball.position.set(bp3.x, bp3.y, bp3.z);
    ball.quaternion.copy(ballVisQuat);

    rsToThreeInto(carPosUU.x, carPosUU.y, carPosUU.z, cp3);
    carMesh.position.set(cp3.x, cp3.y, cp3.z);
    carMesh.quaternion.copy(carQuatPrev).slerp(carQuatCurr, alpha);
    updateBoostFx(ctl.boost && (infBoost || currState.boost > 0), dt);
    updateShadows();

    // Hit sparks (car-ball / car-wall)
    if (ticks > 0) checkHits();
    updateSparks(dt);

    // Giro independiente, dirección del eje delantero y recorrido visual de suspensión.
    const forwardSpeedUU = currState.carVel.x * currState.carRot[0]
      + currState.carVel.y * currState.carRot[1]
      + currState.carVel.z * currState.carRot[2];
    wheelSpin -= forwardSpeedUU * UU_TO_M * dt / 0.32;
    const speedFactor = Math.min(Math.abs(forwardSpeedUU) / 1400, 1);
    const groundTravel = currState.isOnGround ? 0.015 : -0.085;
    for (const rig of wheelRig) {
      const pitchTravel = (rig.front ? -1 : 1) * ctl.throttle * 0.018;
      const rollTravel = (rig.right ? -1 : 1) * ctl.steer * speedFactor * 0.014;
      const travel = groundTravel + pitchTravel + rollTravel;
      const targetY = rig.baseY + travel / rig.modelScale;
      rig.wheel.position.y += (targetY - rig.wheel.position.y) * Math.min(dt * 14, 1);
      rig.wheel.quaternion.copy(rig.baseQuaternion);
      // GLB matrices + source.rotation.x=π/2 make: local Y = axle (lateral), local Z = up.
      // Steer around up (local Z), roll-spin around axle (local Y).
      // Invert visual steer so right input turns wheels right
      if (rig.front) rig.wheel.rotateZ(ctl.steer * 0.48);
      rig.wheel.rotateY(wheelSpin);
    }

    // Cámara: cálculo en espacio RocketSim (UU), convertido a three.js solo al final.
    carFwdBuf[0] = currState.carRot[0]; carFwdBuf[1] = currState.carRot[1]; carFwdBuf[2] = currState.carRot[2];
    carVelBuf[0] = currState.carVel.x; carVelBuf[1] = currState.carVel.y; carVelBuf[2] = currState.carVel.z;
    ballPosBuf[0] = ballPosUU.x; ballPosBuf[1] = ballPosUU.y; ballPosBuf[2] = ballPosUU.z;
    carPosBuf[0] = carPosUU.x; carPosBuf[1] = carPosUU.y; carPosBuf[2] = carPosUU.z;
    updateCamera(camera, carPosBuf, carFwdBuf, currState.carRot[8], ballPosBuf, currState.isOnGround, dt);
    if (DBG_CAM === 'top') { camera.position.set(0, 330, 0.001); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.up.set(0, 1, 0); }
    else if (DBG_CAM === 'ball') { camera.position.set(ball.position.x + 1.2, ball.position.y + 1.2, ball.position.z + 5.5); camera.lookAt(ball.position); }
    else if (DBG_CAM === 'goal') { camera.position.set(14, 7, -72); camera.lookAt(0, 5, -104); }
    else if (DBG_CAM === 'car') { camera.position.set(carMesh.position.x + 2.3, carMesh.position.y + 1.5, carMesh.position.z - 3.6); camera.lookAt(carMesh.position.x, carMesh.position.y + 0.6, carMesh.position.z); }
    else if (DBG_CAM === 'carside') { camera.position.set(carMesh.position.x + 9, carMesh.position.y + 2.2, carMesh.position.z + 1.5); camera.lookAt(carMesh.position.x, carMesh.position.y + 0.8, carMesh.position.z + 2.5); }
    else if (DBG_CAM === 'side') { camera.position.set(260, 40, 0); camera.lookAt(0, 40, 0); }
    else if (DBG_CAM === 'corner') { camera.position.set(75, 12, -102); camera.lookAt(60, 8, -90); }

    // El HUD de texto solo se actualiza ~10 veces/seg (no cada frame) para no forzar al
    // navegador a tocar el DOM 60 veces por segundo sin necesidad.
    hudCounter++;
    if (hudCounter >= 15) {
      hudCounter = 0;
      const apiMode = hasPtr ? 'ptr' : 'legacy';
      statsEl.textContent =
        `boost: ${infBoost ? '∞' : currState.boost.toFixed(0)}  onGround: ${currState.isOnGround}  ` +
        `supersonic: ${currState.isSupersonic}  cam: ${cam.ballCam ? 'ball' : 'chase'} | ` +
        `api:${apiMode} | frames: ${Math.min(logCount, LOG_CAPACITY)}/${logCount}`;
    }

    renderer.render(scene, camera);
    if (!window.__loaded) {
      window.__loaded = true;
      loadingUI.finish();
    }
  }

  requestAnimationFrame(frame);
}

main();
