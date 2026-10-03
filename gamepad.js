// Soporte de mando (PS4 DualShock 4 / mapeo estándar de Gamepad API) + menú de ajustes
// estilo Rocket League dibujado con la estética ImGui de CustomUI.

const PS4_BUTTONS = ['Cruz ✕', 'Círculo ○', 'Cuadrado □', 'Triángulo △', 'L1', 'R1', 'L2', 'R2',
  'Share', 'Options', 'L3', 'R3', 'D-Pad ↑', 'D-Pad ↓', 'D-Pad ←', 'D-Pad →', 'PS', 'Touchpad'];
const btnName = (i) => (i < 0 ? '— sin asignar —' : PS4_BUTTONS[i] ?? `Botón ${i}`);

const ACTIONS = [
  ['throttle', 'Acelerar'],
  ['reverse', 'Frenar / Reversa'],
  ['jump', 'Saltar'],
  ['boost', 'Boost'],
  ['powerslide', 'Powerslide'],
  ['airroll', 'Air Roll (libre)'],
  ['airrollL', 'Air Roll Izquierda'],
  ['airrollR', 'Air Roll Derecha'],
  ['ballcam', 'Cámara de balón'],
  ['reset', 'Reiniciar balón'],
  ['menu', 'Menú de ajustes'],
];

const DEFAULTS = {
  deadzone: 0.15,
  dodgeDeadzone: 0.5,
  steerSens: 1.0,
  aerialSens: 1.0,
  invertPitch: false,
  vibration: true,
  vibrationIntensity: 0.6,
  bindings: {
    throttle: 7, reverse: 6, jump: 0, boost: 1, powerslide: 2, airroll: 2,
    airrollL: 4, airrollR: 5, ballcam: 3, reset: 8, menu: 9,
  },
};

const STORE_KEY = 'rocketsim.controller.v1';
let settings = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) return { ...DEFAULTS, ...s, bindings: { ...DEFAULTS.bindings, ...(s.bindings || {}) } };
  } catch (_) {}
  return structuredClone(DEFAULTS);
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) {} }

// ---------- lectura del mando ----------
const out = {
  connected: false, id: '', throttle: 0, steer: 0, yaw: 0, pitch: 0, roll: 0,
  jump: false, boost: false, handbrake: false, resetPressed: false, camPressed: false,
  raw: { lx: 0, ly: 0, rx: 0, ry: 0, buttons: [] },
};
let prevButtons = [];
let menuOpen = false;
let rebinding = null; // nombre de acción esperando botón
let lastBoost = false;

function applyDeadzone(x, y, dz) {
  const mag = Math.hypot(x, y);
  if (mag < dz) return [0, 0];
  const scaled = Math.min((mag - dz) / (1 - dz), 1) / mag;
  return [x * scaled, y * scaled];
}
const pressedVal = (gp, i) => (i >= 0 && gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
const isDown = (gp, i) => i >= 0 && !!gp.buttons[i]?.pressed;

function getPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

export function pollGamepad() {
  const gp = getPad();
  out.resetPressed = false; out.camPressed = false;
  if (!gp) {
    if (out.connected) { out.connected = false; updateStatus(); }
    return out;
  }
  if (!out.connected || out.id !== gp.id) { out.connected = true; out.id = gp.id; updateStatus(); }

  const b = settings.bindings;
  const justPressed = (i) => isDown(gp, i) && !prevButtons[i];

  // Reasignación: el primer botón nuevo presionado se asigna a la acción.
  if (rebinding) {
    for (let i = 0; i < gp.buttons.length; i++) {
      if (justPressed(i)) { b[rebinding] = i; rebinding = null; save(); renderMenu(); break; }
    }
  } else if (justPressed(b.menu)) {
    toggleMenu();
  }

  const [lx, ly] = applyDeadzone(gp.axes[0] || 0, gp.axes[1] || 0, settings.deadzone);
  out.raw.lx = gp.axes[0] || 0; out.raw.ly = gp.axes[1] || 0;
  out.raw.rx = gp.axes[2] || 0; out.raw.ry = gp.axes[3] || 0;
  out.raw.buttons = gp.buttons.map((x) => x.pressed);

  if (menuOpen) {
    zero();
  } else {
    const steerIn = Math.max(-1, Math.min(1, lx * settings.steerSens));
    const aerX = Math.max(-1, Math.min(1, lx * settings.aerialSens));
    const aerY = Math.max(-1, Math.min(1, ly * settings.aerialSens));
    out.throttle = pressedVal(gp, b.throttle) - pressedVal(gp, b.reverse);
    out.steer = -steerIn;
    const freeRoll = isDown(gp, b.airroll);
    out.yaw = freeRoll ? 0 : -aerX;
    out.roll = freeRoll ? aerX : 0;
    if (isDown(gp, b.airrollL)) out.roll = -1;
    if (isDown(gp, b.airrollR)) out.roll = 1;
    out.pitch = settings.invertPitch ? -aerY : aerY;
    out.jump = isDown(gp, b.jump);
    out.boost = isDown(gp, b.boost);
    out.handbrake = isDown(gp, b.powerslide);
    out.resetPressed = justPressed(b.reset);
    out.camPressed = justPressed(b.ballcam);
    // si no hay stick, deja que el teclado mande (steer/yaw 0 → no override)
    if (out.steer === 0) out.yaw = out.yaw || 0;

    if (out.boost && !lastBoost) rumble(0.15, 0.5, 80);
    if (out.resetPressed) rumble(0.6, 0.6, 160);
  }
  lastBoost = out.boost;
  prevButtons = gp.buttons.map((x) => x.pressed);
  if (menuOpen) drawVisualizer();
  return out;
}
function zero() {
  out.throttle = out.steer = out.yaw = out.pitch = out.roll = 0;
  out.jump = out.boost = out.handbrake = false;
}

function rumble(weak, strong, ms) {
  if (!settings.vibration) return;
  const gp = getPad();
  const act = gp && gp.vibrationActuator;
  if (!act || !act.playEffect) return;
  const k = settings.vibrationIntensity;
  act.playEffect('dual-rumble', { duration: ms, weakMagnitude: weak * k, strongMagnitude: strong * k }).catch(() => {});
}

// ---------- UI estilo CustomUI (ImGui) ----------
let root, body, statusEl, activeTab = 'controls';

function updateStatus() {
  if (!statusEl) statusEl = document.getElementById('pad-status');
  if (!statusEl) return;
  statusEl.textContent = out.connected ? `🎮 ${out.id.split('(')[0].trim()} conectado` : '';
  statusEl.style.display = out.connected ? 'block' : 'none';
  if (out.connected) rumble(0.3, 0.3, 120);
}

function toggleMenu(force) {
  menuOpen = force ?? !menuOpen;
  rebinding = null;
  root.classList.toggle('open', menuOpen);
  if (menuOpen) renderMenu();
}

const SLIDERS = {
  controls: [
    ['deadzone', 'Zona muerta del mando', 0, 0.5, 0.01],
    ['dodgeDeadzone', 'Zona muerta de esquive', 0, 1, 0.01],
    ['steerSens', 'Sensibilidad de dirección', 0.1, 5, 0.05],
    ['aerialSens', 'Sensibilidad aérea', 0.1, 5, 0.05],
  ],
  pad: [['vibrationIntensity', 'Intensidad de vibración', 0, 1, 0.05]],
};

function sliderHTML([key, label, min, max, step]) {
  const v = settings[key];
  const pct = ((v - min) / (max - min)) * 100;
  return `<div class="cui-row"><label>${label}</label>
    <div class="cui-slider" style="--p:${pct}%">
      <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${v}">
      <span class="cui-val">${Number(v).toFixed(2)}</span>
    </div></div>`;
}
function checkHTML(key, label) {
  return `<label class="cui-check"><input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}><span></span>${label}</label>`;
}

function renderMenu() {
  if (!body) return;
  root.querySelectorAll('.cui-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
  let h = '';
  if (activeTab === 'controls') {
    h += `<div class="cui-sep">Controles</div>`;
    h += SLIDERS.controls.map(sliderHTML).join('');
    h += checkHTML('invertPitch', 'Invertir eje de cabeceo (aéreo)');
    h += `<div class="cui-sep">Visualizador de entrada</div><canvas id="cui-vis" width="440" height="130"></canvas>`;
  } else if (activeTab === 'bindings') {
    h += `<div class="cui-sep">Asignación de botones (PS4)</div>`;
    h += ACTIONS.map(([k, l]) => `<div class="cui-bind"><span>${l}</span>
      <button class="cui-btn ${rebinding === k ? 'waiting' : ''}" data-bind="${k}">
      ${rebinding === k ? 'Presiona un botón…' : btnName(settings.bindings[k])}</button>
      <button class="cui-btn small" data-unbind="${k}" title="Quitar">✕</button></div>`).join('');
  } else {
    h += `<div class="cui-sep">Mando</div>`;
    h += `<div class="cui-info">${out.connected ? `Conectado: <b>${out.id}</b>` : 'No hay mando detectado. Conecta tu PS4 por USB o Bluetooth y presiona cualquier botón.'}</div>`;
    h += checkHTML('vibration', 'Vibración del mando');
    h += SLIDERS.pad.map(sliderHTML).join('');
    h += `<button class="cui-btn" data-test="1">Probar vibración</button>`;
  }
  h += `<div class="cui-footer"><button class="cui-btn" data-reset="1">Restablecer valores</button>
    <button class="cui-btn primary" data-close="1">Cerrar</button></div>`;
  body.innerHTML = h;
  drawVisualizer();
}

function drawVisualizer() {
  const c = document.getElementById('cui-vis');
  if (!c) return;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const stick = (cx, x, y, label) => {
    g.strokeStyle = '#3d4a5c'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, 60, 45, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,170,40,.5)';
    g.beginPath(); g.arc(cx, 60, 45 * settings.deadzone, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ff9f1c';
    g.beginPath(); g.arc(cx + x * 45, 60 + y * 45, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#9aa7b8'; g.font = '11px system-ui'; g.textAlign = 'center';
    g.fillText(label, cx, 122);
  };
  stick(60, out.raw.lx, out.raw.ly, 'Stick izq.');
  stick(170, out.raw.rx, out.raw.ry, 'Stick der.');
  const bs = out.raw.buttons || [];
  for (let i = 0; i < 16; i++) {
    const x = 240 + (i % 6) * 33, y = 18 + Math.floor(i / 6) * 34;
    g.fillStyle = bs[i] ? '#ff9f1c' : '#1b2330';
    g.strokeStyle = '#3d4a5c';
    g.fillRect(x, y, 29, 26); g.strokeRect(x, y, 29, 26);
    g.fillStyle = bs[i] ? '#111' : '#9aa7b8'; g.font = '9px system-ui';
    g.fillText((PS4_BUTTONS[i] || '').split(' ')[0].slice(0, 5), x + 14.5, y + 16);
  }
}

export function initControllerUI() {
  if (root) return;
  root = document.createElement('div');
  root.id = 'cui-root';
  root.innerHTML = `<div class="cui-window">
    <div class="cui-title"><span>CustomUI · Ajustes de mando</span><button data-close="1">✕</button></div>
    <div class="cui-tabs">
      <button class="cui-tab" data-tab="controls">Controles</button>
      <button class="cui-tab" data-tab="bindings">Asignación</button>
      <button class="cui-tab" data-tab="pad">Mando</button>
    </div>
    <div class="cui-body"></div></div>`;
  document.body.appendChild(root);
  body = root.querySelector('.cui-body');

  const gear = document.createElement('button');
  gear.id = 'cui-gear'; gear.textContent = '⚙'; gear.title = 'Ajustes de mando';
  gear.addEventListener('click', () => toggleMenu());
  document.body.appendChild(gear);

  root.addEventListener('input', (e) => {
    const k = e.target.dataset.key; if (!k) return;
    if (e.target.type === 'checkbox') settings[k] = e.target.checked;
    else {
      settings[k] = parseFloat(e.target.value);
      const s = e.target.parentElement;
      s.style.setProperty('--p', ((settings[k] - e.target.min) / (e.target.max - e.target.min)) * 100 + '%');
      s.querySelector('.cui-val').textContent = settings[k].toFixed(2);
    }
    save();
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.tab) { activeTab = t.dataset.tab; rebinding = null; renderMenu(); }
    else if (t.dataset.close) toggleMenu(false);
    else if (t.dataset.bind) { rebinding = t.dataset.bind; renderMenu(); }
    else if (t.dataset.unbind) { settings.bindings[t.dataset.unbind] = -1; save(); renderMenu(); }
    else if (t.dataset.reset) { settings = structuredClone(DEFAULTS); save(); renderMenu(); }
    else if (t.dataset.test) rumble(1, 1, 400);
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape') toggleMenu(); });
  window.addEventListener('gamepadconnected', () => pollGamepad());
  window.addEventListener('gamepaddisconnected', () => pollGamepad());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initControllerUI);
else initControllerUI();
