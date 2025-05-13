// converter.js
// Requires in index.html:
// <script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.2/build/webm-muxer.js"></script>

const dropzone        = document.getElementById('dropzone');
const fileInput       = document.getElementById('fileInput');
const progressWrapper = document.getElementById('progress-container');
const progressBar     = document.getElementById('progress-bar');
const statusText      = document.getElementById('status-text');
const outputDiv       = document.getElementById('output');

function resetUI() {
  progressBar.style.width = '0%';
  statusText.textContent = '';
  progressWrapper.classList.add('hidden');
  outputDiv.innerHTML = '';
  dropzone.classList.remove('disabled');
  dropzone.textContent = 'Drag & drop an MP4 here, or click to select';
}

function updateProgress(pct, msg='') {
  progressBar.style.width = `${pct}%`;
  statusText.textContent = msg;
}

resetUI();

// drag & drop / click
;['dragover','dragleave','drop'].forEach(evt => {
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.toggle('dragover', evt==='dragover');
    if (evt==='drop' && e.dataTransfer.files[0]) {
      convertViaMediaRecorder(e.dataTransfer.files[0]);
    }
  });
});
dropzone.addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', ()=> fileInput.files[0] && convertViaMediaRecorder(fileInput.files[0]));

async function convertViaMediaRecorder(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  dropzone.classList.add('disabled');
  progressWrapper.classList.remove('hidden');
  updateProgress(0, 'Loading video…');

  // 1) Create hidden video element
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.style.display = 'none';
  document.body.appendChild(video);
  await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
  const duration = video.duration;
  const speedFactor = 4;                // record at 4× speed
  video.playbackRate = speedFactor;
  const { videoWidth: w, videoHeight: h } = video;

  // 2) Start MediaRecorder (captures both audio + video at 4×)
  const stream = video.captureStream();
  const recorded = [];
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8,opus' });
  recorder.ondataavailable = e => recorded.push(e.data);
  recorder.onerror = e => {
    console.error('Recorder error:', e);
    alert('Recording failed: ' + e.error?.message);
  };

  // 3) Drive progress by playback
  video.addEventListener('timeupdate', () => {
    const pct = (video.currentTime / duration) * 100;
    updateProgress(pct, `Recording… ${Math.floor(pct)}%`);
  });

  // 4) When playback ends, stop recorder
  recorder.start();
  await video.play();
  await new Promise(r => video.addEventListener('ended', r, { once: true }));
  recorder.stop();
  await new Promise(r => recorder.addEventListener('stop', r));

  updateProgress(80, 'Muxing…');

  // 5) Remux with timestamp scaling
  const fastBuf = await new Blob(recorded, { type:'video/webm' }).arrayBuffer();
  const demuxer  = new WebMMuxer.Demuxer(new Uint8Array(fastBuf));
  const muxer    = new WebMMuxer.Muxer({
    target: 'buffer',
    audio:  { codec: 'A_OPUS' },
    video:  { codec: 'V_VP8' }
  });

  let cluster;
  while ((cluster = demuxer.readCluster())) {
    for (const block of cluster.payload) {
      const scaledTs = block.timestamp * speedFactor;
      if (block.trackNumber === demuxer.tracks.video.trackNumber) {
        muxer.addVideoChunk(
          new EncodedVideoChunk({
            type:      block.keyframe ? 'key' : 'delta',
            timestamp: scaledTs,
            data:      block.data
          })
        );
      } else if (block.trackNumber === demuxer.tracks.audio.trackNumber) {
        muxer.addAudioChunk(block.data, { timestamp: scaledTs });
      }
    }
  }

  const outBuf  = muxer.finalize();
  const outBlob = new Blob([outBuf], { type:'video/webm' });
  const url     = URL.createObjectURL(outBlob);
  const name    = file.name.replace(/\.mp4$/i, '') + '.webm';

  // 6) Cleanup & present download
  video.pause();
  URL.revokeObjectURL(video.src);
  document.body.removeChild(video);

  outputDiv.innerHTML = `<a href="${url}" download="${name}">Download WebM (${w}×${h})</a>`;
  updateProgress(100, 'Done');
}
