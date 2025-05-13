// converter.js
// ────────────

// 0️⃣  Load WebMWriter via require (must be bundled with a CommonJS shim)
var 
    WebMWriter = require('webm-writer'),
    
    videoWriter = new WebMWriter({
        quality: 0.95,    // WebM image quality from 0.0 (worst) to 0.99999 (best), 1.00 (VP8L lossless) is not supported
        fileWriter: null, // FileWriter in order to stream to a file instead of buffering to memory (optional)
        fd: null,         // Node.js file handle to write to instead of buffering to memory (optional)
    
        // You must supply one of:
        frameDuration: null, // Duration of frames in milliseconds
        frameRate: null,     // Number of frames per second
    
        transparent: false,      // True if an alpha channel should be included in the video
        alphaQuality: undefined, // Allows you to set the quality level of the alpha channel separately.
                                 // If not specified this defaults to the same value as `quality`.
    });

// UI refs
const dropZone      = document.getElementById('dropZone');
const selectBtn     = document.getElementById('selectBtn');
const fileInput     = document.getElementById('fileInput');
const qualitySlider = document.getElementById('qualitySlider');
const qualityValue  = document.getElementById('qualityValue');
const convertBtn    = document.getElementById('convertBtn');
const statusDiv     = document.getElementById('status');
const preview       = document.getElementById('preview');
const downloadLink  = document.getElementById('downloadLink');

let selectedFile = null;

const showStatus = msg => {
  statusDiv.textContent = msg;
  statusDiv.classList.remove('hidden');
};
const hideStatus = () => statusDiv.classList.add('hidden');
const resetUI = () => {
  convertBtn.disabled = !selectedFile;
  hideStatus();
  preview.classList.add('hidden');
  downloadLink.classList.add('hidden');
};

// File selection
selectBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
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

qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = parseFloat(qualitySlider.value).toFixed(1);
});

convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  resetUI();

  showStatus('Preparing video…');

  // 1) Load the MP4 into a hidden video element
  const video = document.createElement('video');
  video.src = URL.createObjectURL(selectedFile);
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {
    video.currentTime = 0;
    return new Promise(r => video.addEventListener('loadeddata', r, { once: true }));
  });

  const fps = video.frameRate || 30;

  // 2) Instantiate WebMWriter
  const quality = Math.max(0.1, parseFloat(qualitySlider.value));
  var WebMWriter = require('webm-writer');

  const writer  = new WebMWriter({
    quality,
    fileWriter: null,
    codec: 'vp9',
    frameRate: fps,
    disableWebAssembly: true
  });

  // 3) Set up canvas for capturing frames
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  let frameCount = 0;
  showStatus(`Encoding…`);

  // 4) Frame loop: stop only when the video ends
  const renderFrame = () => {
    if (video.ended) {
      finish();
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    writer.addFrame(canvas);
    frameCount++;
    showStatus(`Encoded ${frameCount} frames…`);

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(renderFrame);
    } else {
      setTimeout(renderFrame, 1000 / fps);
    }
  };

  // Kick off encoding once the video is ready
  if (video.readyState >= 2) {
    renderFrame();
  } else {
    video.addEventListener('loadeddata', renderFrame, { once: true });
  }

  // 5) Finalize and output
  async function finish() {
    showStatus('Finalizing WebM…');
    const webmBlob = await writer.complete();
    const url = URL.createObjectURL(webmBlob);

    preview.src = url;
    preview.classList.remove('hidden');

    downloadLink.href     = url;
    downloadLink.download = selectedFile.name.replace(/\.mp4$/i, '') + '.webm';
    downloadLink.classList.remove('hidden');

    showStatus('Done!');
  }
});

resetUI();
