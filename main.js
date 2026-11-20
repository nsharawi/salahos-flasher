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
  const root   = (await run(ADB, ['-s', serial, 'shell', 'id', '-u'])).out.trim();

  const checks = [
    { id: 'board',  label: 'Board matches',         value: board || '(unknown)', pass: board === CONFIG.golden.board },
    { id: 'fp',     label: 'Firmware matches',      value: fp   || '(unknown)',  pass: fp === CONFIG.golden.fingerprint },
    { id: 'unlock', label: 'Full access over USB',  value: root === '0' ? 'yes' : 'no', pass: root === '0' }
  ];
  checks.forEach(c => log(`preflight: ${c.label}: ${c.value}  ${c.pass ? 'OK' : 'FAIL'}`));

  const pm = await run(ADB, ['-s', serial, 'shell', 'pm', 'path', 'com.paltech.salahos']);
  isRma = !pm.err && /\/product\/app\/SalahOS\//.test(pm.out);
  log(`preflight: ${isRma ? 'this frame already runs the Salah OS image — returned frame' : 'new frame'}`);
  const gate = checks[0].pass && checks[1].pass && checks[2].pass;
  if (gate) {
    setState('READY', { checks, rma: isRma, serial });
  } else {
    let reason;
    if (!checks[1].pass) reason = 'Firmware version does not match the verified build — likely a different batch. Set the unit aside and report its version before flashing.';
    else if (!checks[0].pass) reason = 'This board is not the supported model (expected ceres_b3).';
    else reason = 'This frame does not give the flasher full access over USB.';
    setState('BLOCKED', { checks, reason, serial });
  }
}

// ---- flash runner (dryRun-aware) ------------------------------------------
// Each step carries the real command plan so the dry run shows exactly what live does.
const IMG = (k) => CONFIG.images[k] || '(image not set)';
function planRma(serial) {
  return [
    { label: 'Reading this unit...',        to: 12, cmds: ['check access, layout and verified-boot facts; copy this unit\'s boot partitions to the PC'] },
    { label: 'Installing Salah OS...',      to: 50, cmds: [`write ${IMG('product')} into its place inside super; read it back`] },
    { label: 'Writing boot logo...',        to: 62, cmds: ['boot pictures and backlight line: written only if not already in place; read back'] },
    { label: 'Erasing customer data...',    to: 80, cmds: ['factory reset (the frame restarts and erases itself)'] },
    { label: 'Checking...',                 to: 100, cmds: ['wait for the frame; confirm Salah OS is home and owns the device'] }
  ];
}
const CHECKS = [
  { id: 'screen',  title: 'Check the screen',  body: 'Look at the frame. Is the picture clean, with no lines, dead areas or flicker?' },
  { id: 'touch',   title: 'Check the touch',   body: 'Tap each corner of the frame’s screen. Did every tap register?' },
  { id: 'speaker', title: 'Check the speaker', body: 'Is the frame\'s sound loud and clear?' }
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
    { label: 'Backing up this unit...',      to: 15, cmds: ['check access, layout and verified-boot facts; copy this unit\'s boot partitions to the PC'] },
    { label: 'Installing Salah OS image...', to: 55, cmds: [`write ${IMG('product')} into its place inside super; read it back`] },
    { label: 'Writing boot logo...',         to: 65, cmds: ['replace the two boot pictures inside this unit\'s own bootloader partition; read it back'] },
    { label: 'Writing boot settings...',     to: 75, cmds: [`write ${IMG('env_new')} (steady backlight); read it back`] },
    { label: 'Rebooting frame...',           to: 90, cmds: [`${ADB} -s ${serial} reboot`] },
    { label: 'Verifying installation...',    to: 100, cmds: ['read the frame\'s own setup log; confirm Salah OS is home and owns the device'] }
  ];
}


// ---- live flashing ----------------------------------------------------------
// A stock frame of this firmware gives a root shell over USB debugging, and only its system partition is
// under verified boot. So a unit is made with three verified writes over adb, with no unlock, no wipe and
// no fastboot: the product image (into its place inside super), the two boot pictures (inside the unit's
// own bootloader partition) and the backlight line (env). Everything is checked first, then written, then
// read back; the unit's originals are kept so every write can be undone.
const crypto = require('crypto');
const { spawn } = require('child_process');
const REF = Object.assign({
  super: '/dev/block/by-name/super',
  productTable: '0-279864: linear, 179:11 1918976', productSeek: 239872, productBlocks: 34983,
  stockProduct: 'd1fd5daa2f0a340f04a2e8d1bfe45ef4b2950c69e9defc60608c1a8ea43cb3f3',
  stockEnv: 'e7ed37ab8da0b4b5b0e25673d35924694a1592fe447c243949e88658d5475149',
  knownProducts: []          // [{ sha, blocks }] earlier Salah OS images a frame may already carry
}, CONFIG.reference || {});
const imgPath = (k) => { const v = CONFIG.images[k]; return v ? (path.isAbsolute(v) ? v : path.join(RES, v)) : ''; };
function needImages(keys) { const miss = keys.filter(k => !imgPath(k) || !fs.existsSync(imgPath(k))); if (miss.length) throw new Error('These files are not set or not found: ' + miss.join(', ') + '. Nothing was changed.'); }
function tail(r) { return ((r.errout || '') + '\n' + (r.out || '')).trim().split('\n').slice(-2).join(' | '); }
async function waitFor(fn, ms, every = 1500) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(every); } return false; }
const step = (pct, label) => { send('progress', { pct, label }); log('step: ' + label); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function shaFile(f) { return new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); }); }
async function sh(serial, cmd, timeout = 300000) { const r = await run(ADB, ['-s', serial, 'shell', cmd], timeout); return ((r.out || '') + '').replace(/\r/g, '').trim(); }
async function devSha(serial, expr) { return (await sh(serial, expr + ' | sha256sum')).slice(0, 64); }
const regionSha = (serial, blocks) => devSha(serial, `dd if=${REF.super} bs=4096 skip=${REF.productSeek} count=${blocks} 2>/dev/null`);
const partSha = (serial, p) => devSha(serial, `cat /dev/block/by-name/${p}`);
function pull(serial, devCmd, file) {
  return new Promise((res, rej) => {
    const o = fs.createWriteStream(file); const c = spawn(ADB, ['-s', serial, 'exec-out', devCmd], { windowsHide: true });
    c.stdout.pipe(o); c.on('error', rej);
    o.on('finish', () => res()); c.on('close', (code) => { if (code) rej(new Error('Reading from the frame failed (adb exit ' + code + ').')); });
  });
}
async function push(serial, file, dst, want) {
  const r = await run(ADB, ['-s', serial, 'push', file, dst], 900000);
  if (r.err) throw new Error('Copying to the frame failed: ' + tail(r));
  if (want && (await devSha(serial, 'cat ' + dst)) !== want) throw new Error('A file copied to the frame does not match (' + path.basename(file) + '). Nothing was changed.');
}

// The boot pictures: the patch lists the byte ranges the two pictures occupy in a stock bootloader partition,
// what must be there now, and what goes there. Only those ranges change; the rest stays this unit's own.
function patchBootloader(buf, patch) {
  if (buf.length !== patch.size) return { ok: false, why: 'partition size differs' };
  let already = 0;
  for (const r of patch.ranges) {
    const cur = sha(buf.subarray(r.off, r.off + r.len)), neu = Buffer.from(r.new, 'base64');
    if (cur === sha(neu)) { already++; continue; }
    if (cur !== r.old) return { ok: false, why: 'the pictures are not where a stock frame keeps them (offset ' + r.off + ')' };
    neu.copy(buf, r.off);
  }
  return { ok: true, already: already === patch.ranges.length };
}

async function unitBackupDir(serial) { const d = path.join(DATA, 'backups', serial); fs.mkdirSync(d, { recursive: true }); return d; }

async function liveFlash(serial, rma) {
  needImages(['product', 'stock_product', 'env_new', 'bootlogo_patch']);
  // ---- look, and decide everything, before anything is written
  step(4, 'Backing up this unit...');
  if ((await sh(serial, 'id -u')) !== '0') throw new Error('This frame does not give full access over USB. Nothing was changed.');
  if (!(await sh(serial, 'dmctl table product_a | tail -1')).includes(REF.productTable)) throw new Error('This frame\'s storage layout is not the one the image was built for. Nothing was changed.');
  if ((await sh(serial, "grep -E '^product' /vendor/etc/fstab.sun50iw10p1 | grep -c avb")) !== '0') throw new Error('On this frame the product partition is under verified boot. Nothing was changed.');
  if ((await getprop(serial, 'ro.boot.slot_suffix')) !== '_a') throw new Error('This frame does not run from slot _a. Nothing was changed.');
  const newFile = imgPath('product'), newSha = await shaFile(newFile), newBlocks = fs.statSync(newFile).size / 4096;
  if (!Number.isInteger(newBlocks) || newBlocks > REF.productBlocks) throw new Error('The Salah OS image has the wrong size. Nothing was changed.');
  if ((await shaFile(imgPath('stock_product'))) !== REF.stockProduct) throw new Error('The original image kept for undo is not the right file. Nothing was changed.');

  let have = null;
  if ((await regionSha(serial, REF.productBlocks)) === REF.stockProduct) have = 'stock';
  else for (const k of [{ sha: newSha, blocks: newBlocks }].concat(REF.knownProducts)) if ((await regionSha(serial, k.blocks)) === k.sha) { have = k.sha === newSha ? 'current' : 'earlier Salah OS'; break; }
  if (!have) throw new Error('This frame carries a system image the flasher does not recognise. Nothing was changed.');
  log('   system image on the frame now: ' + have);

  const bdir = await unitBackupDir(serial);
  const blFile = path.join(bdir, 'bootloader_a.now.img'), envFile = path.join(bdir, 'env_a.now.img');
  await pull(serial, 'dd if=/dev/block/by-name/bootloader_a 2>/dev/null', blFile);
  await pull(serial, 'dd if=/dev/block/by-name/env_a 2>/dev/null', envFile);
  const bl = fs.readFileSync(blFile), env = fs.readFileSync(envFile);
  if (sha(bl) !== (await partSha(serial, 'bootloader_a')) || sha(env) !== (await partSha(serial, 'env_a'))) throw new Error('The copy of this unit\'s boot partitions does not match the frame. Nothing was changed.');
  // the first copy ever taken of a unit is its original; later runs must not overwrite it
  for (const [f, b] of [['bootloader_a.original.img', bl], ['env_a.original.img', env]]) if (!fs.existsSync(path.join(bdir, f))) fs.writeFileSync(path.join(bdir, f), b);
  if (have === 'stock' && !fs.existsSync(path.join(bdir, 'original.json'))) fs.writeFileSync(path.join(bdir, 'original.json'), JSON.stringify({ serial, at: new Date().toISOString(), disabledBefore: (await sh(serial, 'pm list packages -d', 30000)).split('\n').map(x => x.replace('package:', '').trim()).filter(Boolean) }, null, 1));
  fs.writeFileSync(path.join(bdir, 'info.json'), JSON.stringify({ serial, at: new Date().toISOString(), had: have, fingerprint: await getprop(serial, 'ro.build.fingerprint') }, null, 1));

  const patch = JSON.parse(fs.readFileSync(imgPath('bootlogo_patch'), 'utf8'));
  const blNew = Buffer.from(bl), pr = patchBootloader(blNew, patch);
  if (!pr.ok) throw new Error('Boot logo: ' + pr.why + '. Nothing was changed.');
  const envNew = fs.readFileSync(imgPath('env_new')), envSha = sha(env);
  const envTodo = envSha === sha(envNew) ? 'already' : envSha === REF.stockEnv ? 'write' : null;
  if (!envTodo) throw new Error('This frame\'s boot settings are not the stock ones the flasher knows. Nothing was changed.');
  log(`   plan: system image ${have === 'current' ? 'already current' : 'write'}; boot logo ${pr.already ? 'already in place' : 'write'}; backlight ${envTodo === 'already' ? 'already in place' : 'write'}`);

  // ---- copy to the frame and check the copies
  step(20, 'Installing Salah OS image...');
  const T = '/data/local/tmp/';
  await push(serial, imgPath('stock_product'), T + 'prod-stock.img', REF.stockProduct);
  if (have !== 'current') await push(serial, newFile, T + 'prod-new.img', newSha);
  const blNewFile = path.join(bdir, 'bootloader_a.new.img'); fs.writeFileSync(blNewFile, blNew);
  await push(serial, path.join(bdir, 'bootloader_a.original.img'), T + 'bl.orig.img');
  await push(serial, path.join(bdir, 'env_a.original.img'), T + 'env.orig.img');
  if (!pr.already) await push(serial, blNewFile, T + 'bl.new.img', sha(blNew));
  if (envTodo === 'write') await push(serial, imgPath('env_new'), T + 'env.new.img', sha(envNew));

  // ---- write, and read each one back
  const dd = `bs=4096 seek=${REF.productSeek} conv=notrunc`;
  if (have !== 'current') {
    await sh(serial, `dd if=${T}prod-new.img of=${REF.super} ${dd} 2>/dev/null; sync; echo 3 > /proc/sys/vm/drop_caches`);
    if ((await regionSha(serial, newBlocks)) !== newSha) { await undo(serial); throw new Error('The system image did not read back correctly. The frame\'s previous state was written back.'); }
    log('   system image written and read back');
    // Android keeps a parsed copy of every built-in app and trusts it while the app file's date is unchanged.
    // Files in the image all carry one fixed date, so without this Android would go on describing the OLD
    // Salah OS (version, screens, permissions) while running the new file. Clearing the copy makes it look again.
    await sh(serial, 'rm -rf /data/system/package_cache', 30000);
    log('   package cache cleared, so Android re-reads the built-in app on the next start');
  }
  step(55, 'Writing boot logo...');
  if (!pr.already) {
    await sh(serial, `dd if=${T}bl.new.img of=/dev/block/by-name/bootloader_a bs=1048576 2>/dev/null; sync; echo 3 > /proc/sys/vm/drop_caches`);
    if ((await partSha(serial, 'bootloader_a')) !== sha(blNew)) { await undo(serial); throw new Error('The boot logo did not read back correctly. The frame\'s previous state was written back.'); }
    log('   boot logo written and read back');
  }
  step(65, 'Writing boot settings...');
  if (envTodo === 'write') {
    await sh(serial, `dd if=${T}env.new.img of=/dev/block/by-name/env_a bs=4096 2>/dev/null; sync; echo 3 > /proc/sys/vm/drop_caches`);
    if ((await partSha(serial, 'env_a')) !== sha(envNew)) { await undo(serial); throw new Error('The boot settings did not read back correctly. The frame\'s previous state was written back.'); }
    log('   backlight setting written and read back');
  }

  // ---- restart, see what came up, check the hardware; a returned frame is erased last
  step(75, 'Rebooting frame...');
  await run(ADB, ['-s', serial, 'reboot']);
  await waitFor(async () => !(await adbDevices()).some(x => x.serial === serial && x.st === 'device'), 90000, 2000);
  step(84, 'Verifying installation...');
  let v = await verifyBoot(serial);
  if (!v.seen) {
    const d = (await adbDevices()).find(x => x.serial === serial);
    throw new Error(d ? 'The frame is on USB but not answering as before (' + d.st + '). Check its screen.' : 'The frame did not come back on USB after the restart. Check its screen; do not unplug it yet.');
  }
  if (!(v.app && v.home && v.owner && v.setupDone)) return v;
  v.checks = await hardwareChecks(serial);
  if (Object.values(v.checks).includes('FAIL')) return v;
  if (rma || CONFIG.resetAfterFlash) {
    step(92, 'Erasing customer data...');
    await sh(serial, 'am broadcast -a android.intent.action.FACTORY_RESET -p android --receiver-foreground');
    await waitFor(async () => !(await adbDevices()).some(x => x.serial === serial && x.st === 'device'), 90000, 2000);
    // A dev image reports back after the erase. A shipping image comes up with USB debugging off, by design.
    if (v.dev) { const v2 = await verifyBoot(serial); v2.checks = v.checks; v2.erased = true; return v2; }
    v.erased = true; v.afterErase = 'not readable (shipping image)';
  } else if (!v.dev) {
    // A shipping image leaves the workshop with USB debugging off. It was on only so the frame could be flashed.
    await sh(serial, 'settings put global adb_enabled 0', 20000); log('   shipping image: USB debugging switched off'); v.usbOff = true;
  }
  return v;
}

// ---- hardware checks: screen (the operator looks), touch (five targets on the frame), speaker (a test sound)
async function hardwareChecks(serial) {
  const res = {};
  const ask = async (q) => { const ok = await askCheck(q, serial); setState('FLASHING'); return ok ? 'pass' : 'FAIL'; };
  step(88, 'Checking the frame...');
  const vc = parseInt(((await sh(serial, 'dumpsys package com.paltech.salahos | grep -m1 versionCode', 30000)).match(/versionCode=(\d+)/) || [])[1] || '0', 10);
  const start = (what, nonce) => sh(serial, `am start -n com.paltech.salahos/.MainActivity --es selftest ${what}` + (nonce ? ` --es nonce ${nonce}` : ''), 30000);
  if (vc < 189) {            // an app from before the built-in checks: the operator answers instead
    log('   this frame\'s app (' + vc + ') has no built-in checks; asking instead');
    res.screen = await ask(CHECKS[0]); res.touch = await ask(CHECKS[1]); res.speaker = await ask(CHECKS[2]); return res;
  }
  if (vc >= 190) {           // solid colours on the frame, one touch each; the operator judges
    await start('screen');
    res.screen = await ask({ id: 'screen', title: 'Check the screen', body: 'Touch the frame to step through black, white, red, green and blue. Is every colour clean, with no dead pixels, lines or uneven areas?' });
    await start('stop');
  } else res.screen = await ask(CHECKS[0]);
  const F = '/data/data/com.paltech.salahos/files/selftest.json', nonce = Date.now().toString(36);
  await sh(serial, 'rm -f ' + F, 20000); await start('touch', nonce);
  setState('CONFIRM', { confirm: 'Touch the five targets on the frame\'s screen, one at a time.', serial });
  let r = null;
  await waitFor(async () => { try { const o = JSON.parse(await sh(serial, 'cat ' + F + ' 2>/dev/null', 15000)); if (o.nonce === nonce && o.test === 'touch') { r = o; return true; } } catch (e) { } return false; }, 100000, 1500);
  setState('FLASHING');
  res.touch = r && r.status === 'pass' ? 'pass' : 'FAIL';
  log('   touch: ' + res.touch + ' — ' + (r ? r.detail : 'no answer from the frame'));
  if (!r) await start('stop');
  let playing = true;
  (async () => { while (playing) { await start('sound'); for (let i = 0; i < 14 && playing; i++) await sleep(500); } })();
  res.speaker = await ask({ id: 'speaker', title: 'Check the speaker', body: 'The frame is playing a test sound. Is it loud and clear, with no rattle?' });
  playing = false; await start('stop');
  return res;
}

// Put a unit back: the stock system image and its own original boot partitions.
async function undo(serial) {
  const T = '/data/local/tmp/';
  await sh(serial, `[ -f ${T}prod-stock.img ] && dd if=${T}prod-stock.img of=${REF.super} bs=4096 seek=${REF.productSeek} conv=notrunc 2>/dev/null; [ -f ${T}bl.orig.img ] && dd if=${T}bl.orig.img of=/dev/block/by-name/bootloader_a bs=1048576 2>/dev/null; [ -f ${T}env.orig.img ] && dd if=${T}env.orig.img of=/dev/block/by-name/env_a bs=4096 2>/dev/null; sync; echo 3 > /proc/sys/vm/drop_caches`);
  const ok = (await regionSha(serial, REF.productBlocks)) === REF.stockProduct;
  log('   undo: stock system image ' + (ok ? 'verified' : 'NOT verified'));
  return ok;
}
async function restoreUnit() {
  const d = (await adbDevices()).find(x => x.st === 'device');
  if (!d) { log('restore: the frame is not answering on USB, so it cannot be restored from here.'); return; }
  if (DRY) { log('restore (dry run): would write the stock system image and this unit\'s original boot partitions back, then restart.'); return; }
  flashing = true; setState('FLASHING'); step(10, 'Restoring original software...');
  try {
    const bdir = await unitBackupDir(d.serial), T = '/data/local/tmp/';
    needImages(['stock_product']);
    await push(d.serial, imgPath('stock_product'), T + 'prod-stock.img', REF.stockProduct);
    for (const [f, t] of [['bootloader_a.original.img', 'bl.orig.img'], ['env_a.original.img', 'env.orig.img']]) if (fs.existsSync(path.join(bdir, f))) await push(d.serial, path.join(bdir, f), T + t);
    step(60, 'Restoring original software...');
    const ok = await undo(d.serial);
    if (ok) {
      // The software is back. Now take every trace of Salah OS out of the frame's own settings, so nothing of
      // ours is left behind: no trusted computer, no USB debugging, no owner record, none of our tweaks.
      let was = ['net.frameo.frame', 'com.yhk.qeota', 'com.softwinner.update', 'com.android.provision'];   // what our setup switches off on a stock frame
      try { const o = JSON.parse(fs.readFileSync(path.join(bdir, 'original.json'), 'utf8')); const off = new Set(o.disabledBefore || []); was = (await sh(d.serial, 'pm list packages -d', 30000)).split('\n').map(x => x.replace('package:', '').trim()).filter(x => x && !off.has(x)); } catch (e) { }
      log('   switching back on: ' + was.join(', '));   // the Android bar is NOT in this list: these frames ship with it off
      await sh(d.serial, was.map(p => 'pm enable ' + p).join('; '), 60000);
      await sh(d.serial, [
        'rm -f /data/system/device_owner_2.xml /data/system/device_policies.xml',              // Salah OS no longer owns the device (takes effect on restart)
        'rm -f /data/misc/adb/adb_keys /data/misc/adb/adb_temp_keys.xml',                      // no computer stays trusted
        'rm -rf /data/system/package_cache',                                                   // Android re-reads the built-in apps
        'rm -f /data/system/salahos_apk_id /data/local/salahos_setup_v1 /data/local/tmp/salahos-setup.log /data/system/users/0/wallpaper_info.xml',
        'rm -f /data/local/tmp/prod-stock.img /data/local/tmp/prod-new.img /data/local/tmp/bl.*.img /data/local/tmp/env.*.img',
        'settings delete global window_animation_scale; settings delete global transition_animation_scale; settings delete global animator_duration_scale',
        'settings delete secure enabled_accessibility_services; settings put secure accessibility_enabled 0; settings delete secure immersive_mode_confirmations',
        'settings put global development_settings_enabled 0'
      ].join('; '), 60000);
      log('   Salah OS traces removed; switching USB debugging off and restarting');
      await sh(d.serial, 'settings put global adb_enabled 0; sync; reboot', 20000);            // last: this ends our access
    } else await run(ADB, ['-s', d.serial, 'reboot']);
    record(d.serial, 'restore', ok ? 'ok' : 'unverified');
    flashing = false; setState(ok ? 'DONE' : 'ERROR', { serial: d.serial, reason: ok ? 'The original software is back on this frame and USB debugging is off. It is restarting; you can unplug it.' : 'The original image did not read back correctly. Do not unplug the frame; see Logs.' });
  } catch (e) { log('restore: ERROR — ' + e.message); flashing = false; setState('ERROR', { reason: e.message, serial: d.serial }); }
}

async function verifyBoot(serial) {
  const up = await waitFor(async () => (await adbDevices()).some(x => x.serial === serial && x.st === 'device'), 360000, 3000);
  if (!up) return { seen: false };
  await waitFor(async () => (await getprop(serial, 'sys.boot_completed')) === '1', 180000, 3000);
  await waitFor(async () => /\bdone\s*$/.test(await sh(serial, 'tail -1 /data/local/tmp/salahos-setup.log 2>/dev/null', 20000)), 90000, 3000);
  const lg = await sh(serial, 'tail -20 /data/local/tmp/salahos-setup.log 2>/dev/null', 20000);
  (lg || '(no setup log readable)').split('\n').forEach(l => log('   frame: ' + l));
  const pm = await sh(serial, 'pm path com.paltech.salahos', 30000);
  const home = await sh(serial, 'cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME | grep -m1 packageName', 30000);
  const owner = await sh(serial, 'dpm list-owners', 30000);
  const dev = (await sh(serial, 'ls /product/etc/salahos/dev 2>/dev/null', 20000)) !== '';
  const v = { seen: true, serial, app: /\/product\/app\/SalahOS\//.test(pm), setupDone: /\bdone\s*$/m.test(lg), home: /com\.paltech\.salahos/.test(home), owner: /com\.paltech\.salahos/.test(owner), dev };
  log('   result: ' + JSON.stringify(v));
  return v;
}

async function startFlash() {
  if (flashing) return;
  if (state !== 'READY' && state !== 'ERROR') { log('flash: ignored (not READY/ERROR)'); return; }
  flashing = true;
  setState('FLASHING');

  const serial = lastSerial || '<serial>';
  log(DRY ? '================  DRY RUN — the frame will NOT be modified  ================'
          : '================  LIVE FLASH  ================');

  const steps = planFor(serial);
  try {
    if (!DRY) {
      steps.forEach((s, i) => { log(`plan ${i + 1}/${steps.length}: ${s.label}`); });
      const v = await liveFlash(serial, isRma);
      send('progress', { pct: 100, label: 'Verifying installation...' });
      const res = { verify: v };
      const failed = Object.keys(v.checks || {}).filter(k => v.checks[k] === 'FAIL');
      flashing = false;
      if (!(v.app && v.home && v.owner && v.setupDone)) { record(serial, isRma ? 'rma' : 'new', 'verify-failed', res); setState('ERROR', { reason: 'The frame started, but Salah OS is not in place as expected (see Logs).', serial, canRestore: !!CONFIG.images.stock_product }); return; }
      if (failed.length) { record(serial, isRma ? 'rma' : 'new', 'check-failed', res); setState('ERROR', { reason: 'This frame failed its check: ' + failed.join(', ') + '. Set it aside.', serial, canRestore: !!CONFIG.images.stock_product }); return; }
      record(serial, isRma ? 'rma' : 'new', 'ok', res);
      setState('DONE', { serial, reason: v.afterErase ? 'All set. The frame is erasing itself and will show the Salah OS welcome page. You can unplug it then.' : '' });
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
ipcMain.on('restoreOriginal', () => { if (state === 'ERROR' && !flashing) restoreUnit(); });
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
