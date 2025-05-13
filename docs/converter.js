// converter.js
// ────────────

// 0️⃣  Pull in the pure-ESM WebMWriter build
import WebMWriter from 'https://cdn.jsdelivr.net/npm/@framekit/webm-writer-esm@1.0.0/dist/webm-writer.esm.js';

// UI refs
const dropZone      = document.getElementById('dropZone');
const selectBtn     = document.getElementById('selectBtn');
const fileInput     = document.getElementById('fileInput');
const qualitySlider = document.getElementById('qualitySlider');
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
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
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

  const fps = video.frameRate || 30;
  const duration = video.duration;
  const totalFrames = Math.ceil(fps * duration);

  // 2) Setup WebMWriter with WebCodecs
  const quality = Math.max(0.1, parseFloat(qualitySlider.value));
  const writer  = new WebMWriter({
    quality,
    fileWriter: null,
    codec: 'vp9',         // use vp9 for better compression
    frameRate: fps,
    disableWebAssembly: true
  });

  // 3) Draw & encode each frame
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  let frameCount = 0;
  showStatus(`Encoding 0 / ${totalFrames}`);

  const renderFrame = () => {
    if (video.ended || frameCount >= totalFrames) {
      finish();
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    writer.addFrame(canvas);
    frameCount++;
    showStatus(`Encoding ${frameCount} / ${totalFrames}`);
    video.requestVideoFrameCallback(renderFrame);
  };

  renderFrame();

  async function finish() {
    showStatus('Finalizing WebM…');
    const webmBlob = await writer.complete();
    const url = URL.createObjectURL(webmBlob);

    preview.src = url;
    preview.classList.remove('hidden');

    downloadLink.href = url;
    downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
    downloadLink.classList.remove('hidden');

    showStatus('Done!');
  }
});

resetUI();
