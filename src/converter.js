import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import { toBlobURL }              from '@ffmpeg/util';

const ffmpeg = createFFmpeg({ log: true });

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

const show      = el => el.classList.remove('hidden');
const hide      = el => el.classList.add('hidden');
const setStatus = txt => { statusDiv.textContent = txt; show(statusDiv); };

function resetUI() {
  convertBtn.disabled = !selectedFile;
  hide(statusDiv);
  hide(preview);
  hide(downloadLink);
  hide(progressContainer);
  progressBar.value = 0;
  progressText.textContent = '0%';
}

// wire up file input
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

qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  resetUI();

  if (!isLoaded) {
    setStatus('Loading FFmpeg core…');
    await ffmpeg.load({
      corePath:   'ffmpeg-core/ffmpeg-core.js',
      workerPath: 'ffmpeg-core/ffmpeg-core.worker.js',
      wasmPath:   'ffmpeg-core/ffmpeg-core.wasm'
    });
    isLoaded = true;
  }

  setStatus('Reading input file…');
  const data = await fetchFile(selectedFile);
  ffmpeg.FS('writeFile', 'input.mp4', data);

  ffmpeg.setProgress(({ ratio }) => {
    show(progressContainer);
    progressBar.value = ratio;
    const pct = Math.round(ratio * 100);
    progressText.textContent = `${pct}%`;
    setStatus(`Converting… ${pct}%`);
  });

  const qp      = Math.max(0.1, parseFloat(qualitySlider.value));
  const bitrate = `${Math.round(qp * 1000)}k`;

  try {
    await ffmpeg.run(
      '-y',
      '-i', 'input.mp4',
      '-c:v', 'libvpx-vp9', '-b:v', bitrate,
      '-c:a', 'libopus',
      'output.webm'
    );
  } catch (err) {
    return setStatus('Conversion failed: ' + err.message);
  }

  setStatus('Finalizing…');
  const out  = ffmpeg.FS('readFile', 'output.webm');
  const blob = new Blob([out.buffer], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);

  preview.src = url; show(preview);
  downloadLink.href     = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  show(downloadLink);

  setStatus('Done!');
});

resetUI();
