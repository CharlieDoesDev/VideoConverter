import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';

const ffmpeg = createFFmpeg({ log: true });

/* UI elements */
const dropZone      = document.getElementById('dropZone');
const selectBtn     = document.getElementById('selectBtn');
const fileInput     = document.getElementById('fileInput');
const qualitySlider = document.getElementById('qualitySlider');
const qualityValue  = document.getElementById('qualityValue');
const convertBtn    = document.getElementById('convertBtn');
const progressBar   = document.getElementById('progressBar');
const progressText  = document.getElementById('progressText');
const statusDiv     = document.getElementById('status');
const preview       = document.getElementById('preview');
const downloadLink  = document.getElementById('downloadLink');
const progressContainer = document.getElementById('progressContainer');

let selectedFile = null;

/* Helpers */
function show(el)   { el.classList.remove('hidden'); }
function hide(el)   { el.classList.add('hidden'); }
function setStatus(msg) {
  statusDiv.textContent = msg;
  show(statusDiv);
}
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
;['dragover','dragleave','drop'].forEach(evt => {
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

/* Quality display */
qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

/* Conversion */
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();
  setStatus('Loading FFmpeg…');
  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }

  setStatus('Reading file…');
  const data = await fetchFile(selectedFile);
  ffmpeg.FS('writeFile', 'input.mp4', data);

  /* Show progress */
  ffmpeg.setProgress(({ ratio }) => {
    show(progressContainer);
    progressBar.value = ratio;
    const pct = Math.round(ratio * 100);
    progressText.textContent = `${pct}%`;
    setStatus(`Converting… ${pct}%`);
  });

  /* Run encode with quality mapped to bitrate multiplier */
  const quality = parseFloat(qualitySlider.value);
  const bitrate = `${Math.round(quality * 1000)}k`;

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

  /* Grab output */
  setStatus('Finalizing…');
  const outData = ffmpeg.FS('readFile', 'output.webm');
  const blob    = new Blob([outData.buffer], { type: 'video/webm' });
  const url     = URL.createObjectURL(blob);

  preview.src = url;
  show(preview);

  downloadLink.href     = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  show(downloadLink);

  setStatus('Done!');
});

resetUI();
