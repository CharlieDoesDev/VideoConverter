// converter-ffmpegjs.js

// UI references
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

// Drag & drop & click handlers
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

// File selection
function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4.');
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

  // 1) Load the file into memory
  const arrayBuffer = await selectedFile.arrayBuffer();
  const input = new Uint8Array(arrayBuffer);

  // 2) Run FFmpeg-js (synchronous)  
  showStatus('Converting… (this may take a bit)');
  let result;
  try {
    result = FFmpeg({
      arguments: [
        '-i', 'input.mp4',
        '-c:v', 'libvpx',          // VP8
        '-b:v', '1M',              // 1 Mbps video
        '-c:a', 'libopus',         // Opus audio
        'output.webm'
      ],
      MEMFS: [{ name: 'input.mp4', data: input }],
      // no print / printErr callbacks for this minimal example
    });
  } catch (err) {
    console.error(err);
    showStatus('Conversion failed: ' + err.message);
    return;
  }

  // 3) Retrieve the output
  const out = result.MEMFS.find(f => f.name === 'output.webm');
  if (!out) {
    showStatus('No output generated');
    return;
  }

  // 4) Make a Blob & display
  const blob = new Blob([out.data], { type: 'video/webm' });
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
