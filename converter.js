// Pull the legacy ESM build with CORS support from jsDelivr v0.11.6
import { createFFmpeg, fetchFile }
  from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';

const ffmpeg = createFFmpeg({ log: true });

/* UI references */
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

/* Helpers */
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

/* File selection */
selectBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

/* Drag & drop */
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

/* Quality slider */
qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

/* Conversion */
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();
  setStatus('Loading FFmpeg…');
  if (!ffmpeg.isLoaded()) await ffmpeg.load();

  setStatus('Reading file…');
  const data = await fetchFile(selectedFile);
  ffmpeg.FS('writeFile', 'input.mp4', data);

  ffmpeg.setProgress(({ ratio }) => {
    show(progressContainer);
    progressBar.value = ratio;
    const pct = Math.round(ratio * 100);
    progressText.textContent = `${pct}%`;
    setStatus(`Converting… ${pct}%`);
  });

  // Map quality slider (0.1–5) to bitrate (100k–5000k):
  const qp = Math.max(0.1, parseFloat(qualitySlider.value));
  const bitrate = `${Math.round(qp * 1000)}k`;

  try {
    await ffmpeg.run(
      '-y',
      '-i', 'input.mp4',
      '-c:v', 'libvpx',
      '-b:v', bitrate,
      '-c:a', 'libopus',
      'output.webm'
    );
  } catch (err) {
    return setStatus('Conversion failed: ' + err.message);
  }

  setStatus('Finalizing…');
  const out = ffmpeg.FS('readFile', 'output.webm');
  const blob = new Blob([out.buffer], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);

  preview.src = url;
  show(preview);

  downloadLink.href      = url;
  downloadLink.download  = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  show(downloadLink);

  setStatus('Done!');
});

resetUI();
