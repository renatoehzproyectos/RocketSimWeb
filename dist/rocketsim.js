// RocketSim (v2.2.1) para la web. Carga rocketsim.wasm (compilado con las mallas de colisión reales de Soccar)
// y expone la misma interfaz que usa game.js: init, createArena, addCar, setCarControls, step,
// getBallState, getCarState, setCarState, resetBall, getOctaneHitboxSize.
async function RocketSimModule(moduleArg = {}) {
  const wasmUrl = moduleArg.locateFile
    ? moduleArg.locateFile('rocketsim.wasm', '')
    : new URL('rocketsim.wasm', import.meta.url).href;

  let memory = null;
  const dv = () => new DataView(memory.buffer);

  // Mínimo de WASI que necesita el módulo (sin archivos ni variables de entorno).
  const wasi = {
    environ_sizes_get: (countPtr, sizePtr) => { const d = dv(); d.setUint32(countPtr, 0, true); d.setUint32(sizePtr, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (id, precision, outPtr) => { dv().setBigUint64(outPtr, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    fd_close: () => 0,
    fd_fdstat_get: (fd, ptr) => { const d = dv(); for (let i = 0; i < 24; i++) d.setUint8(ptr + i, 0); d.setUint8(ptr, 2); return 0; },
    fd_prestat_get: () => 8,
    fd_prestat_dir_name: () => 8,
    fd_read: (fd, iovs, iovsLen, nreadPtr) => { dv().setUint32(nreadPtr, 0, true); return 0; },
    fd_seek: () => 70,
    fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
      const d = dv(); let total = 0;
      for (let i = 0; i < iovsLen; i++) total += d.getUint32(iovs + i * 8 + 4, true);
      d.setUint32(nwrittenPtr, total, true); return 0;
    },
    proc_exit: (code) => { throw new Error('RocketSim terminó (código ' + code + ')'); },
  };

  let instance;
  const imports = { wasi_snapshot_preview1: wasi };
  try {
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' al cargar ' + wasmUrl);
    try { instance = (await WebAssembly.instantiateStreaming(res.clone(), imports)).instance; }
    catch (_) { instance = (await WebAssembly.instantiate(await res.arrayBuffer(), imports)).instance; }
  } catch (err) {
    throw new Error('No se pudo cargar rocketsim.wasm: ' + err);
  }
  const ex = instance.exports;
  memory = ex.memory;
  if (ex._initialize) ex._initialize();

  // Vector de 9 floats con la misma interfaz que el vector que devolvía el módulo anterior (get/delete).
  const makeVec9 = (f, off) => { const a = [f[off], f[off + 1], f[off + 2], f[off + 3], f[off + 4], f[off + 5], f[off + 6], f[off + 7], f[off + 8]]; return { get: (i) => a[i], size: () => 9, delete: () => {} }; };
  const v3 = (f, o) => ({ x: f[o], y: f[o + 1], z: f[o + 2] });

  const Module = {
    // Expose memory so game.js can build HEAPF32 views for zero-alloc state reads
    memory,
    wasmMemory: memory,
    init() { ex.rs_init(); },
    createArena() { ex.rs_create_arena(); },
    addCar(team) { return ex.rs_add_car(team); },
    setCarControls(id, throttle, steer, pitch, yaw, roll, jump, boost, handbrake) {
      ex.rs_set_car_controls(id, throttle, steer, pitch, yaw, roll, jump ? 1 : 0, boost ? 1 : 0, handbrake ? 1 : 0);
    },
    step(n) { ex.rs_step(n === undefined ? 1 : n); },
    getBallState() {
      const f = new Float32Array(memory.buffer, ex.rs_ball_state(), 24);
      return { pos: v3(f, 0), vel: v3(f, 3), angVel: v3(f, 6), rot: makeVec9(f, 9), radius: f[18] };
    },
    getCarState(id) {
      const p = ex.rs_car_state(id);
      if (!p) return null;
      const f = new Float32Array(memory.buffer, p, 32);
      return {
        id, pos: v3(f, 0), vel: v3(f, 3), angVel: v3(f, 6), rot: makeVec9(f, 9), boost: f[18],
        isOnGround: f[19] !== 0, hasJumped: f[20] !== 0, hasDoubleJumped: f[21] !== 0, hasFlipped: f[22] !== 0,
        isFlipping: f[23] !== 0, isJumping: f[24] !== 0, isSupersonic: f[25] !== 0,
      };
    },
    setCarState(id, x, y, z, vx, vy, vz) { ex.rs_set_car_state(id, x, y, z, vx, vy, vz); },
    resetBall() { ex.rs_reset_ball(); },
    getOctaneHitboxSize() { const f = new Float32Array(memory.buffer, ex.rs_hitbox(), 3); return { x: f[0], y: f[1], z: f[2] }; },
    // Zero-alloc ptr API (layout matches get*State: pos0 vel3 angVel6 rot9 ...)
    getBallStatePtr() { return ex.rs_ball_state(); },
    getCarStatePtr(id) { return ex.rs_car_state(id); },
  };
  return Module;
}
export default RocketSimModule;
