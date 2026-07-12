// ScreenShareP2P v0.2 — "nuklearna" arhitektura.
// No WebRTC media stack: WebCodecs hardware H.264 at a LOCKED constant
// bitrate, our own packetization + NACK retransmission, sent over UDP through
// our Go forwarder (single port). We control everything the estimator used to.

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------
const SERVER_HOST = '40.160.64.73';
const SERVER_PORT = 56969;
const NET_USER = 'pera';
const NET_PASS = 'promeniMe123';

const FRAG_SIZE = 1150; // payload bytes per packet (fits MTU with headers)

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const myIdInput = el('myId');
const remoteIdInput = el('remoteId');
const statusBox = el('status');
const logBox = el('log');
const shareBtn = el('shareBtn');
const stopBtn = el('stopBtn');
const connectBtn = el('connectBtn');
const remoteCanvas = el('remoteCanvas');
const canvasCtx = remoteCanvas.getContext('2d');
const localVideo = el('localVideo');
const placeholder = el('placeholder');
const pipWrap = el('pipWrap');
const picker = el('picker');
const sourceList = el('sourceList');

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logBox.textContent += `[${t}] ${msg}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setStatus(text, cls) {
  statusBox.textContent = text;
  statusBox.className = `status ${cls}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let myCode = '';
let peerPresent = false;

let localStream = null;
let pumping = false;
let pumpReader = null;
let encoder = null;
let sendFrameId = 0;
let frameCounter = 0;
let wantKey = false;
const sentRing = new Map(); // frameId -> frags[] (retransmission buffer)

let decoder = null;
let decoderCodec = null;
let lastDecoded = -1;
const pending = new Map(); // frameId -> {frags[], got, count, key, tsMs, t0, nacks}
const complete = new Map(); // frameId -> {data, key, tsMs, t0}
let maxSeenFrame = -1;

let e2eRtt = 0;
const stats = {
  outBytes: 0, outFrames: 0,
  inBytes: 0, inFrames: 0,
  nacksSent: 0, retx: 0,
  lastW: 0, lastH: 0
};

// ---------------------------------------------------------------------------
// Room / signaling over the forwarder
// ---------------------------------------------------------------------------
function shortId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  for (let i = 0; i < 6; i++) s += chars[rnd[i] % chars.length];
  return s;
}

async function initNet() {
  await window.net.start({ host: SERVER_HOST, port: SERVER_PORT, user: NET_USER, pass: NET_PASS });
  myCode = shortId();
  myIdInput.value = myCode;
  window.net.join(myCode);
  log(`Tvoj kod: ${myCode}`);
  setStatus('Spreman — pošalji svoj kod drugaru', 'ready');
  shareBtn.disabled = false;

  window.net.onEvent(onNetEvent);

  // E2E ping through the relay every 2s while paired.
  setInterval(() => {
    if (!peerPresent) return;
    const b = new Uint8Array(10);
    b[0] = 1; b[1] = 3;
    new DataView(b.buffer).setFloat64(2, performance.now());
    window.net.sendFrags([b], 'ctrl');
  }, 2000);
}

function onNetEvent(evt) {
  switch (evt.type) {
    case 'reg':
      if (evt.peerPresent && !peerPresent) {
        peerPresent = true;
        log('Drugar je u sobi.');
        setStatus('Povezan — možete da delite ekran', 'ready');
      }
      break;
    case 'peer-joined':
      peerPresent = true;
      log('Drugar se povezao ✓');
      setStatus('Povezan — možete da delite ekran', 'ready');
      break;
    case 'peer-left':
      peerPresent = false;
      log('Drugar je otišao.');
      clearRemote();
      setStatus('Drugar nije tu — čekam…', 'waiting');
      break;
    case 'data':
      for (const buf of evt.bufs) onPayload(buf);
      break;
    case 'pong':
      // server RTT available in evt.rtt if ever needed
      break;
    case 'error':
      log('Mrežna greška: ' + evt.message);
      break;
  }
}

connectBtn.addEventListener('click', () => {
  const code = remoteIdInput.value.trim().toLowerCase();
  if (!code) return;
  window.net.join(code);
  myIdInput.value = code;
  log(`Ulazim u sobu: ${code}`);
  setStatus('Čekam drugara u sobi…', 'waiting');
});

remoteIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

el('copyId').addEventListener('click', () => {
  navigator.clipboard.writeText(myIdInput.value);
  log('Kod kopiran.');
});

// ---------------------------------------------------------------------------
// Capture + encode (sender)
// ---------------------------------------------------------------------------
shareBtn.addEventListener('click', async () => {
  const sources = await window.desktop.getSources();
  sourceList.innerHTML = '';
  sources.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'source';
    div.innerHTML = `<img src="${s.thumbnail}" alt="" /><div class="name">${s.name}</div>`;
    div.addEventListener('click', () => {
      picker.classList.add('hidden');
      startCapture(s.id);
    });
    sourceList.appendChild(div);
  });
  picker.classList.remove('hidden');
});

el('pickerClose').addEventListener('click', () => picker.classList.add('hidden'));

async function startCapture(sourceId) {
  // The resolution preset is a HEIGHT cap; width follows the source's native
  // aspect ratio (ultrawide stays ultrawide — no stretching).
  const presetH = Number(el('res').value.split('x')[1]);
  const fps = Number(el('fps').value);

  try {
    // Capture at NATIVE size first (no width/height constraints).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: fps
        }
      }
    });

    localStream = stream;
    localVideo.srcObject = stream;
    localVideo.play().catch(() => {});
    pipWrap.classList.remove('hidden');
    shareBtn.disabled = true;
    stopBtn.disabled = false;

    const track = stream.getVideoTracks()[0];
    let st = track.getSettings();
    const natW = st.width, natH = st.height;
    log(`Izvor: ${natW}x${natH} (ratio ${(natW / natH).toFixed(2)})`);

    // Scale down to the preset height, keep ratio, force EVEN dimensions
    // (H.264 hardware encoders reject odd sizes).
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    let encH = Math.min(presetH, natH);
    let encW = even(encH * (natW / natH));
    encH = even(encH);
    if (encW !== natW || encH !== natH) {
      try {
        await track.applyConstraints({ width: encW, height: encH, frameRate: fps });
        st = track.getSettings();
        encW = even(st.width || encW);
        encH = even(st.height || encH);
      } catch (e) {
        log('Skaliranje nije uspelo (' + e.message + ') — šaljem native.');
        encW = even(natW);
        encH = even(natH);
      }
    }
    log(`Enkodiram: ${encW}x${encH} @ ${fps}fps`);
    track.addEventListener('ended', stopSharing);

    await startEncoder(track, encW, encH, fps);
  } catch (e) {
    log('Greška pri hvatanju ekrana: ' + e.message);
    setStatus('Greška pri hvatanju ekrana', 'error');
  }
}

let encCandidates = [];
let encCandidateIdx = 0;
let encDims = { w: 0, h: 0, fps: 60 };
let lastKeyTime = 0;
let skipCount = 0;
let encCount = 0;

function encoderConfigFor(c, bps) {
  return {
    codec: c.codec,
    hardwareAcceleration: c.hardwareAcceleration,
    width: encDims.w,
    height: encDims.h,
    framerate: encDims.fps,
    bitrate: bps,
    bitrateMode: 'constant',
    latencyMode: 'realtime',
    avc: { format: 'annexb' }
  };
}

async function startEncoder(track, w, h, fps) {
  const bps = Number(el('bitrate').value);
  window.net.setRate(bps);
  encDims = { w, h, fps };

  // Hardware H.264 first; software fallbacks after. High profile level 5.2
  // covers 4K60 (and ultrawide widths).
  const all = [
    { codec: 'avc1.640034', hardwareAcceleration: 'prefer-hardware' },
    { codec: 'avc1.64002A', hardwareAcceleration: 'prefer-hardware' },
    { codec: 'avc1.640034', hardwareAcceleration: 'no-preference' },
    { codec: 'avc1.42E034', hardwareAcceleration: 'no-preference' }
  ];
  encCandidates = [];
  for (const c of all) {
    try {
      const sup = await VideoEncoder.isConfigSupported(encoderConfigFor(c, bps));
      if (sup.supported) encCandidates.push(c);
    } catch { /* skip */ }
  }
  if (!encCandidates.length) {
    log('GREŠKA: nijedan H.264 enkoder nije podržan?!');
    setStatus('Enkoder nedostupan', 'error');
    return;
  }
  encCandidateIdx = 0;
  buildEncoder(bps);

  pumping = true;
  skipCount = 0;
  encCount = 0;
  const processor = new MediaStreamTrackProcessor({ track });
  pumpReader = processor.readable.getReader();
  (async () => {
    while (pumping) {
      const { value: frame, done } = await pumpReader.read().catch(() => ({ done: true }));
      if (done || !frame) break;
      if (peerPresent && encoder && encoder.state === 'configured' && encoder.encodeQueueSize <= 2) {
        const now = performance.now();
        const periodic = frameCounter % (encDims.fps * 4) === 0;
        const kf = periodic || (wantKey && now - lastKeyTime > 300);
        if (kf) { wantKey = false; lastKeyTime = now; }
        try { encoder.encode(frame, { keyFrame: kf }); encCount++; } catch { /* closing */ }
        frameCounter++;
      } else if (peerPresent) {
        skipCount++; // encoder busy -> frame dropped (visible in diagnostics)
      }
      frame.close();
    }
  })();

  setStatus('UŽIVO — šaljem (čekam statistiku…)', 'live');
}

function buildEncoder(bps) {
  const c = encCandidates[encCandidateIdx];
  encoder = new VideoEncoder({
    output: onEncodedChunk,
    error: (e) => {
      log(`Enkoder pao (${c.codec}/${c.hardwareAcceleration}): ${e.message}`);
      try { encoder.close(); } catch { /* already */ }
      // Auto-fallback to the next candidate (e.g. software) so sharing survives.
      if (encCandidateIdx + 1 < encCandidates.length && pumping) {
        encCandidateIdx++;
        log('Prebacujem na sledeći enkoder…');
        buildEncoder(Number(el('bitrate').value));
      } else {
        setStatus('Enkoder otkazao', 'error');
      }
    }
  });
  encoder.configure(encoderConfigFor(c, bps));
  decoderCodec = c.codec;
  wantKey = true;
  log(`Enkoder: ${c.codec} (${c.hardwareAcceleration}) · CBR ${(bps / 1e6).toFixed(0)} Mbps · ${encDims.w}x${encDims.h}`);
}

function onEncodedChunk(chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const id = sendFrameId++;
  const key = chunk.type === 'key';
  const tsMs = Math.max(0, Math.round(chunk.timestamp / 1000)) >>> 0;

  const count = Math.ceil(data.length / FRAG_SIZE) || 1;
  const frags = new Array(count);
  for (let i = 0; i < count; i++) {
    const slice = data.subarray(i * FRAG_SIZE, Math.min((i + 1) * FRAG_SIZE, data.length));
    const pkt = new Uint8Array(14 + slice.length);
    const dv = new DataView(pkt.buffer);
    pkt[0] = 0; // kind: video fragment
    dv.setUint32(1, id);
    dv.setUint16(5, i);
    dv.setUint16(7, count);
    pkt[9] = key ? 1 : 0;
    dv.setUint32(10, tsMs);
    pkt.set(slice, 14);
    frags[i] = pkt;
  }

  sentRing.set(id, frags);
  if (sentRing.size > 180) {
    const oldest = sentRing.keys().next().value;
    sentRing.delete(oldest);
  }
  window.net.sendFrags(frags, false);
  stats.outBytes += data.length;
  stats.outFrames++;
}

function stopSharing() {
  pumping = false;
  if (pumpReader) { pumpReader.cancel().catch(() => {}); pumpReader = null; }
  if (encoder) { try { encoder.close(); } catch { /* already */ } encoder = null; }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  sentRing.clear();
  localVideo.srcObject = null;
  pipWrap.classList.add('hidden');
  shareBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus(peerPresent ? 'Povezan — deljenje zaustavljeno' : 'Deljenje zaustavljeno', 'ready');
  log('Deljenje zaustavljeno.');
}

stopBtn.addEventListener('click', stopSharing);

// Live bitrate/FPS changes: reconfigure the running encoder in place.
['bitrate', 'fps'].forEach((id) => {
  el(id).addEventListener('change', () => {
    const bps = Number(el('bitrate').value);
    window.net.setRate(bps);
    if (encoder && encoder.state === 'configured') {
      try {
        encDims.fps = Number(el('fps').value);
        encoder.configure(encoderConfigFor(encCandidates[encCandidateIdx], bps));
        wantKey = true;
        log(`CBR promenjen: ${(bps / 1e6).toFixed(0)} Mbps`);
      } catch (e) {
        log('Reconfigure nije uspeo: ' + e.message);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Receive path: reassemble -> order -> decode -> canvas
// ---------------------------------------------------------------------------
function onPayload(buf) {
  if (!buf || buf.length < 1) return;
  if (buf[0] === 0) onVideoFrag(buf);
  else if (buf[0] === 1) onCtrl(buf);
}

function onVideoFrag(buf) {
  if (buf.length < 14) return;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frameId = dv.getUint32(1);
  const fragIdx = dv.getUint16(5);
  const count = dv.getUint16(7);
  const key = buf[9] === 1;
  const tsMs = dv.getUint32(10);
  const payload = buf.subarray(14);

  stats.inBytes += payload.length;
  if (frameId > maxSeenFrame) maxSeenFrame = frameId;
  if (frameId <= lastDecoded || complete.has(frameId)) return; // stale/dup

  let entry = pending.get(frameId);
  if (!entry) {
    entry = { frags: new Array(count), got: 0, count, key, tsMs, t0: performance.now(), nacks: 0 };
    pending.set(frameId, entry);
  }
  if (fragIdx < entry.count && !entry.frags[fragIdx]) {
    entry.frags[fragIdx] = payload;
    entry.got++;
  }
  if (entry.key) entry.key = entry.key || key;

  if (entry.got === entry.count) {
    pending.delete(frameId);
    let total = 0;
    for (const f of entry.frags) total += f.length;
    const data = new Uint8Array(total);
    let off = 0;
    for (const f of entry.frags) { data.set(f, off); off += f.length; }
    complete.set(frameId, { data, key: entry.key, tsMs: entry.tsMs, t0: entry.t0 });
    tryDeliver();
  }
}

function ensureDecoder() {
  if (decoder && decoder.state === 'configured') return;
  decoder = new VideoDecoder({
    output: onDecodedFrame,
    error: (e) => {
      log('Dekoder greška: ' + e.message + ' — resetujem');
      try { decoder.close(); } catch { /* already */ }
      decoder = null;
      lastDecoded = -1;
      requestKeyframe();
    }
  });
  decoder.configure({ codec: decoderCodec || 'avc1.640034', optimizeForLatency: true });
}

function tryDeliver() {
  ensureDecoder();
  let progressed = true;
  while (progressed) {
    progressed = false;
    if (lastDecoded === -1) {
      // Need a keyframe to start (or restart after reset).
      let bestKey = -1;
      for (const [id, f] of complete) if (f.key && id > bestKey) bestKey = id;
      if (bestKey !== -1) {
        decodeFrame(bestKey);
        // Everything older is useless now.
        for (const id of [...complete.keys()]) if (id < bestKey) complete.delete(id);
        for (const id of [...pending.keys()]) if (id < bestKey) pending.delete(id);
        progressed = true;
      }
    } else if (complete.has(lastDecoded + 1)) {
      decodeFrame(lastDecoded + 1);
      progressed = true;
    } else {
      // If we're stuck but a newer KEYFRAME is ready, jump to it.
      let jump = -1;
      for (const [id, f] of complete) if (f.key && id > lastDecoded && id > jump) jump = id;
      if (jump !== -1 && complete.get(jump).t0 + 120 < performance.now()) {
        for (const id of [...complete.keys()]) if (id < jump) complete.delete(id);
        for (const id of [...pending.keys()]) if (id < jump) pending.delete(id);
        decodeFrame(jump);
        progressed = true;
      }
    }
  }
}

function decodeFrame(id) {
  const f = complete.get(id);
  complete.delete(id);
  try {
    decoder.decode(new EncodedVideoChunk({
      type: f.key ? 'key' : 'delta',
      timestamp: f.tsMs * 1000,
      data: f.data
    }));
    lastDecoded = id;
  } catch (e) {
    log('decode(): ' + e.message);
    lastDecoded = -1;
    requestKeyframe();
  }
}

function onDecodedFrame(frame) {
  if (remoteCanvas.width !== frame.displayWidth || remoteCanvas.height !== frame.displayHeight) {
    remoteCanvas.width = frame.displayWidth;
    remoteCanvas.height = frame.displayHeight;
  }
  canvasCtx.drawImage(frame, 0, 0);
  frame.close();
  stats.inFrames++;
  stats.lastW = remoteCanvas.width;
  stats.lastH = remoteCanvas.height;
  if (!placeholder.classList.contains('hidden')) placeholder.classList.add('hidden');
}

function clearRemote() {
  canvasCtx.clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
  placeholder.classList.remove('hidden');
  pending.clear();
  complete.clear();
  lastDecoded = -1;
  maxSeenFrame = -1;
}

// ---------------------------------------------------------------------------
// Loss recovery: fragment NACKs, then keyframe request as the big hammer
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = performance.now();
  // Thresholds must exceed RTT + pacing jitter, otherwise we NACK packets
  // that are still in flight and flood the link with pointless retransmits.
  const rtt = e2eRtt || 80;
  const suspectAge = Math.max(90, rtt * 1.5 + 40);
  const renackGap = Math.max(70, rtt);
  for (const [id, entry] of pending) {
    const age = now - entry.t0;
    const newerArrived = id < maxSeenFrame;
    if (!(newerArrived && age > suspectAge * 0.6) && age < suspectAge) continue;
    if (entry.lastNack && now - entry.lastNack < renackGap) continue;
    if (entry.nacks >= 3) {
      pending.delete(id);
      requestKeyframe();
      continue;
    }
    const missing = [];
    for (let i = 0; i < entry.count && missing.length < 200; i++) {
      if (!entry.frags[i]) missing.push(i);
    }
    if (!missing.length) continue;
    entry.nacks++;
    entry.lastNack = now;
    stats.nacksSent += missing.length;
    const b = new Uint8Array(8 + missing.length * 2);
    const dv = new DataView(b.buffer);
    b[0] = 1; b[1] = 1; // ctrl: NACK
    dv.setUint32(2, id);
    dv.setUint16(6, missing.length);
    missing.forEach((m, i) => dv.setUint16(8 + i * 2, m));
    window.net.sendFrags([b], 'ctrl');
  }
  // Hard stall: nothing decoded recently while data flows -> keyframe.
  if (lastDecoded !== -1 && maxSeenFrame > lastDecoded + 60) requestKeyframe();
}, 30);

let lastKeyReq = 0;
function requestKeyframe() {
  const now = performance.now();
  if (now - lastKeyReq < 1000) return;
  lastKeyReq = now;
  window.net.sendFrags([new Uint8Array([1, 2])], 'ctrl');
}

function onCtrl(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (buf[1]) {
    case 1: { // NACK -> retransmit from ring (metered: front of the paced queue)
      if (buf.length < 8) return;
      const frameId = dv.getUint32(2);
      const n = dv.getUint16(6);
      const frags = sentRing.get(frameId);
      if (!frags) return;
      const out = [];
      for (let i = 0; i < n && 8 + i * 2 + 2 <= buf.length; i++) {
        const idx = dv.getUint16(8 + i * 2);
        if (frags[idx]) out.push(frags[idx]);
      }
      if (out.length) {
        stats.retx += out.length;
        window.net.sendFrags(out, 'front');
      }
      break;
    }
    case 2: // keyframe request
      wantKey = true;
      break;
    case 3: { // e2e ping -> echo as pong
      const echo = new Uint8Array(buf);
      echo[1] = 4;
      window.net.sendFrags([echo], 'ctrl');
      break;
    }
    case 4: // e2e pong
      if (buf.length >= 10) e2eRtt = Math.round(performance.now() - dv.getFloat64(2));
      break;
  }
}

// ---------------------------------------------------------------------------
// Stats HUD (1s)
// ---------------------------------------------------------------------------
setInterval(() => {
  const inMbps = (stats.inBytes * 8 / 1e6).toFixed(1);
  const outMbps = (stats.outBytes * 8 / 1e6).toFixed(1);
  const parts = [];
  if (stats.inFrames > 0) {
    parts.push(`⇣ gledaš ${stats.lastW}×${stats.lastH} @ ${stats.inFrames}fps · ${inMbps} Mbps`);
  }
  if (stats.outFrames > 0) {
    parts.push(`⇡ šalješ ${encDims.w}×${encDims.h} @ ${stats.outFrames}fps · ${outMbps} Mbps`);
  }
  // Encoder starvation diagnostics: if we skip frames, the encoder can't keep
  // up (usually = software fallback) — say it out loud instead of just lagging.
  if (pumping && skipCount > encCount && skipCount > 10) {
    log(`⚠ Enkoder guši: ${skipCount} preskočenih / ${encCount} enkodiranih frejmova u poslednjoj sekundi`);
  }
  skipCount = 0;
  encCount = 0;
  if (parts.length) {
    const extra = e2eRtt ? ` · ping ${e2eRtt}ms` : '';
    const lossTxt = stats.nacksSent ? ` · retx ${stats.nacksSent}` : '';
    setStatus(parts.join(' | ') + extra + lossTxt, 'live');
  }
  stats.inBytes = stats.outBytes = 0;
  stats.inFrames = stats.outFrames = 0;
  stats.nacksSent = 0;

  // GC stale partial frames (>2s old).
  const now = performance.now();
  for (const [id, e] of pending) if (now - e.t0 > 2000) pending.delete(id);
  for (const [id, f] of complete) if (now - f.t0 > 2000) complete.delete(id);
}, 1000);

// ---------------------------------------------------------------------------
initNet();
