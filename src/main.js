const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const dgram = require('dgram');
const path = require('path');

// Unlock hardware video encoding on GPUs that Chromium's blocklist would
// otherwise force to software (the #1 cause of choppy 60fps capture).
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let win = null;

// ---------------------------------------------------------------------------
// UDP networking (custom ScreenShare protocol -> our Go forwarder).
// The renderer does media (capture/encode/decode); this process owns the
// socket, keepalives, and a token-bucket pacer that smooths bursts so a big
// keyframe doesn't machine-gun 200 packets into the network at once.
// ---------------------------------------------------------------------------
const MAGIC = 0xc5;

let sock = null;
let serverHost = null;
let serverPort = 0;
let creds = { user: '', pass: '' };
let room = null;

let dataQ = []; // media packets (paced)
let ctrlQ = []; // NACK/keyframe/ping packets (priority)
let rateBps = 15_000_000;
let paceTimer = null;
let regTimer = null;

let rxBatch = [];
let rxFlush = null;

function sendEvt(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('net-evt', evt);
}

function buildReg() {
  const u = Buffer.from(creds.user, 'utf8');
  const p = Buffer.from(creds.pass, 'utf8');
  const r = Buffer.from(room || '', 'utf8');
  return Buffer.concat([
    Buffer.from([MAGIC, 0x01, u.length]), u,
    Buffer.from([p.length]), p,
    Buffer.from([r.length]), r
  ]);
}

function netStart(cfg) {
  netStop();
  serverHost = cfg.host;
  serverPort = cfg.port;
  creds = { user: cfg.user, pass: cfg.pass };

  sock = dgram.createSocket('udp4');
  sock.on('message', (msg) => {
    if (msg.length < 2 || msg[0] !== MAGIC) return;
    switch (msg[1]) {
      case 0x02:
        sendEvt({ type: 'reg', peerPresent: msg.length > 2 && msg[2] === 1 });
        break;
      case 0x03:
        sendEvt({ type: 'peer-joined' });
        break;
      case 0x04:
        sendEvt({ type: 'peer-left' });
        break;
      case 0x10: {
        // Batch inbound media packets; flush to the renderer every few ms so
        // IPC overhead stays negligible even at thousands of packets/sec.
        rxBatch.push(msg.subarray(2));
        if (!rxFlush) {
          rxFlush = setTimeout(() => {
            const b = rxBatch;
            rxBatch = [];
            rxFlush = null;
            sendEvt({ type: 'data', bufs: b });
          }, 4);
        }
        break;
      }
      case 0x21:
        if (msg.length >= 10) {
          sendEvt({ type: 'pong', rtt: Date.now() - Number(msg.readBigUInt64BE(2)) });
        }
        break;
    }
  });
  sock.on('error', (e) => sendEvt({ type: 'error', message: String(e) }));
  sock.bind(() => {
    try {
      sock.setRecvBufferSize(8 << 20);
      sock.setSendBufferSize(8 << 20);
    } catch { /* best effort */ }
  });

  // Keepalive: re-register + ping every 2s (refreshes NAT + presence).
  regTimer = setInterval(() => {
    if (!sock) return;
    if (room) sock.send(buildReg(), serverPort, serverHost);
    const ping = Buffer.alloc(10);
    ping[0] = MAGIC;
    ping[1] = 0x20;
    ping.writeBigUInt64BE(BigInt(Date.now()), 2);
    sock.send(ping, serverPort, serverHost);
  }, 2000);

  // Pacer: drain the queues with a byte budget derived from the configured
  // bitrate (x1.7 headroom so NACK retransmits fit). The budget scales with
  // the REAL elapsed time between ticks — setInterval jitter (common on
  // Windows) then can't silently throttle throughput.
  let carry = 0;
  let lastTick = Date.now();
  paceTimer = setInterval(() => {
    if (!sock) return;
    const now = Date.now();
    const dt = Math.min(0.05, (now - lastTick) / 1000); // cap burst at 50ms worth
    lastTick = now;
    while (ctrlQ.length) sock.send(ctrlQ.shift(), serverPort, serverHost);
    // Modest 1.2x headroom: enough for retransmits, but can't quietly push a
    // 15 Mbps target to 25+ and drown a 20 Mbps uplink (bufferbloat).
    let budget = (rateBps * 1.2 * dt) / 8 + carry;
    while (dataQ.length && budget >= dataQ[0].length) {
      const pkt = dataQ.shift();
      budget -= pkt.length;
      sock.send(pkt, serverPort, serverHost);
    }
    // Cap leftover budget so idle periods can't bank an unlimited burst.
    carry = Math.min(budget, 64 * 1024);
    // Safety valve: if the queue backs up past ~1s of data, drop oldest.
    const maxQ = (rateBps / 8) | 0;
    let qBytes = 0;
    for (const p of dataQ) qBytes += p.length;
    while (qBytes > maxQ && dataQ.length) qBytes -= dataQ.shift().length;
  }, 3);
}

function netStop() {
  if (regTimer) clearInterval(regTimer);
  if (paceTimer) clearInterval(paceTimer);
  regTimer = paceTimer = null;
  if (sock) {
    try { sock.close(); } catch { /* already closed */ }
  }
  sock = null;
  dataQ = [];
  ctrlQ = [];
  room = null;
}

ipcMain.handle('net-start', (e, cfg) => {
  netStart(cfg);
  return true;
});

ipcMain.on('net-join', (e, code) => {
  room = String(code || '').trim();
  if (sock && room) sock.send(buildReg(), serverPort, serverHost);
});

ipcMain.on('net-rate', (e, bps) => {
  rateBps = Math.max(1_000_000, Number(bps) || rateBps);
});

// frags: array of Uint8Array (media or ctrl payloads). Wrapped as DATA here.
// mode: 'ctrl' = tiny control msgs (sent immediately, unmetered),
//       'front' = retransmits (metered, but jump the queue),
//       default = media (metered, FIFO).
ipcMain.on('net-frags', (e, frags, mode) => {
  if (!sock) return;
  const pkts = frags.map((f) => Buffer.concat([Buffer.from([MAGIC, 0x10]), Buffer.from(f)]));
  if (mode === 'ctrl') ctrlQ.push(...pkts);
  else if (mode === 'front') dataQ.unshift(...pkts);
  else dataQ.push(...pkts);
});

// ---------------------------------------------------------------------------
// Window + screen capture sources
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0e0f13',
    title: 'ScreenShareP2P',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

// GPU diagnostics — the app log shows whether video encode is hardware.
ipcMain.handle('gpu-status', () => {
  try {
    const st = app.getGPUFeatureStatus();
    return { encode: st.video_encode, compositing: st.gpu_compositing };
  } catch (e) {
    return { encode: 'unknown', compositing: String(e) };
  }
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null
  }));
});

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        callback({ video: sources[0] });
      });
    },
    { useSystemPicker: false }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  netStop();
  if (process.platform !== 'darwin') app.quit();
});
