// js/converter.js
import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

// DOM Elements
document.body.insertAdjacentHTML('beforeend', `
  <div class="container">
    <h2>MP4 → WebM</h2>
    <div id="drop-zone">Drop MP4 here or click to select</div>
    <input type="file" id="file-input" accept="video/mp4" hidden />
    <div id="progress-container" hidden>
      <div id="progress-bar" aria-valuenow="0"></div>
      <div id="status-message"></div>
    </div>
  </div>
`);

const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');
const statusMessage     = document.getElementById('status-message');

// Event listeners
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => e.target.files[0] && handleFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  dropZone.hidden = true;
  progressContainer.hidden = false;
  updateStatus('Starting conversion...');

  try {
    const { track, samples } = await demuxMp4(file);
    await transcode(track, samples);
    updateStatus('Conversion complete!');
  } catch (err) {
    console.error(err);
    updateStatus(`Error: ${err.message}`);
    setTimeout(resetUI, 3000);
  }
}

function updateStatus(msg) {
  statusMessage.textContent = msg;
}

function updateProgress(pct) {
  const p = Math.min(100, Math.max(0, pct));
  progressBar.style.width = p + '%';
  progressBar.setAttribute('aria-valuenow', p);
}

function resetUI() {
  progressContainer.hidden = true;
  dropZone.hidden = false;
}

// Demux MP4 into track metadata + samples
async function demuxMp4(file) {
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  const mp4boxFile = MP4Box.createFile();
  let trackInfo, samples = [];

  return new Promise((resolve, reject) => {
    mp4boxFile.onError = e => reject(new Error(e));

    mp4boxFile.onReady = info => {
      trackInfo = info.tracks.find(t => t.type === 'video' && t.codec?.startsWith('avc'));
      if (!trackInfo) return reject(new Error('No H.264 track'));
      mp4boxFile.setExtractionOptions(trackInfo.id, null, { nbSamples: trackInfo.nb_samples });
      mp4boxFile.start();
    };

    mp4boxFile.onSamples = (_id, _user, arr) => samples.push(...arr);

    try {
      mp4boxFile.appendBuffer(buffer);
      mp4boxFile.flush();
    } catch (e) {
      reject(e);
    }

    // Poll until samples collected
    const check = () => {
      if (samples.length >= trackInfo.nb_samples) {
        resolve({ track: trackInfo, samples });
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// Transcode via WebCodecs & mux to WebM
async function transcode(track, samples) {
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs not supported');
  }

  const { codec, video: { width, height }, avcC, nb_samples } = track;
  // Build description from avcC
  const desc = buildAvcDescription(avcC);

  // Setup muxer
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'V_VP8', width, height, frameRate: 30 } });

  let processed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      updateProgress((processed / nb_samples) * 100 * 0.95);
    },
    error: e => { throw new Error(e); }
  });
  encoder.configure({ codec: 'vp8', width, height, bitrate: 1_000_000, framerate: 30 });

  const decoder = new VideoDecoder({
    output: frame => { encoder.encode(frame); frame.close(); },
    error: e => { throw new Error(e); }
  });
  const decCfg = { codec, description: desc };
  decoder.configure(decCfg);

  for (const s of samples) {
    const chunk = new EncodedVideoChunk({ type: s.is_rap ? 'key' : 'delta', timestamp: s.cts, data: s.data });
    decoder.decode(chunk);
  }
  await decoder.flush();
  await encoder.flush();

  muxer.finalize();
  const { buffer } = muxer.target;
  const blob = new Blob([buffer], { type: 'video/webm' });
  saveBlob(blob, 'converted.webm');
  updateProgress(100);
}

// Build Annex-B SPS/PPS description
function buildAvcDescription(avcC) {
  const pre = new Uint8Array([0,0,0,1]);
  const parts = [];
  avcC.sequenceParameterSets.forEach(s => parts.push(pre, new Uint8Array(s)));
  avcC.pictureParameterSets.forEach(p => parts.push(pre, new Uint8Array(p)));
  return concat(parts).buffer;
}

function concat(arrays) {
  let len = 0; arrays.forEach(a => len += a.length);
  const out = new Uint8Array(len); let off = 0;
  arrays.forEach(a => { out.set(a, off); off += a.length; });
  return out;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
