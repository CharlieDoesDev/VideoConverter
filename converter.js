// converter.js
// No external libs needed for actual conversion!

// Grab DOM nodes
const dropzone        = document.getElementById('dropzone');
const fileInput       = document.getElementById('fileInput');
const progressWrapper = document.getElementById('progress-container');
const progressBar     = document.getElementById('progress-bar');
const statusText      = document.getElementById('status-text');
const outputDiv       = document.getElementById('output');

// Basic UI reset
function resetUI() {
  progressBar.style.width = '0%';
  statusText.textContent = '';
  progressWrapper.classList.add('hidden');
  outputDiv.innerHTML = '';
  dropzone.classList.remove('disabled');
  dropzone.textContent = 'Drag & drop an MP4 here, or click to select';
}
function updateProgress(pct,msg) {
  progressBar.style.width = pct + '%';
  statusText.textContent = msg || '';
}
resetUI();

// Drag & drop / click handlers
;['dragover','dragleave','drop'].forEach(evt => {
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.toggle('dragover', evt==='dragover');
    if (evt==='drop' && e.dataTransfer.files[0]) convertViaMediaRecorder(e.dataTransfer.files[0]);
  });
});
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) convertViaMediaRecorder(fileInput.files[0]);
});

async function convertViaMediaRecorder(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  dropzone.classList.add('disabled');
  progressWrapper.classList.remove('hidden');
  updateProgress(0,'Loading video…');

  // Create hidden video element
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  // Wait for metadata to load
  await new Promise(r=>video.addEventListener('loadedmetadata',r, {once:true}));
  const duration = video.duration;
  const {videoWidth: w, videoHeight: h} = video;

  // Capture its playback stream
  const stream = video.captureStream();
  let recordedChunks = [];

  // Setup MediaRecorder for WebM/VP8
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8' });
  recorder.ondataavailable = e => recordedChunks.push(e.data);
  recorder.onerror = e => {
    console.error('Recorder error:', e);
    alert('Recording failed: '+ e.error?.message);
  };

  // Keep progress in sync with playback
  video.addEventListener('timeupdate', () => {
    const pct = (video.currentTime / duration) * 100;
    updateProgress(pct, `Recording… ${Math.floor(pct)}%`);
  });

  // When playback ends, finalize
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url  = URL.createObjectURL(blob);
    const name = file.name.replace(/\.mp4$/i, '') + '.webm';

    outputDiv.innerHTML = `<a href="${url}" download="${name}">Download WebM (${w}×${h})</a>`;
    updateProgress(100,'Done');
    cleanup();
  };

  function cleanup() {
    video.pause();
    URL.revokeObjectURL(video.src);
    document.body.removeChild(video);
  }

  // Start recording as soon as we play
  recorder.start();
  await video.play();
  // Stop when video ends
  video.addEventListener('ended', () => recorder.stop(), {once:true});
}
