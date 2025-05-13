// converter-ffmpegjs.js

// 👀 We expect a global `ffmpeg()` function from ffmpeg-webm.js
if (typeof ffmpeg !== 'function') {
  throw new Error('Global `ffmpeg` is not defined. Make sure you loaded ffmpeg-webm.js before this script.');
}

// UI refs
const dropZone    = document.getElementById('dropZone');
const fileInput   = document.getElementById('fileInput');
const convertBtn  = document.getElementById('convertBtn');
const statusDiv   = document.getElementById('status');
const preview     = document.getElementById('preview');
const downloadLink= document.getElementById('downloadLink');

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

// When user selects/drops a file
function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  selectedFile = file;
  dropZone.textContent = `Selected: ${file.name}`;
  resetUI();
}

// Convert on button click
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  resetUI();
  showStatus('Reading file…');

  // 1) Read MP4 into Uint8Array
  const buffer = await selectedFile.arrayBuffer();
  const inputData = new Uint8Array(buffer);

  // 2) Run ffmpeg.js-UMD synchronously
  showStatus('Converting… this may block the UI for a bit');
  let result;
  try {
    result = ffmpeg({
      arguments: [
        '-i', 'input.mp4',
        '-c:v', 'libvpx',     // VP8
        '-b:v', '1M',         // 1 Mbps
        '-c:a', 'libopus',    // Opus audio
        'output.webm'
      ],
      MEMFS: [{ name: 'input.mp4', data: inputData }]
    });
  } catch (err) {
    console.error(err);
    showStatus('Conversion failed: ' + err.message);
    return;
  }

  // 3) Grab the output file from MEMFS
  const outFile = result.MEMFS.find(f => f.name === 'output.webm');
  if (!outFile) {
    showStatus('No output generated');
    return;
  }

  // 4) Create Blob URL and show preview + download
  const blob = new Blob([outFile.data], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);

  preview.src = url;
  preview.classList.remove('hidden');

  downloadLink.href = url;
  downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
  downloadLink.textContent = 'Download WebM';
  downloadLink.classList.remove('hidden');

  showStatus('Done!');
});

resetUI();
