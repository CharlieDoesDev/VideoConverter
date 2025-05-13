// converter-ffmpegjs.js

// 👀 We expect a global `Worker`-compatible script at converter-worker.js
if (typeof Worker !== 'function') {
  throw new Error('This browser doesn’t support Web Workers.');
}

// UI refs
const dropZone     = document.getElementById('dropZone');
const fileInput    = document.getElementById('fileInput');
const convertBtn   = document.getElementById('convertBtn');
const statusDiv    = document.getElementById('status');
const preview      = document.getElementById('preview');
const downloadLink = document.getElementById('downloadLink');

let selectedFile = null;

// Helpers
function showStatus(msg) {
  statusDiv.textContent = msg;
  statusDiv.classList.remove('hidden');
}
function hideStatus() {
  statusDiv.classList.add('hidden');
}
function resetUI() {
  convertBtn.disabled = !selectedFile;
  hideStatus();
  preview.classList.add('hidden');
  downloadLink.classList.add('hidden');
}

// Drag & drop + file-picker
;['dragover','dragleave','drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.toggle('hover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
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

// Create and wire up the Worker
const worker = new Worker('converter-worker.js');

worker.onmessage = e => {
  if (e.data.type === 'done') {
    const outFile = e.data.MEMFS.find(f => f.name === 'output.webm');
    if (!outFile) return showStatus('No output generated');

    const blob = new Blob([outFile.data], { type: 'video/webm' });
    const url  = URL.createObjectURL(blob);

    preview.src = url;
    preview.classList.remove('hidden');

    downloadLink.href = url;
    downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
    downloadLink.textContent = 'Download WebM';
    downloadLink.classList.remove('hidden');

    showStatus('Done!');
  }
  else if (e.data.type === 'error') {
    showStatus('Conversion failed: ' + e.data.message);
  }
};

convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  resetUI();
  showStatus('Reading file…');

  const buffer   = await selectedFile.arrayBuffer();
  const inputData = new Uint8Array(buffer);

  showStatus('Converting…');

  worker.postMessage({
    inputData,
    args: [
      '-y',        // overwrite without asking
      '-nostdin',  // disable stdin prompts
      '-i','input.mp4',
      '-c:v','libvpx','-b:v','1M',
      '-c:a','libopus',
      'output.webm'
    ]
  });
});

resetUI();
