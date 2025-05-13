// converter.js

import { FFmpeg }             from 'https://cdn.skypack.dev/@ffmpeg/ffmpeg@0.12.1';
import { fetchFile, toBlobURL } from 'https://cdn.skypack.dev/@ffmpeg/util@0.12.1';

const ffmpeg = new FFmpeg({ log: true });

let loaded = false;
let selectedFile = null;

// UI refs
const dropZone         = document.getElementById('dropZone');
const selectBtn        = document.getElementById('selectBtn');
const fileInput        = document.getElementById('fileInput');
const qualitySlider    = document.getElementById('qualitySlider');
const qualityValue     = document.getElementById('qualityValue');
const convertBtn       = document.getElementById('convertBtn');
const progressContainer= document.getElementById('progressContainer');
const progressBar      = document.getElementById('progressBar');
const progressText     = document.getElementById('progressText');
const statusDiv        = document.getElementById('status');
const preview          = document.getElementById('preview');
const downloadLink     = document.getElementById('downloadLink');

// Helpers
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const setStatus = txt => {
  statusDiv.textContent = txt;
  show(statusDiv);
};
function resetUI() {
  convertBtn.disabled = !selectedFile;
  hide(statusDiv);
  hide(preview);
  hide(downloadLink);
  hide(progressContainer);
  progressBar.value = 0;
  progressText.textContent = '0%';
}

// File selection: browse
selectBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

// File selection: drag & drop
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

// Quality slider display
qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

async function loadFFmpegCore() {
  // Pin to the same version for all three assets
  const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist';

  await ffmpeg.load({
    // Wrap the JS files in Blob URLs to avoid CORS/preflight issues
    coreURL:   await toBlobURL(`${base}/ffmpeg-core.js`,        'application/javascript'),
    workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'application/javascript'),
    // The WASM file itself can be fetched directly (jsDelivr sends CORS headers)
    wasmURL:   `${base}/ffmpeg-core.wasm`,
  });

  loaded = true;
}

// Main convert logic
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();
  if (!loaded) {
    setStatus('Loading FFmpeg core…');
    await loadFFmpegCore();
  }

  setStatus('Reading input file…');
  const data = await fetchFile(selectedFile);
  await ffmpeg.writeFile('input.mp4', data);

  ffmpeg.on('progress', ({ ratio }) => {
    show(progressContainer);
    progressBar.value = ratio;
    const pct = Math.round(ratio * 100);
    progressText.textContent = `${pct}%`;
    setStatus(`Converting… ${pct}%`);
  });

  const qp      = Math.max(0.1, parseFloat(qualitySlider.value));
  const bitrate = `${Math.round(qp * 1000)}k`;

  try {
    await ffmpeg.exec([
      '-y',
      '-i', 'input.mp4',
      '-c:v', 'libvpx-vp9', '-b:v', bitrate,
      '-c:a', 'libopus',
      'output.webm'
    ]);
  } catch (err) {
    return setStatus('Conversion failed: ' + err.message);
  }

  setStatus('Finalizing…');
  const out = await ffmpeg.readFile('output.webm');
  const blob = new Blob([out.buffer], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);

  preview.src = url;
  show(preview);

  downloadLink.href     = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  show(downloadLink);

  setStatus('Done!');
});

// initial state
resetUI();
