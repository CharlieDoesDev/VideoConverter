import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';

const ffmpeg = createFFmpeg({ log: true });

const dropZone     = document.getElementById('dropZone');
const fileInput    = document.getElementById('fileInput');
const convertBtn   = document.getElementById('convertBtn');
const progressBar  = document.getElementById('progressBar');
const statusDiv    = document.getElementById('status');
const preview      = document.getElementById('preview');
const downloadLink = document.getElementById('downloadLink');

let selectedFile = null;

function showStatus(msg) {
  statusDiv.textContent = msg;
  statusDiv.classList.remove('hidden');
}
function hideStatus() {
  statusDiv.classList.add('hidden');
}
function resetUI() {
  convertBtn.disabled    = !selectedFile;
  hideStatus();
  preview.classList.add('hidden');
  downloadLink.classList.add('hidden');
  progressBar.classList.add('hidden');
  progressBar.value = 0;
}

// drag & drop + picker
;['dragover','dragleave','drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.toggle('hover', evt==='dragover');
    if (evt==='drop' && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  selectedFile = file;
  dropZone.textContent = `Selected: ${file.name}`;
  resetUI();
}

convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();
  showStatus('Loading FFmpeg…');
  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }

  showStatus('Reading file…');
  const data = await fetchFile(selectedFile);

  showStatus('Writing file to virtual FS…');
  ffmpeg.FS('writeFile', 'input.mp4', data);

  // wire up progress
  ffmpeg.setProgress(({ ratio }) => {
    progressBar.classList.remove('hidden');
    progressBar.value = ratio;         // 0 → 1
    showStatus(`Converting… ${Math.round(ratio * 100)}%`);
  });

  try {
    await ffmpeg.run(
      '-y',            // overwrite output if it exists
      '-i', 'input.mp4',
      '-c:v', 'libvpx',
      '-b:v', '1M',
      '-c:a', 'libopus',
      'output.webm'
    );
  } catch (err) {
    return showStatus('Conversion failed: ' + err.message);
  }

  showStatus('Reading output…');
  const outData = ffmpeg.FS('readFile', 'output.webm');
  const blob    = new Blob([outData.buffer], { type: 'video/webm' });
  const url     = URL.createObjectURL(blob);

  preview.src = url;
  preview.classList.remove('hidden');

  downloadLink.href        = url;
  downloadLink.download    = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  downloadLink.textContent = 'Download WebM';
  downloadLink.classList.remove('hidden');

  showStatus('Done!');
});

resetUI();
