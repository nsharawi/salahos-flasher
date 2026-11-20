// main.js — Salah OS Flasher device core (Electron main process).
// Owns ALL device logic. Polls adb/fastboot, runs preflight (read-only), and drives the
// UI state machine. In dryRun (default) the flash path logs the real command plan but
// executes nothing destructive — safe to point at a real frame before images/unlock exist.

const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Where things live. Run from source, everything sits beside main.js. As the packaged .exe, the bundled
// files (config, drivers, images) are in the app's resources, and what the flasher writes (logs, the
// drivers-installed marker, an optional config.json override) goes in the folder the .exe is in.
const RES  = app.isPackaged ? process.resourcesPath : __dirname;
const DATA = app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)) : __dirname;
const CONFIG_FILE = fs.existsSync(path.join(DATA, 'config.json')) ? path.join(DATA, 'config.json') : path.join(RES, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
const DRY = CONFIG.dryRun !== false;
// adb and fastboot travel with the flasher (bin/); the paths in config.json are the fallback.
const BIN = path.join(RES, 'bin');
const ADB = fs.existsSync(path.join(BIN, 'adb.exe')) ? path.join(BIN, 'adb.exe') : CONFIG.tools.adb;
const FB  = fs.existsSync(path.join(BIN, 'fastboot.exe')) ? path.join(BIN, 'fastboot.exe') : CONFIG.tools.fastboot;

let win = null;
let state = 'IDLE';
let flashing = false;
let lastSerial = null;
let isRma = false;            // the connected frame already runs the Salah OS production image
let checkWaiter = null;       // resolves when the operator answers a CHECK question

// ---- this computer's USB drivers --------------------------------------------
// A frame shows up as a different USB device in each mode. If Windows has no driver for one of
// them, restarting the frame into that mode strands it. So: installed once per computer
// (PCSETUP), and checked again before every restart into a mode (driverSeen).
const DRV = Object.assign({ required: false, dir: 'drivers', marker: 'drivers-installed.json',
  modes: [ { id: 'fastbootd', vid: '18D1', pid: '4EE0' }, { id: 'bootloader', vid: '1F3A', pid: '1010' } ] }, CONFIG.drivers || {});
const DRV_DIR = path.join(RES, DRV.dir), DRV_MARK = path.join(DATA, DRV.marker);
function driversInstalled() { return fs.existsSync(DRV_MARK); }
function driverFiles() { try { return fs.readdirSync(DRV_DIR, { recursive: true }).filter(f => /\.inf$/i.test(String(f))); } catch (e) { return []; } }
function driverSummary() { return !DRV.required ? 'not required in this build' : driversInstalled() ? 'installed on this computer' : 'not installed'; }
// Has Windows ever bound a driver to the frame in this mode? (read-only registry query)
async function driverSeen(mode) {
  const m = DRV.modes.find(x => x.id === mode); if (!m) return false;
  const r = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Enum\\USB\\VID_${m.vid}&PID_${m.pid}`, '/s']);
  return !r.err && /\bService\s+REG_SZ\s+\S+/i.test(r.out);
}
async function installDrivers() {
  if (state !== 'PCSETUP') return;
  const infs = driverFiles();
  if (!infs.length) { log('drivers: no driver files in ' + DRV_DIR); setState('PCSETUP', { reason: 'The driver files have not been added to the flasher yet. Nothing was installed.' }); return; }
  log('drivers: asking Windows to install ' + infs.length + ' driver package(s) — approve the Windows prompt');
  // pnputil is Windows' own driver installer; it needs administrator rights, so Windows asks once.
  const ps = `$p = Start-Process pnputil.exe -ArgumentList '/add-driver','"${path.join(DRV_DIR, '*.inf')}"','/subdirs','/install' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', ps], 180000);
  if (r.err) { log('drivers: install did not finish — ' + (r.errout || r.err.message)); setState('PCSETUP', { reason: 'The drivers were not installed. Click Install drivers and choose Yes when Windows asks.' }); return; }
  fs.writeFileSync(DRV_MARK, JSON.stringify({ at: new Date().toISOString(), files: infs.map(String) }, null, 1));
  log('drivers: installed'); setState('IDLE');
}

// ---- helpers ---------------------------------------------------------------
function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
function setState(s, extra = {}) { state = s; send('state', Object.assign({ state: s }, extra)); }
function stamp() { return new Date().toISOString().substring(11, 19); }
function log(line) { send('log', `[${stamp()}] ${line}`); }

function run(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: (stdout || '').trim(), errout: (stderr || '').trim() });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adbDevices() {
  const r = await run(ADB, ['devices']);
  if (r.err) return [];
  return r.out.split('\n').slice(1).map(l => l.trim()).filter(Boolean)
    .map(l => { const [serial, st] = l.split(/\s+/); return { serial, st }; });
}
async function fastbootDevices() {
  const r = await run(FB, ['devices']);
  if (r.err) return [];
  return r.out.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { const [serial, st] = l.split(/\s+/); return { serial, st }; });
}
async function getprop(serial, prop) {
  const r = await run(ADB, ['-s', serial, 'shell', 'getprop', prop]);
  return r.err ? '' : r.out;
}

// ---- preflight (read-only) -------------------------------------------------
async function preflight(serial) {
  log(`preflight: reading ${serial}`);
  const fp     = await getprop(serial, 'ro.build.fingerprint');
  const board  = await getprop(serial, 'ro.product.name');
  const unlock = await getprop(serial, 'sys.oem_unlock_allowed');

  const checks = [
    { id: 'board',  label: 'Board matches',         value: board || '(unknown)', pass: board === CONFIG.golden.board },
    { id: 'fp',     label: 'Firmware matches',      value: fp   || '(unknown)',  pass: fp === CONFIG.golden.fingerprint },
    { id: 'unlock', label: 'OEM unlocking enabled', value: unlock === '1' ? 'yes' : (unlock || 'unknown'), pass: unlock === '1' }
  ];
  checks.forEach(c => log(`preflight: ${c.label}: ${c.value}  ${c.pass ? 'OK' : 'FAIL'}`));

  // Board + firmware gate flashing. OEM-unlock is reported but (in this test build) is a
  // warning, since unlock-on-stock is still unproven — Phase A on the boxed frame settles it.
  const pm = await run(ADB, ['-s', serial, 'shell', 'pm', 'path', 'com.paltech.salahos']);
  isRma = !pm.err && /\/product\/app\/SalahOS\//.test(pm.out);
  log(`preflight: ${isRma ? 'this frame already runs the Salah OS image — returned frame' : 'new frame'}`);
  const gate = checks[0].pass && checks[1].pass;
  if (gate) {
    setState('READY', { checks, rma: isRma, serial });
  } else {
    let reason;
    if (!checks[1].pass) reason = 'Firmware version does not match the verified build — likely a different batch. Set the unit aside and report its version before flashing.';
    else if (!checks[0].pass) reason = 'This board is not the supported model (expected ceres_b3).';
    else reason = 'Frame failed preflight.';
    setState('BLOCKED', { checks, reason, serial });
  }
}

// ---- flash runner (dryRun-aware) ------------------------------------------
// Each step carries the real command plan so the dry run shows exactly what live does.
const IMG = (k) => CONFIG.images[k] || '(image not set)';
function planRma(serial) {
  return [
    { label: 'Reading this unit...',        to: 10, cmds: [`${ADB} -s ${serial} shell getprop  (serial, versions before)`] },
    { label: 'Writing boot logo...',        to: 30, cmds: [`${ADB} -s ${serial} reboot bootloader`, `${FB} flash bootloader_a  ${IMG('bootloader_a')}`, `${FB} flash env_a  ${IMG('env_a')}`] },
    { label: 'Installing Salah OS...',      to: 65, cmds: [`${FB} reboot fastboot`, `${FB} flash product  ${IMG('product')}`] },
    { label: 'Erasing customer data...',    to: 80, cmds: [`${FB} -w   (erase userdata and metadata)`, `${FB} flash misc  <2048 zero bytes: clears the restart flag only>`] },
    { label: 'Restarting...',               to: 92, cmds: [`${FB} reboot`] },
    { label: 'Checking...',                 to: 100, cmds: ['wait for the frame; confirm Salah OS is home and owns the device'] }
  ];
}
const CHECKS = [
  { id: 'screen',  title: 'Check the screen',  body: 'Look at the frame. Is the picture clean, with no lines, dead areas or flicker?' },
  { id: 'touch',   title: 'Check the touch',   body: 'Tap each corner of the frame’s screen. Did every tap register?' },
  { id: 'speaker', title: 'Check the speaker', body: 'The frame plays a short adhan. Is the sound clear?' }
];
function askCheck(q, serial) { return new Promise((resolve) => { checkWaiter = resolve; setState('CHECK', { check: q, rma: true, serial }); }); }
function record(serial, kind, result, extra) {
  try { const dir = path.join(DATA, 'log'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'units.csv'); if (!fs.existsSync(f)) fs.writeFileSync(f, 'time,serial,kind,mode,result,detail\n');
    fs.appendFileSync(f, [new Date().toISOString(), serial, kind, DRY ? 'dry-run' : 'live', result, JSON.stringify(extra || '').replace(/,/g, ';')].join(',') + '\n'); } catch (e) { log('record: could not write units.csv — ' + e.message); }
}

function planFor(serial) {
  if (isRma) return planRma(serial);
  return [
    { label: 'Backing up this unit...',    to: 15, cmds: [`${ADB} -s ${serial} shell dd if=/dev/block/by-name/{boot_a,init_boot_a,vendor_boot_a,vbmeta_a,misc,dtbo_a}  ->  backups/${serial}-<ts>/`] },
    { label: 'Unlocking bootloader...',    to: 35, cmds: [`${ADB} -s ${serial} reboot bootloader`, `${FB} flashing unlock   (UNPROVEN on stock — Phase A)`] },
    { label: 'Writing boot settings...',   to: 50, cmds: [`${FB} flash vbmeta_a  ${CONFIG.images.vbmeta_a || '(image not set)'}`] },
    { label: 'Writing boot logo...',       to: 60, cmds: [`${FB} flash bootloader_a  ${IMG('bootloader_a')}`, `${FB} flash env_a  ${IMG('env_a')}`] },
    { label: 'Installing Salah OS image...', to: 85, cmds: [`${FB} reboot fastboot`, `${FB} flash product  ${CONFIG.images.product || '(image not set)'}`, `${FB} flash misc  <2048 zero bytes: clears the restart flag only>`] },
    { label: 'Rebooting frame...',         to: 95, cmds: [`${FB} reboot`] },
    { label: 'Verifying installation...',  to: 100, cmds: [`${ADB} -s ${serial} shell pm path com.paltech.salahos`] }
  ];
}


// ---- live flashing ----------------------------------------------------------
// One frame at a time, so fastboot is used without a serial (the frame's fastboot serial is not
// always its adb serial). Every restart into another mode is waited for; nothing is assumed.
const imgPath = (k) => { const v = CONFIG.images[k]; return v ? (path.isAbsolute(v) ? v : path.join(RES, v)) : ''; };
function needImages(keys) { const miss = keys.filter(k => !imgPath(k) || !fs.existsSync(imgPath(k))); if (miss.length) throw new Error('These images are not set or not found: ' + miss.join(', ') + '. Nothing was changed.'); }
function tail(r) { return ((r.errout || '') + '\n' + (r.out || '')).trim().split('\n').slice(-2).join(' | '); }
async function fb(args, timeout = 300000) { const r = await run(FB, args, timeout); log(`   fastboot ${args.join(' ')}  ->  ${tail(r) || 'ok'}`); return r; }
async function fbOk(args, what, timeout) { const r = await fb(args, timeout); if (r.err || /FAILED|error:/i.test(r.errout + r.out)) throw new Error(what + ' failed: ' + tail(r)); return r; }
async function waitFor(fn, ms, every = 1500) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(every); } return false; }
async function fbMode() { const d = await fastbootDevices(); if (!d.length) return null; const r = await run(FB, ['getvar', 'is-userspace']); return /is-userspace:\s*yes/i.test(r.out + r.errout) ? 'fastbootd' : 'bootloader'; }
async function fbVar(name) { const r = await run(FB, ['getvar', name]); const m = (r.out + '\n' + r.errout).match(new RegExp(name + ':\\s*(\\S+)', 'i')); return m ? m[1] : ''; }
const step = (pct, label) => { send('progress', { pct, label }); log('step: ' + label); };

// After flashing mode the frame must be told to start normally. That flag lives in the first 2048 bytes of
// the misc partition. Writing 2048 zero bytes clears it and touches nothing after it, so no other unit's
// misc contents are ever copied onto this frame.
function bcbClearFile() { const f = path.join(DATA, 'work', 'bcb-clear.bin'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(2048)); return f; }

async function toBootloader(serial) {
  log('   adb reboot bootloader');
  await run(ADB, ['-s', serial, 'reboot', 'bootloader']);
  if (!(await waitFor(async () => (await fbMode()) === 'bootloader', 90000))) throw new Error('The frame restarted but did not appear in bootloader mode on this computer. Nothing was written. Unplug the frame\'s power for a few seconds to start it normally.');
}
async function toFastbootd() {
  await fb(['reboot', 'fastboot'], 30000);
  if (!(await waitFor(async () => (await fbMode()) === 'fastbootd', 120000))) throw new Error('The frame did not appear in flashing mode (fastbootd) on this computer. The system image was not written.');
}
async function unlock() {
  let u = await fbVar('unlocked'); log('   bootloader unlocked: ' + (u || 'unknown'));
  if (/yes|true/i.test(u)) return;
  let r = await fb(['flashing', 'unlock'], 120000);
  if (r.err || /FAILED/i.test(r.errout + r.out)) r = await fb(['oem', 'unlock'], 120000);
  // The frame may ask for a confirmation on its own screen, and may restart itself afterwards.
  setState('CONFIRM', { confirm: 'If the frame shows a question about unlocking, answer Yes on the frame. Waiting…', serial: lastSerial });
  const ok = await waitFor(async () => /yes|true/i.test(await fbVar('unlocked')), 180000, 2500);
  setState('FLASHING');
  if (!ok) throw new Error('The bootloader did not unlock (' + (tail(r) || 'no answer') + '). Nothing was written. The frame can be unplugged and restarted; it still has its original software.');
}
async function verifyBoot(serial) {
  // A dev image turns USB debugging back on, so the flasher can read the result. A shipping image does not.
  const up = await waitFor(async () => { const d = await adbDevices(); return d.some(x => x.st === 'device'); }, 360000, 3000);
  if (!up) return { seen: false };
  const s2 = (await adbDevices()).find(x => x.st === 'device').serial;
  await waitFor(async () => (await getprop(s2, 'sys.boot_completed')) === '1', 180000, 3000);
  await sleep(45000);
  const pm = await run(ADB, ['-s', s2, 'shell', 'pm', 'path', 'com.paltech.salahos']);
  const lg = await run(ADB, ['-s', s2, 'shell', 'cat', '/data/local/tmp/salahos-setup.log']);
  (lg.out || '(no setup log readable)').split('\n').slice(-16).forEach(l => log('   frame: ' + l));
  const home = await run(ADB, ['-s', s2, 'shell', 'cmd', 'package', 'resolve-activity', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME']);
  return { seen: true, serial: s2, app: /\/product\/app\/SalahOS\//.test(pm.out), setupDone: /\bdone\s*$/m.test(lg.out || ''), home: /com\.paltech\.salahos/.test(home.out) };
}

async function liveNew(serial) {
  needImages(['vbmeta_a', 'product']);
  step(5, 'Backing up this unit...');
  const info = {}; for (const p of ['ro.build.fingerprint', 'ro.serialno', 'ro.boot.slot_suffix', 'ro.boot.verifiedbootstate', 'ro.boot.flash.locked']) info[p] = await getprop(serial, p);
  const bdir = path.join(DATA, 'backups', serial + '-' + new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'info.json'), JSON.stringify(info, null, 1));
  log('   this unit: ' + JSON.stringify(info));
  log('   note: a stock frame gives no root, so its partitions cannot be copied off; the golden backup of this exact firmware is what Restore uses.');
  if (info['ro.boot.slot_suffix'] && info['ro.boot.slot_suffix'] !== '_a') throw new Error('This frame runs from slot ' + info['ro.boot.slot_suffix'] + ', not _a. The images are for slot _a. Nothing was changed.');

  step(18, 'Unlocking bootloader...');
  await toBootloader(serial);
  await unlock();

  step(40, 'Writing boot settings...');
  await fbOk(['flash', 'vbmeta_a', imgPath('vbmeta_a')], 'Writing boot settings');

  step(55, 'Installing Salah OS image...');
  await toFastbootd();
  await fbOk(['flash', 'product', imgPath('product')], 'Installing the Salah OS image', 600000);
  await fbOk(['flash', 'misc', bcbClearFile()], 'Clearing the restart flag');

  step(88, 'Rebooting frame...');
  await fb(['reboot'], 30000);

  step(94, 'Verifying installation...');
  return verifyBoot(serial);
}

async function liveRma(serial) {
  needImages(['product']);
  step(8, 'Reading this unit...');
  const before = (await run(ADB, ['-s', serial, 'shell', 'dumpsys', 'package', 'com.paltech.salahos'])).out.match(/versionName=\S+/g) || [];
  log('   before: ' + before.join(', '));
  step(25, 'Installing Salah OS...');
  await run(ADB, ['-s', serial, 'reboot', 'fastboot']); log('   adb reboot fastboot');
  if (!(await waitFor(async () => (await fbMode()) === 'fastbootd', 120000))) throw new Error('The frame did not appear in flashing mode (fastbootd) on this computer. Nothing was written.');
  await fbOk(['flash', 'product', imgPath('product')], 'Installing the Salah OS image', 600000);
  await fbOk(['flash', 'misc', bcbClearFile()], 'Clearing the restart flag');
  step(60, 'Restarting...');
  await fb(['reboot'], 30000);
  const v = await verifyBoot(serial);
  if (!v.seen) throw new Error('The frame did not come back on USB after the new image. Check its screen.');
  step(80, 'Erasing customer data...');
  await run(ADB, ['-s', v.serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.FACTORY_RESET', '-p', 'android', '--receiver-foreground']);
  await waitFor(async () => !(await adbDevices()).some(x => x.st === 'device'), 90000, 2000);
  step(92, 'Checking...');
  return verifyBoot(serial);
}

async function startFlash() {
  if (flashing) return;
  if (state !== 'READY' && state !== 'ERROR') { log('flash: ignored (not READY/ERROR)'); return; }
  if (!DRY) { // never restart a frame into flashing mode on a computer that has no driver for it
    // (Bootloader mode is a one-time visit that a power cycle ends, so a first contact is allowed there.
    //  Flashing mode can persist across a power cycle, so it needs a driver on record or installed by us.)
    if (!(await driverSeen('fastbootd')) && !driversInstalled()) { log('flash: refused — this computer has no driver on record for flashing mode (fastbootd)'); setState('ERROR', { reason: 'This computer has no USB driver for the frame\'s flashing mode yet. The frame was not restarted and nothing was changed.', serial: lastSerial }); return; }
  }
  flashing = true;
  setState('FLASHING');

  const serial = lastSerial || '<serial>';
  log(DRY ? '================  DRY RUN — the frame will NOT be modified  ================'
          : '================  LIVE FLASH  ================');

  const steps = planFor(serial);
  try {
    if (!DRY) {
      steps.forEach((s, i) => { log(`plan ${i + 1}/${steps.length}: ${s.label}`); });
      const v = isRma ? await liveRma(serial) : await liveNew(serial);
      send('progress', { pct: 100, label: 'Verifying installation...' });
      const res = { verify: v };
      if (isRma) for (const q of CHECKS) { const ok = await askCheck(q, v.serial || serial); res[q.id] = ok ? 'pass' : 'FAIL'; log(`check: ${q.id}: ${res[q.id]}`); }
      const failed = CHECKS.filter(q => res[q.id] === 'FAIL').map(q => q.id);
      flashing = false;
      if (v.seen && !(v.app && v.home)) { record(serial, isRma ? 'rma' : 'new', 'verify-failed', res); setState('ERROR', { reason: 'The frame started, but Salah OS is not in place as expected (see Logs).', serial, canRestore: !!CONFIG.images.stock_product }); return; }
      if (failed.length) { record(serial, 'rma', 'check-failed', res); setState('ERROR', { reason: 'This frame failed its check: ' + failed.join(', ') + '. Set it aside; do not resell it.', serial }); return; }
      record(serial, isRma ? 'rma' : 'new', v.seen ? 'ok' : 'flashed-unverified', res);
      setState('DONE', { serial, reason: v.seen ? '' : 'The image is written. This frame does not report back over USB, so check that its screen shows the Salah OS welcome page, then unplug it.' });
      return;
    }
    let from = 2;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      log(`step ${i + 1}/${steps.length}: ${s.label}`);
      s.cmds.forEach(c => log(DRY ? `   would run:  ${c}` : `   run:  ${c}`));


      // animate progress toward this step's ceiling
      for (let p = from; p <= s.to; p += 3) { send('progress', { pct: Math.min(p, s.to), label: s.label }); await sleep(55); }
      from = s.to;
    }
    log('flash: dry run complete — no changes made.');
    if (isRma) {
      const res = { wifi: 'not run (dry run)' };
      for (const q of CHECKS) { const ok = await askCheck(q, serial); res[q.id] = ok ? 'pass' : 'FAIL'; log(`check: ${q.id}: ${res[q.id]}`); }
      const failed = CHECKS.filter(q => res[q.id] === 'FAIL').map(q => q.id);
      record(serial, 'rma', failed.length ? 'check-failed' : 'ok', res);
      flashing = false;
      if (failed.length) { setState('ERROR', { reason: 'This frame failed its check: ' + failed.join(', ') + '. Set it aside; do not resell it.', serial }); return; }
      setState('DONE', { serial }); return;
    }
    record(serial, 'new', 'ok');
    flashing = false;
    setState('DONE', { serial });
  } catch (e) {
    log('flash: ERROR — ' + e.message);
    record(serial, isRma ? 'rma' : 'new', 'error', e.message);
    flashing = false;
    setState('ERROR', { reason: e.message, serial, canRestore: !!CONFIG.images.stock_product });
  }
}

// ---- device poller ---------------------------------------------------------
async function poll() {
  if (flashing) return;
  if (DRV.required && !driversInstalled()) { if (state !== 'PCSETUP') { setState('PCSETUP'); log('this computer needs the frame USB drivers before flashing'); } return; }
  const adv = await adbDevices();
  const fb  = await fastbootDevices();

  const authed = adv.find(d => d.st === 'device');
  const unauth = adv.find(d => d.st === 'unauthorized');
  const inFb   = fb[0];

  if (authed) {
    if (state === 'DONE' && authed.serial === lastSerial) return;  // wait for unplug
    if (!['DETECTED', 'READY', 'BLOCKED', 'ERROR'].includes(state) || authed.serial !== lastSerial) {   // an error stays on screen until Retry or unplug
      lastSerial = authed.serial;
      setState('DETECTED');
      preflight(authed.serial);
    }
  } else if (unauth) {
    lastSerial = null;
    if (state !== 'PREPARE') { setState('PREPARE'); log('frame connected but not authorized — enable USB debugging and tap Allow on the frame'); }
  } else if (inFb) {
    // frame sitting in bootloader/fastbootd (e.g. after a prior run); nudge toward idle
    if (!['DETECTED', 'READY', 'BLOCKED', 'DONE'].includes(state)) setState('IDLE');
  } else {
    lastSerial = null;
    if (state !== 'IDLE') setState('IDLE');
  }
}

// ---- window + ipc ----------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 820, height: 480, resizable: false, frame: false, show: false,
    backgroundColor: '#EFF3F8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => { win.show(); log(`Salah OS Flasher ${CONFIG.version} ready${DRY ? ' — DRY RUN' : ''}`); log('watching for a frame...'); });
}

ipcMain.on('startFlash', () => startFlash());
ipcMain.on('installDrivers', () => installDrivers());
ipcMain.on('answerCheck', (_e, pass) => { if (state === 'CHECK' && checkWaiter) { const w = checkWaiter; checkWaiter = null; w(!!pass); } });
ipcMain.on('restoreOriginal', () => {
  if (state !== 'ERROR') return;
  log('restore: would write the original software back:');
  log(`   would run:  ${FB} flash product  ${IMG('stock_product')}`);
  log(`   would run:  ${FB} flash bootloader_a  ${IMG('stock_bootloader_a')}   and env_a  ${IMG('stock_env_a')}`);
  log('restore: not enabled in this build — nothing was changed.');
});
ipcMain.on('closeWindow', () => { if (state !== 'FLASHING' && state !== 'CHECK' && win) win.close(); });
ipcMain.handle('getConfig', () => ({
  version: CONFIG.version, dryRun: DRY, golden: CONFIG.golden, tools: { adb: ADB, fastboot: FB }, drivers: driverSummary(),
  images: Object.fromEntries(Object.entries(CONFIG.images).filter(([, v]) => v))
}));

// block OS-level close while flashing
app.on('before-quit', (e) => { if (state === 'FLASHING') e.preventDefault(); });

app.whenReady().then(() => {
  createWindow();
  setInterval(poll, 1500);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
