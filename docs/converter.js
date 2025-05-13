// converter.js
// ────────────

// UI refs
const dropZone      = document.getElementById('dropZone');
const selectBtn     = document.getElementById('selectBtn');
const fileInput     = document.getElementById('fileInput');
const qualitySlider = document.getElementById('qualitySlider'); // now used as scale (0.1–1)
const qualityValue  = document.getElementById('qualityValue');
const convertBtn    = document.getElementById('convertBtn');
const statusDiv     = document.getElementById('status');
const preview       = document.getElementById('preview');
const downloadLink  = document.getElementById('downloadLink');

let selectedFile = null;

const showStatus = msg => {
  statusDiv.textContent = msg;
  statusDiv.classList.remove('hidden');
};
const hideStatus = () => statusDiv.classList.add('hidden');
const resetUI = () => {
  convertBtn.disabled = !selectedFile;
  hideStatus();
  preview.classList.add('hidden');
  downloadLink.classList.add('hidden');
};

// File selection
selectBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
['dragover','dragleave','drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.toggle('hover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
});

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  selectedFile = file;
  dropZone.querySelector('p').textContent = `Selected: ${file.name}`;
  resetUI();
}

qualitySlider.addEventListener('input', () => {
  // interpret slider 0.1–1.0 as scale factor
  const scale = Math.max(0.1, parseFloat(qualitySlider.value));
  qualityValue.textContent = (scale * 100).toFixed(0) + '%';
});

convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  resetUI();
  showStatus('Preparing video…');

  // 1) Load video element
  const video = document.createElement('video');
  video.src = URL.createObjectURL(selectedFile);
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {
    video.currentTime = 0;
    return new Promise(r => video.addEventListener('loadeddata', r, { once: true }));
  });

  // 2) Compute scale
  const scale = Math.max(0.1, parseFloat(qualitySlider.value));
  const w = Math.floor(video.videoWidth * scale / 2) * 2; // even dims
  const h = Math.floor(video.videoHeight * scale / 2) * 2;

  // 3) Canvas for down-scaling
  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // 4) Capture stream & setup MediaRecorder
  const fps = 30; // assume 30fps if .frameRate unavailable
  const stream = canvas.captureStream(fps);

  let mime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
  if (!MediaRecorder.isTypeSupported(mime)) {
    mime = 'video/webm; codecs=vp8,opus';
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 2_000_000, // ~2 Mbps target
    audioBitsPerSecond: 128_000
  });

  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    showStatus('Finalizing…');
    const blob = new Blob(chunks, { type: mime });
    const url  = URL.createObjectURL(blob);

    preview.src = url;
    preview.classList.remove('hidden');

    downloadLink.href        = url;
    downloadLink.download    = selectedFile.name.replace(/\.mp4$/i, '') + '.mp4';
    downloadLink.classList.remove('hidden');

    showStatus('Done!');
  };

  // 5) Draw loop
  showStatus('Recording…');
  recorder.start();

  const drawFrame = () => {
    if (video.ended || recorder.state !== 'recording') {
      recorder.stop();
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(() => drawFrame());
    } else {
      setTimeout(drawFrame, 1000 / fps);
    }
  };

  // kick off drawing once ready
  if (video.readyState >= 2) {
    drawFrame();
  } else {
    video.addEventListener('loadeddata', drawFrame, { once: true });
  }
});

resetUI();
