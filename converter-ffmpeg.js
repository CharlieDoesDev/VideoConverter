// converter-ffmpeg.js

// 1) Initialize FFmpeg.wasm with single-thread core
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
  log: true,
  corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.12.15/dist/ffmpeg-core.js'
});

// 2) UI element references
const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const qualitySlider   = document.getElementById('qualitySlider');
const qualityLabel    = document.getElementById('qualityLabel');
const convertBtn      = document.getElementById('convertBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar     = document.getElementById('progressBar');
const progressText    = document.getElementById('progressText');
const outputSection   = document.getElementById('output');
const outputVideo     = document.getElementById('outputVideo');
const downloadLink    = document.getElementById('downloadLink');

let selectedFile = null;
let originalDuration = 0;

// 3) UI helper functions
function resetUI() {
  progressBar.value = 0;
  progressText.textContent = '0%';
  progressContainer.classList.add('hidden');
  outputSection.classList.add('hidden');
  convertBtn.disabled = !selectedFile;
}
function updateProgress(ratio, msg = '') {
  const pct = (ratio * 100).toFixed(2);
  progressBar.value = pct;
  progressText.textContent = msg || `${pct}%`;
}

// 4) Quality slider event
qualitySlider.addEventListener('input', () => {
  qualityLabel.textContent = `${qualitySlider.value}%`;
});

// 5) Drag & drop and click handlers
;['dragover','dragleave','drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.toggle('hover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer.files[0]) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelection(fileInput.files[0]);
});

// 6) When a file is selected
async function handleFileSelection(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  selectedFile = file;
  convertBtn.disabled = false;
  dropZone.textContent = `Selected: ${file.name}`;

  // Load metadata to get duration
  originalDuration = await getVideoDuration(file);
  resetUI();
}

// 7) Utility: get video duration
function getVideoDuration(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = URL.createObjectURL(file);
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(v.src);
      resolve(v.duration);
    };
  });
}

// 8) Convert button click
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  // Load FFmpeg core if needed
  if (!ffmpeg.isLoaded()) {
    progressContainer.classList.remove('hidden');
    progressText.textContent = 'Loading FFmpeg…';
    await ffmpeg.load();
  }

  // Show progress and reset
  progressContainer.classList.remove('hidden');
  updateProgress(0, 'Starting…');

  // Write input into FFmpeg FS
  const data = await fetchFile(selectedFile);
  ffmpeg.FS('writeFile', 'input.mp4', data);

  // Build scale filter and bitrate
  const scaleFactor = qualitySlider.value / 100;
  const scaleFilter = `scale=iw*${scaleFactor}:ih*${scaleFactor}`;
  // Approximate total bitrate (in bits/sec)
  let totalBitsPerSec = (selectedFile.size * 8) / originalDuration;
  let videoBitsPerSec = totalBitsPerSec * scaleFactor;
  const audioBitsPerSec = 128_000; // fixed 128 kbps
  videoBitsPerSec = Math.max(videoBitsPerSec - audioBitsPerSec, 100_000);
  const videoKbps = Math.floor(videoBitsPerSec / 1000);

  // Run FFmpeg command
  progressText.textContent = 'Converting…';
  try {
    await ffmpeg.run(
      '-y',
      '-i','input.mp4',
      '-vf', scaleFilter,
      '-c:v','libvpx',
      '-b:v', `${videoKbps}k`,
      '-c:a','libopus',
      '-b:a','128k',
      'output.webm'
    );
  } catch(err) {
    console.error(err);
    progressText.textContent = 'Conversion error';
    return;
  }

  // Read output and display
  const outData = ffmpeg.FS('readFile', 'output.webm');
  const blob   = new Blob([outData.buffer], { type: 'video/webm' });
  const url    = URL.createObjectURL(blob);

  outputVideo.src = url;
  downloadLink.href = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  outputSection.classList.remove('hidden');
  updateProgress(1, 'Done!');
});
