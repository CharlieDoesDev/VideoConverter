// converter.js
// ────────────

// 1) ESM imports from Skypack (CORS-friendly, browser-ready)  
import { FFmpeg } from 'https://cdn.skypack.dev/@ffmpeg/ffmpeg@0.12.15';  
import { fetchFile } from 'https://cdn.skypack.dev/@ffmpeg/util@0.12.15';  

// 2) Instantiate the new FFmpeg class (v0.12+ API)
const ffmpeg = new FFmpeg({ log: true });  // enable stderr logging :contentReference[oaicite:0]{index=0}

// UI references
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

let selectedFile = null;

// Helpers to show/hide & update status
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

// File picker & drag-drop wiring
selectBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => fileInput.files[0] && handleFile(fileInput.files[0]));
['dragover','dragleave','drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.toggle('hover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
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

// Update the quality display
qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

// Main convert handler
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();
  setStatus('Loading FFmpeg core…');

  // 3) Load the WASM core if needed, pointing at jsDelivr’s CORS-enabled assets :contentReference[oaicite:1]{index=1}
  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load({
      coreURL:   'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.15/dist/ffmpeg-core.js',
      wasmURL:   'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.15/dist/ffmpeg-core.wasm',
      workerURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.15/dist/ffmpeg-core-worker.js',
    });
  }

  // 4) Write the dropped file into MEMFS
  setStatus('Reading input file…');
  const data = await fetchFile(selectedFile);
  await ffmpeg.writeFile('input.mp4', data);  // replaces FS('writeFile') :contentReference[oaicite:2]{index=2}

  // 5) Track real-time progress via the new event API
  ffmpeg.on('progress', ({ ratio }) => {
    show(progressContainer);
    progressBar.value = ratio;
    const pct = Math.round(ratio * 100);
    progressText.textContent = `${pct}%`;
    setStatus(`Converting… ${pct}%`);        // replaces setProgress :contentReference[oaicite:3]{index=3}
  });

  // 6) Run the FFmpeg command with exec(...) instead of run(...) :contentReference[oaicite:4]{index=4}
  const qp      = Math.max(0.1, parseFloat(qualitySlider.value));
  const bitrate = `${Math.round(qp * 1000)}k`;
  try {
    await ffmpeg.exec([
      '-y',
      '-i', 'input.mp4',
      '-c:v', 'libvpx', '-b:v', bitrate,
      '-c:a', 'libopus',
      'output.webm'
    ]);
  } catch (err) {
    return setStatus('Conversion failed: ' + err.message);
  }

  // 7) Read the output file back out of MEMFS
  setStatus('Finalizing…');
  const out = await ffmpeg.readFile('output.webm');  // replaces FS('readFile') :contentReference[oaicite:5]{index=5}

  // 8) Create a Blob URL, show preview + download link
  const blob = new Blob([out.buffer], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);

  preview.src = url;
  show(preview);

  downloadLink.href     = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  show(downloadLink);

  setStatus('Done!');
});

resetUI();
