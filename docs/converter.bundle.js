import { FFmpeg } from 'https://cdn.skypack.dev/@ffmpeg/ffmpeg@0.12.6';
import { toBlobURL, fetchFile } from 'https://cdn.skypack.dev/@ffmpeg/util@0.12.6';

// converter.js

// 2️⃣  Instantiate the class-based API (v0.12+)
const ffmpeg = new FFmpeg({ log: true });

let selectedFile = null;
let isLoaded     = false;

// UI refs
const dropZone          = document.getElementById('dropZone');
const selectBtn         = document.getElementById('selectBtn');
const fileInput         = document.getElementById('fileInput');
const qualitySlider     = document.getElementById('qualitySlider');
const qualityValue      = document.getElementById('qualityValue');
const convertBtn        = document.getElementById('convertBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar       = document.getElementById('progressBar');
const progressText      = document.getElementById('progressText');
const statusDiv         = document.getElementById('status');
const preview           = document.getElementById('preview');
const downloadLink      = document.getElementById('downloadLink');

// Simple show/hide helpers
const show      = el => el.classList.remove('hidden');
const hide      = el => el.classList.add('hidden');
const setStatus = txt => { statusDiv.textContent = txt; show(statusDiv); };

// Reset UI to initial state
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

// Quality slider update
qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

// Conversion
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();

  // 3️⃣  Lazy-load the core-mt assets once
  if (!isLoaded) {
    setStatus('Loading FFmpeg core…');

    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/umd';

    // Blob-wrap each asset to avoid CORS
    const [coreURL, wasmURL, workerURL] = await Promise.all([
      toBlobURL(`${baseURL}/ffmpeg-core.js`,        'application/javascript'),
      toBlobURL(`${baseURL}/ffmpeg-core.wasm`,      'application/wasm'),
      toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'application/javascript'),
    ]);

    // classWorkerURL needed for some builds
    await ffmpeg.load({
      coreURL,
      wasmURL,
      workerURL,
      classWorkerURL: workerURL
    });

    isLoaded = true;
  }

  // 4️⃣  Write the input file into WASM FS
  setStatus('Reading input file…');
  const data = await fetchFile(selectedFile);
  await ffmpeg.writeFile('input.mp4', data);

  // 5️⃣  Hook up progress events
  ffmpeg.on('progress', ({ ratio }) => {
    show(progressContainer);
    progressBar.value = ratio;
    const pct = Math.round(ratio * 100);
    progressText.textContent = `${pct}%`;
    setStatus(`Converting… ${pct}%`);
  });

  // 6️⃣  Execute the CLI: MP4→WebM (VP9 + Opus)
  const qp      = Math.max(0.1, parseFloat(qualitySlider.value));
  const bitrate = `${Math.round(qp * 1000)}k`;

  try {
    await ffmpeg.exec([
      '-y',
      '-i', 'input.mp4',
      '-c:v', 'libvpx-vp9',
      '-b:v', bitrate,
      '-c:a', 'libopus',
      'output.webm'
    ]);
  } catch (err) {
    return setStatus('Conversion failed: ' + err.message);
  }

  // 7️⃣  Pull the result back out
  setStatus('Finalizing…');
  const out = await ffmpeg.readFile('output.webm');
  const blob = new Blob([out.buffer], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);

  // 8️⃣  Show preview and download link
  preview.src = url;
  show(preview);

  downloadLink.href     = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  show(downloadLink);

  setStatus('Done!');
});

// Initial UI state
resetUI();
//# sourceMappingURL=converter.bundle.js.map
