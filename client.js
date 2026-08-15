(() => {
  const socket = io();

  // ---------- State ----------
  let myId = null;
  let myName = null;
  let roomId = null;
  let localStream = null;
  const peers = new Map(); // id -> { pc, name, stream }
  const incomingFiles = new Map(); // fileId -> { chunks, meta, received }

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // ---------- DOM ----------
  const joinScreen = document.getElementById('join-screen');
  const callScreen = document.getElementById('call-screen');
  const nameInput = document.getElementById('name-input');
  const roomInput = document.getElementById('room-input');
  const joinBtn = document.getElementById('join-btn');
  const generateRoomBtn = document.getElementById('generate-room');
  const roomLabel = document.getElementById('room-label');
  const copyLinkBtn = document.getElementById('copy-link');
  const memberCountEl = document.getElementById('member-count');
  const videoGrid = document.getElementById('video-grid');
  const chatLog = document.getElementById('chat-log');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const fileInput = document.getElementById('file-input');
  const fileLog = document.getElementById('file-log');
  const peopleList = document.getElementById('people-list');
  const micBtn = document.getElementById('toggle-mic');
  const camBtn = document.getElementById('toggle-cam');
  const panelToggle = document.getElementById('toggle-panel');
  const sidePanel = document.getElementById('side-panel');
  const leaveBtn = document.getElementById('leave-btn');
  const toast = document.getElementById('toast');

  // Prefill room code from URL (?room=xxx)
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('room')) roomInput.value = urlParams.get('room');

  generateRoomBtn.addEventListener('click', () => {
    roomInput.value = randomRoomCode();
  });

  function randomRoomCode() {
    const words = ['harbor','maple','quartz','ember','cobalt','willow','lantern','ridge','delta','opal'];
    const w = words[Math.floor(Math.random() * words.length)];
    const n = Math.floor(100 + Math.random() * 900);
    return `${w}-${n}`;
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // ---------- Join flow ----------
  joinBtn.addEventListener('click', joinRoom);
  [nameInput, roomInput].forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
  }));

  async function joinRoom() {
    const name = nameInput.value.trim();
    const room = roomInput.value.trim();
    if (!name || !room) {
      showToast('Enter your name and a room code');
      return;
    }
    myName = name;
    roomId = room;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      showToast('Could not access camera/mic — joining audio/video off');
      localStream = new MediaStream();
    }

    joinScreen.classList.add('hidden');
    callScreen.classList.remove('hidden');
    roomLabel.textContent = room;

    addLocalTile();
    setupSpeakingDetection(localStream, 'local-tile');

    socket.emit('join-room', { roomId, name });
  }

  copyLinkBtn.addEventListener('click', () => {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(link).then(() => showToast('Room link copied'));
  });

  // ---------- Video tiles ----------
  function addLocalTile() {
    const tile = document.createElement('div');
    tile.className = 'tile mirrored';
    tile.id = 'tile-local';
    tile.innerHTML = `
      <video id="local-tile" autoplay playsinline muted></video>
      <div class="name-tag"><span class="presence-ring"></span>${escapeHtml(myName)} (you)</div>
    `;
    videoGrid.appendChild(tile);
    tile.querySelector('video').srcObject = localStream;
  }

  function addRemoteTile(id, name) {
    if (document.getElementById(`tile-${id}`)) return;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = `tile-${id}`;
    tile.innerHTML = `
      <video id="video-${id}" autoplay playsinline></video>
      <div class="name-tag"><span class="presence-ring"></span>${escapeHtml(name)}</div>
    `;
    videoGrid.appendChild(tile);
  }

  function removeRemoteTile(id) {
    const tile = document.getElementById(`tile-${id}`);
    if (tile) tile.remove();
  }

  function setSpeaking(tileId, speaking) {
    const tile = document.getElementById(tileId === 'local-tile' ? 'tile-local' : `tile-${tileId}`);
    if (tile) tile.classList.toggle('speaking', speaking);
  }

  // Simple volume-based speaking indicator
  function setupSpeakingDetection(stream, tileKey) {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let speaking = false;
      (function loop() {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const now = avg > 18;
        if (now !== speaking) {
          speaking = now;
          setSpeaking(tileKey, speaking);
        }
        requestAnimationFrame(loop);
      })();
    } catch (e) { /* ignore */ }
  }

  // ---------- Socket: room membership ----------
  socket.on('connect', () => { myId = socket.id; });

  socket.on('existing-users', (users) => {
    users.forEach(u => connectToPeer(u.id, u.name, true));
    refreshPeopleList();
  });

  socket.on('user-joined', ({ id, name }) => {
    connectToPeer(id, name, false);
    addSystemMessage(`${name} joined the room`);
    refreshPeopleList();
  });

  socket.on('user-left', ({ id }) => {
    const p = peers.get(id);
    if (p) {
      addSystemMessage(`${p.name} left the room`);
      if (p.pc) p.pc.close();
      peers.delete(id);
    }
    removeRemoteTile(id);
    refreshPeopleList();
  });

  socket.on('member-count', (count) => { memberCountEl.textContent = count; });

  function refreshPeopleList() {
    peopleList.innerHTML = '';
    const me = document.createElement('li');
    me.innerHTML = `<span class="dot"></span>${escapeHtml(myName)} (you)`;
    peopleList.appendChild(me);
    peers.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="dot"></span>${escapeHtml(p.name)}`;
      peopleList.appendChild(li);
    });
  }

  // ---------- WebRTC mesh ----------
  function connectToPeer(id, name, isInitiator) {
    if (peers.has(id)) return;
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peers.set(id, { pc, name, stream: null });
    addRemoteTile(id, name);

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', { to: id, data: { type: 'ice', candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      const video = document.getElementById(`video-${id}`);
      if (video && video.srcObject !== e.streams[0]) {
        video.srcObject = e.streams[0];
        setupSpeakingDetection(e.streams[0], id);
      }
    };

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: id, data: { type: 'offer', sdp: pc.localDescription } });
        } catch (e) { console.error(e); }
      };
    }
  }

  socket.on('signal', async ({ from, data }) => {
    let entry = peers.get(from);
    if (!entry) {
      // Shouldn't normally happen, but guard just in case
      connectToPeer(from, 'Guest', false);
      entry = peers.get(from);
    }
    const pc = entry.pc;

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { type: 'answer', sdp: pc.localDescription } });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice') {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
    }
  });

  // ---------- Chat ----------
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', { text });
    chatInput.value = '';
  });

  socket.on('chat-message', ({ id, name, text }) => {
    const div = document.createElement('div');
    div.className = 'msg' + (id === myId ? ' mine' : '');
    div.innerHTML = `<div class="who">${id === myId ? 'You' : escapeHtml(name)}</div><div class="bubble">${escapeHtml(text)}</div>`;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---------- File / photo sharing ----------
  const CHUNK_SIZE = 64 * 1024;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) sendFile(file);
    fileInput.value = '';
  });

  async function sendFile(file) {
    const fileId = `${myId}-${Date.now()}`;
    socket.emit('file-start', { fileId, fileName: file.name, fileType: file.type, fileSize: file.size });

    const item = renderOutgoingFileItem(fileId, file.name, file.size);

    const buf = await file.arrayBuffer();
    let offset = 0;
    while (offset < buf.byteLength) {
      const chunk = buf.slice(offset, offset + CHUNK_SIZE);
      socket.emit('file-chunk', { fileId, chunk: arrayBufferToBase64(chunk) });
      offset += CHUNK_SIZE;
      updateProgress(item, offset / buf.byteLength);
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 0)); // yield to keep UI responsive
    }
    socket.emit('file-end', { fileId });
    updateProgress(item, 1);
  }

  function renderOutgoingFileItem(fileId, name, size) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.id = `file-${fileId}`;
    div.innerHTML = `
      <div class="fname">${escapeHtml(name)}</div>
      <div class="from">You · ${formatBytes(size)}</div>
      <div class="progress"><div class="progress-bar"></div></div>
    `;
    fileLog.appendChild(div);
    return div;
  }

  function updateProgress(item, ratio) {
    const bar = item.querySelector('.progress-bar');
    if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
  }

  socket.on('file-start', ({ fileId, fileName, fileType, fileSize, name }) => {
    incomingFiles.set(fileId, { chunks: [], meta: { fileName, fileType, fileSize, name }, received: 0 });
    const div = document.createElement('div');
    div.className = 'file-item';
    div.id = `file-${fileId}`;
    div.innerHTML = `
      <div class="fname">${escapeHtml(fileName)}</div>
      <div class="from">${escapeHtml(name)} · ${formatBytes(fileSize)}</div>
      <div class="progress"><div class="progress-bar"></div></div>
    `;
    fileLog.appendChild(div);
  });

  socket.on('file-chunk', ({ fileId, chunk }) => {
    const entry = incomingFiles.get(fileId);
    if (!entry) return;
    const bytes = base64ToUint8Array(chunk);
    entry.chunks.push(bytes);
    entry.received += bytes.byteLength;
    const item = document.getElementById(`file-${fileId}`);
    if (item) updateProgress(item, Math.min(1, entry.received / (entry.meta.fileSize || entry.received)));
  });

  socket.on('file-end', ({ fileId }) => {
    const entry = incomingFiles.get(fileId);
    if (!entry) return;
    const blob = new Blob(entry.chunks, { type: entry.meta.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const item = document.getElementById(`file-${fileId}`);
    if (item) {
      let preview = '';
      if ((entry.meta.fileType || '').startsWith('image/')) {
        preview = `<img src="${url}" alt="${escapeHtml(entry.meta.fileName)}" />`;
      }
      item.innerHTML = `
        <div class="fname">${escapeHtml(entry.meta.fileName)}</div>
        <div class="from">${escapeHtml(entry.meta.name)} · ${formatBytes(entry.meta.fileSize)}</div>
        ${preview}
        <a href="${url}" download="${escapeHtml(entry.meta.fileName)}">Download</a>
      `;
    }
    incomingFiles.delete(fileId);
  });

  // ---------- Controls ----------
  micBtn.addEventListener('click', () => {
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    micBtn.classList.toggle('off', !track.enabled);
  });

  camBtn.addEventListener('click', () => {
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    camBtn.classList.toggle('off', !track.enabled);
  });

  panelToggle.addEventListener('click', () => sidePanel.classList.toggle('open'));

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  leaveBtn.addEventListener('click', () => {
    location.reload();
  });

  // ---------- Helpers ----------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function arrayBufferToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
})();
