/* global Peer */

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
const remoteVideo = el('remoteVideo');
const localVideo = el('localVideo');
const placeholder = el('placeholder');
const pipWrap = el('pipWrap');
const picker = el('picker');
const sourceList = el('sourceList');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let peer = null;
let localStream = null;
let activeCalls = new Map(); // peerId -> MediaConnection
let remotePeerId = null;

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
// PeerJS setup — free public broker + STUN + fallback TURN
// ---------------------------------------------------------------------------
function shortId() {
  // Human-friendly 6-char code from the alphabet minus ambiguous chars.
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  for (let i = 0; i < 6; i++) s += chars[rnd[i] % chars.length];
  return s;
}

function initPeer() {
  const id = shortId();
  peer = new Peer(id, {
    debug: 1,
    config: {
      // Clean STUN-only set. Dead TURN entries were stalling ICE in "checking"
      // and dragging it to "disconnected". Give the direct path a clean shot.
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      iceCandidatePoolSize: 4
    }
  });

  peer.on('open', (openId) => {
    myIdInput.value = openId;
    setStatus('Spreman — pošalji svoj kod drugaru', 'ready');
    shareBtn.disabled = false;
    log(`Tvoj kod: ${openId}`);
  });

  // Someone is sharing their screen to us.
  peer.on('call', (call) => {
    log(`Dolazni poziv od ${call.peer}`);
    remotePeerId = remotePeerId || call.peer;
    call.answer(); // we answer as a viewer (no outgoing stream required)
    wireIncoming(call);
  });

  peer.on('error', (err) => {
    log(`GREŠKA: ${err.type} — ${err.message}`);
    if (err.type === 'unavailable-id') {
      // Extremely rare collision — reinit with a new code.
      setStatus('Kod zauzet, generišem novi…', 'waiting');
      peer.destroy();
      initPeer();
    } else if (err.type === 'peer-unavailable') {
      setStatus('Drugar nije dostupan (proveri kod)', 'error');
    } else {
      setStatus(`Greška: ${err.type}`, 'error');
    }
  });

  peer.on('disconnected', () => {
    setStatus('Signaling prekinut, ponovo se povezujem…', 'waiting');
    peer.reconnect();
  });
}

// Display an incoming remote stream.
function wireIncoming(call) {
  activeCalls.set(call.peer, call);
  call.on('stream', (stream) => showRemote(call, stream));
  call.on('close', () => {
    log(`Veza sa ${call.peer} zatvorena.`);
    if (remoteVideo.srcObject) {
      remoteVideo.srcObject = null;
      placeholder.classList.remove('hidden');
    }
    stopStats();
    setStatus('Veza zatvorena', 'ready');
    activeCalls.delete(call.peer);
  });
  call.on('error', (e) => log(`Greška poziva: ${e}`));
}

// Show a received remote stream + run on-screen diagnostics.
function showRemote(call, stream) {
  remoteVideo.srcObject = stream;
  placeholder.classList.add('hidden');
  // Explicit play() — Electron autoplay policy can leave it paused (black).
  remoteVideo.play().catch((e) => log('play() blokiran: ' + e.message));
  log(`Stream primljen (${stream.getVideoTracks().length} video track).`);
  withPC(call, (pc) => {
    monitorPC(pc, 'prijem');
    startStats(pc);
  });
}

// Wait until PeerJS has created the RTCPeerConnection, then run cb.
function withPC(call, cb, tries = 0) {
  const pc = call.peerConnection;
  if (pc) return cb(pc);
  if (tries > 60) return log('RTCPeerConnection nije napravljen.');
  setTimeout(() => withPC(call, cb, tries + 1), 100);
}

// Log ICE/connection state so we can see WHERE it breaks.
function monitorPC(pc, role) {
  pc.addEventListener('iceconnectionstatechange', () => {
    const st = pc.iceConnectionState;
    log(`ICE (${role}): ${st}`);
    if (st === 'connected' || st === 'completed') {
      log('✓ DIREKTNA VEZA uspostavljena!');
    } else if (st === 'failed') {
      setStatus('Direktna veza nije uspela — mreža blokira P2P', 'error');
    }
  });
}

// Every second, read inbound video stats → tells us capture-vs-network.
let statsTimer = null;
function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}
function startStats(pc) {
  stopStats();
  let lastBytes = 0;
  let lastTs = 0;
  let zeroCount = 0;
  statsTimer = setInterval(async () => {
    let stats;
    try {
      stats = await pc.getStats();
    } catch {
      return;
    }
    stats.forEach((r) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      const mbps =
        lastTs && r.timestamp > lastTs
          ? (((r.bytesReceived - lastBytes) * 8) / (r.timestamp - lastTs) / 1000).toFixed(1)
          : '…';
      lastBytes = r.bytesReceived;
      lastTs = r.timestamp;
      const fps = r.framesPerSecond != null ? Math.round(r.framesPerSecond) : 0;

      if (r.frameWidth && r.framesReceived > 0) {
        // Frames ARE arriving → connection + capture OK.
        setStatus(`UŽIVO — ${r.frameWidth}×${r.frameHeight} @ ${fps}fps · ${mbps} Mbps`, 'live');
      } else {
        // Stream exists but no pixels → almost always network/TURN.
        zeroCount++;
        setStatus(
          zeroCount > 4
            ? '⚠ Nema video frejmova — mreža blokira P2P (TURN problem)'
            : 'Povezivanje video toka…',
          zeroCount > 4 ? 'error' : 'waiting'
        );
      }
    });
  }, 1000);
}

// ---------------------------------------------------------------------------
// Connect to a friend (store their code; media call does the rest)
// ---------------------------------------------------------------------------
connectBtn.addEventListener('click', () => {
  const id = remoteIdInput.value.trim();
  if (!id) return;
  remotePeerId = id;
  setStatus(`Povezan sa ${id} — možeš da deliš ekran`, 'ready');
  log(`Postavljen drugar: ${id}`);
  // If we're already sharing, immediately start streaming to them too.
  if (localStream) startCall(id);
});

// ---------------------------------------------------------------------------
// Screen capture + high-quality tuning
// ---------------------------------------------------------------------------
shareBtn.addEventListener('click', async () => {
  const sources = await window.desktop.getSources();
  renderPicker(sources);
});

function renderPicker(sources) {
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
}

el('pickerClose').addEventListener('click', () => picker.classList.add('hidden'));

async function startCapture(sourceId) {
  const [w, h] = el('res').value.split('x').map(Number);
  const fps = Number(el('fps').value);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          // Only cap the size (no min): forcing an exact resolution can make
          // macOS capture return black frames.
          maxWidth: w,
          maxHeight: h,
          maxFrameRate: fps
        }
      }
    });

    // Optionally add microphone audio.
    if (el('mic').checked) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic.getAudioTracks().forEach((t) => stream.addTrack(t));
        log('Mikrofon dodat.');
      } catch (e) {
        log('Mikrofon nije dostupan: ' + e.message);
      }
    }

    // Content hint helps the encoder: "text" = sharp, "motion" = smooth.
    const mode = el('mode').value;
    stream.getVideoTracks().forEach((t) => {
      t.contentHint = mode === 'text' ? 'detail' : 'motion';
    });

    localStream = stream;
    localVideo.srcObject = stream;
    localVideo.play().catch(() => {});
    pipWrap.classList.remove('hidden');
    shareBtn.disabled = true;
    stopBtn.disabled = false;
    const s = stream.getVideoTracks()[0].getSettings();
    log(`Hvatam: ${s.width || '?'}x${s.height || '?'} @ ${Math.round(s.frameRate) || '?'}fps (${mode})`);
    log('↳ Ako je tvoj mali preview (dole desno) crn, problem je snimanje ekrana/dozvola.');

    // If a friend code is set, start streaming to them.
    if (remotePeerId) startCall(remotePeerId);
    else log('Ukucaj kod drugara i klikni „Poveži" da počne prenos.');

    // Stop cleanly if the user ends capture from the OS.
    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);
  } catch (e) {
    log('Greška pri hvatanju ekrana: ' + e.message);
    setStatus('Greška pri hvatanju ekrana', 'error');
  }
}

function startCall(id) {
  if (!localStream) return;
  const call = peer.call(id, localStream);
  activeCalls.set(id, call);
  // The other side may also be sharing back to us on this same call.
  call.on('stream', (stream) => showRemote(call, stream));
  call.on('error', (e) => log('Greška poziva: ' + e));

  withPC(call, (pc) => monitorPC(pc, 'slanje'));
  applyQuality(call);
  setStatus('Šaljem ekran drugaru…', 'live');
  log(`Zovem ${id} sa mojim ekranom.`);
}

// Override WebRTC's conservative defaults to push high quality.
function applyQuality(call) {
  const maxBitrate = Number(el('bitrate').value);
  const fps = Number(el('fps').value);
  const mode = el('mode').value;

  const tune = () => {
    const pc = call.peerConnection;
    if (!pc) return setTimeout(tune, 200);
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return setTimeout(tune, 200);

    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = fps;
    // Sharp text vs smooth motion trade-off when bandwidth is tight.
    params.degradationPreference =
      mode === 'text' ? 'maintain-resolution' : 'maintain-framerate';

    sender
      .setParameters(params)
      .then(() => log(`Kvalitet postavljen: ${(maxBitrate / 1e6).toFixed(0)} Mbps @ ${fps}fps`))
      .catch((e) => log('setParameters greška: ' + e.message));
  };
  tune();
}

function stopSharing() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  activeCalls.forEach((c, id) => {
    if (c) c.close();
  });
  localVideo.srcObject = null;
  pipWrap.classList.add('hidden');
  shareBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Deljenje zaustavljeno', 'ready');
  log('Deljenje zaustavljeno.');
}

stopBtn.addEventListener('click', stopSharing);

// ---------------------------------------------------------------------------
// Misc UI
// ---------------------------------------------------------------------------
el('copyId').addEventListener('click', () => {
  navigator.clipboard.writeText(myIdInput.value);
  log('Kod kopiran.');
});

remoteIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

// Live-adjust bitrate/fps on already-running calls.
['bitrate', 'fps', 'mode'].forEach((id) => {
  el(id).addEventListener('change', () => {
    activeCalls.forEach((c) => c && c.peerConnection && applyQuality(c));
  });
});

// ---------------------------------------------------------------------------
initPeer();
