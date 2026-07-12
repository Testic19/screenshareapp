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
      // Google STUN first (tries a free DIRECT connection for best quality),
      // then OUR own TURN relay (Pterodactyl) as the guaranteed fallback.
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // --- Naš server (screenshare-turn na Pterodactylu) ---
        { urls: 'stun:40.160.64.73:56969' },
        { urls: 'turn:40.160.64.73:56969?transport=udp', username: 'pera', credential: 'promeniMe123' },
        { urls: 'turn:40.160.64.73:56969?transport=tcp', username: 'pera', credential: 'promeniMe123' }
      ]
      // NB: no iceCandidatePoolSize — pooling would pre-open several TURN
      // allocations per connection and exhaust the relay port range.
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
    // Replace any previous call with this peer — one connection at a time.
    const existing = activeCalls.get(call.peer);
    if (existing) existing.close();
    // Answer WITH our stream when we're sharing: both directions ride ONE
    // connection (half the TURN allocations of two separate calls).
    call.answer(localStream || undefined, { sdpTransform: sdpBoost });
    if (localStream) log('Odgovaram sa svojim ekranom (dvosmerna veza).');
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
  call.on('close', () => handleCallClose(call));
  call.on('error', (e) => log(`Greška poziva: ${e}`));
}

// Shared close handling: clean up only if this call is still the active one,
// then try to re-establish automatically if we're still sharing.
function handleCallClose(call) {
  log(`Veza sa ${call.peer} zatvorena.`);
  if (activeCalls.get(call.peer) === call) activeCalls.delete(call.peer);
  // Clear the video only if it was THIS call's stream (a replacement call may
  // already be showing a new one).
  if (remoteVideo.srcObject && call._stream === remoteVideo.srcObject) {
    remoteVideo.srcObject = null;
    placeholder.classList.remove('hidden');
    stopStats();
    setStatus('Veza zatvorena', 'ready');
  }
  scheduleReconnect(call.peer);
}

// Auto-reconnect: if we're still sharing and no replacement call appeared,
// call again after a short randomized delay (jitter avoids both sides
// re-calling at the exact same moment).
function scheduleReconnect(id) {
  setTimeout(() => {
    if (localStream && remotePeerId === id && !activeCalls.has(id)) {
      log('Ponovno povezivanje…');
      startCall(id);
    }
  }, 1000 + Math.random() * 1500);
}

// Show a received remote stream + run on-screen diagnostics.
function showRemote(call, stream) {
  call._stream = stream;
  remoteVideo.srcObject = stream;
  placeholder.classList.add('hidden');
  // Explicit play() — Electron autoplay policy can leave it paused (black).
  remoteVideo.play().catch((e) => log('play() blokiran: ' + e.message));
  log(`Stream primljen (${stream.getVideoTracks().length} video track).`);
  withPC(call, (pc) => {
    monitorPC(pc, 'prijem');
    applySmoothness(pc);
    startStats(pc);
  });
}

// TURBO #3: a small receive-side buffer irons out network jitter and NACK
// round-trips before display — micro-stutters vanish for ~120ms of latency.
// "Tekst/Kod" mode keeps it tighter (sharper interaction, latency matters).
function applySmoothness(pc) {
  const hint = el('mode').value === 'text' ? 0.06 : 0.12;
  pc.getReceivers().forEach((r) => {
    try { r.playoutDelayHint = hint; } catch { /* unsupported */ }
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
      log('✓ VEZA uspostavljena!');
      logSelectedPair(pc);
    } else if (st === 'failed') {
      setStatus('Direktna veza nije uspela — mreža blokira P2P', 'error');
    }
  });
}

// Show which addresses actually connected (confirms Tailscale 100.x usage).
async function logSelectedPair(pc) {
  try {
    const stats = await pc.getStats();
    let pairId = null;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (r.id === pairId || r.selected)) {
        const local = stats.get(r.localCandidateId);
        const remote = stats.get(r.remoteCandidateId);
        if (local && remote) {
          log(`↳ Putanja: ${local.address} (${local.candidateType}) → ${remote.address} (${remote.candidateType})`);
        }
      }
    });
    // Which codec actually won the negotiation? (H264 = hardware path)
    setTimeout(async () => {
      try {
        const s2 = await pc.getStats();
        s2.forEach((r) => {
          if ((r.type === 'outbound-rtp' || r.type === 'inbound-rtp') && r.kind === 'video' && r.codecId) {
            const c = s2.get(r.codecId);
            if (c) log(`↳ Kodek (${r.type === 'outbound-rtp' ? 'šaljem' : 'primam'}): ${c.mimeType}`);
          }
        });
      } catch { /* diag only */ }
    }, 2000);
  } catch {
    /* ignore */
  }
}

// Every second, read inbound video stats → tells us capture-vs-network.
let statsTimer = null;
function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}
function startStats(pc) {
  stopStats();
  let inBytes = 0, inTs = 0, outBytes = 0, outTs = 0;
  let zeroCount = 0;
  statsTimer = setInterval(async () => {
    let stats;
    try {
      stats = await pc.getStats();
    } catch {
      return;
    }
    let inbound = null, outbound = null;
    stats.forEach((r) => {
      if (r.kind !== 'video') return;
      if (r.type === 'inbound-rtp') inbound = r;
      if (r.type === 'outbound-rtp') outbound = r;
    });

    let outTxt = '';
    if (outbound) {
      const mbps = outTs && outbound.timestamp > outTs
        ? ((outbound.bytesSent - outBytes) * 8 / (outbound.timestamp - outTs) / 1000).toFixed(1)
        : '…';
      outBytes = outbound.bytesSent;
      outTs = outbound.timestamp;
      const fps = outbound.framesPerSecond != null ? Math.round(outbound.framesPerSecond) : 0;
      if (outbound.frameWidth) {
        outTxt = `⇡ šalješ ${outbound.frameWidth}×${outbound.frameHeight} @ ${fps}fps · ${mbps} Mbps`;
      }
    }

    if (inbound && inbound.frameWidth && inbound.framesReceived > 0) {
      const mbps = inTs && inbound.timestamp > inTs
        ? ((inbound.bytesReceived - inBytes) * 8 / (inbound.timestamp - inTs) / 1000).toFixed(1)
        : '…';
      inBytes = inbound.bytesReceived;
      inTs = inbound.timestamp;
      const fps = inbound.framesPerSecond != null ? Math.round(inbound.framesPerSecond) : 0;
      const inTxt = `⇣ gledaš ${inbound.frameWidth}×${inbound.frameHeight} @ ${fps}fps · ${mbps} Mbps`;
      setStatus(outTxt ? `${inTxt} | ${outTxt}` : `UŽIVO — ${inTxt}`, 'live');
    } else if (outTxt) {
      setStatus(`UŽIVO — ${outTxt}`, 'live');
    } else if (inbound) {
      zeroCount++;
      setStatus(
        zeroCount > 4
          ? '⚠ Nema video frejmova — mreža blokira P2P (TURN problem)'
          : 'Povezivanje video toka…',
        zeroCount > 4 ? 'error' : 'waiting'
      );
    }
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

    // If a friend code is set, start streaming to them. Close any existing
    // call first — the replacement carries BOTH directions on one connection.
    if (remotePeerId) {
      const existing = activeCalls.get(remotePeerId);
      if (existing) existing.close();
      startCall(remotePeerId);
    } else {
      log('Ukucaj kod drugara i klikni „Poveži" da počne prenos.');
    }

    // Stop cleanly if the user ends capture from the OS.
    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);
  } catch (e) {
    log('Greška pri hvatanju ekrana: ' + e.message);
    setStatus('Greška pri hvatanju ekrana', 'error');
  }
}

// Boost the bandwidth estimator via SDP: Chrome's estimator ramps slowly and
// conservatively through a TURN relay (we measured the path clean at 40 Mbps
// while the encoder sat at ~5). x-google-{start,min,max}-bitrate on the video
// codecs makes the sender start high and never sink below a floor. The flags
// take effect on the REMOTE side's sender, so both peers apply the transform
// (call + answer) to boost both directions.
function sdpBoost(sdp) {
  const kbps = Math.round(Number(el('bitrate').value) / 1000);
  // TURBO #3: aggressive floor — the estimator may wobble between 70% and
  // 100% of the target, but never crater to kilobits on a motion burst.
  const start = Math.round(kbps * 0.8);
  const min = Math.round(kbps * 0.7);
  const flags = `x-google-min-bitrate=${min};x-google-start-bitrate=${start};x-google-max-bitrate=${kbps}`;

  let lines = sdp.split('\r\n');
  lines = preferH264(lines); // TURBO #1: hardware H.264 first in codec order
  // Collect video codec payload types (skip rtx/red/fec).
  const videoPts = new Set();
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    else if (inVideo) {
      const m = l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)/i);
      if (m) videoPts.add(m[1]);
    }
  }
  // Append flags to existing fmtp lines; add fmtp for codecs without one (VP8).
  const withFmtp = new Set();
  const out = [];
  for (const l of lines) {
    const m = l.match(/^a=fmtp:(\d+) /);
    if (m && videoPts.has(m[1])) {
      out.push(`${l};${flags}`);
      withFmtp.add(m[1]);
    } else {
      out.push(l);
    }
  }
  const final = [];
  for (const l of out) {
    final.push(l);
    const m = l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)/i);
    if (m && !withFmtp.has(m[1])) {
      final.push(`a=fmtp:${m[1]} ${flags}`);
      withFmtp.add(m[1]);
    }
  }
  return final.join('\r\n');
}

// TURBO #1: reorder the m=video line so H264 payload types come first.
// Chrome picks the first negotiated codec — H264 encodes on GPU/media-engine
// (NVENC / Apple VideoToolbox) instead of a software VP8/VP9 encoder, which
// is exactly what was choking 60fps motion scenes on the CPU.
function preferH264(lines) {
  let mIdx = -1;
  const h264 = new Set();
  let inVideo = false;
  lines.forEach((l, i) => {
    if (l.startsWith('m=video')) { mIdx = i; inVideo = true; }
    else if (l.startsWith('m=')) inVideo = false;
    else if (inVideo) {
      const m = l.match(/^a=rtpmap:(\d+) H264\//i);
      if (m) h264.add(m[1]);
    }
  });
  if (mIdx === -1 || !h264.size) return lines;
  const parts = lines[mIdx].split(' ');
  const head = parts.slice(0, 3);
  const pts = parts.slice(3);
  lines[mIdx] = head
    .concat(pts.filter((p) => h264.has(p)), pts.filter((p) => !h264.has(p)))
    .join(' ');
  return lines;
}

function startCall(id) {
  if (!localStream) return;
  const call = peer.call(id, localStream, { sdpTransform: sdpBoost });
  activeCalls.set(id, call);
  // The other side may also be sharing back to us on this same call.
  call.on('stream', (stream) => showRemote(call, stream));
  call.on('close', () => handleCallClose(call));
  call.on('error', (e) => log('Greška poziva: ' + e));

  withPC(call, (pc) => {
    monitorPC(pc, 'slanje');
    startStats(pc); // live outbound stats for the sender too
  });
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
