// Pull in WebM muxer as an ES module
import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/webm-muxer@5.1.2?module';

// Grab DOM elements
const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');
const statusMessage     = document.getElementById('status-message');

// Highlight drop zone and wire up file selection
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => e.target.files[0] && handleFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]);
});

/**
 * Kick off conversion
 */
async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    return alert('Please select an MP4 file.');
  }
  dropZone.hidden = true;
  progressContainer.hidden = false;
  updateStatus('Demuxing MP4…');

  try {
    const { track, samples } = await demuxMp4(file);
    updateStatus('Transcoding frames…');
    await transcode(track, samples);
    updateStatus('Conversion complete!');
  } catch (err) {
    console.error(err);
    updateStatus(`Error: ${err.message}`);
    setTimeout(resetUI, 3000);
  }
}

/**
 * Demux an MP4 file into its H.264 track and raw samples
 */
async function demuxMp4(file) {
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  const mp4boxFile = MP4Box.createFile();
  let trackInfo, samples = [];

  return new Promise((resolve, reject) => {
    mp4boxFile.onError = e => reject(new Error(e));

    mp4boxFile.onReady = info => {
      trackInfo = info.tracks.find(t => 
        t.type === 'video' && t.codec?.startsWith('avc')
      );
      if (!trackInfo) {
        return reject(new Error('No H.264 video track found'));
      }
      mp4boxFile.setExtractionOptions(trackInfo.id, null, { nbSamples: trackInfo.nb_samples });
      mp4boxFile.start();  
    };

    mp4boxFile.onSamples = (_id, _user, arr) => {
      samples.push(...arr);
      updateProgress(Math.min(20, samples.length / trackInfo.nb_samples * 20));
    };

    try {
      mp4boxFile.appendBuffer(buffer);
      mp4boxFile.flush();
    } catch (e) {
      reject(e);
    }

    // Poll until done
    (function checkDone() {
      if (trackInfo && samples.length >= trackInfo.nb_samples) {
        resolve({ track: trackInfo, samples });
      } else {
        setTimeout(checkDone, 50);
      }
    })();
  });
}

/**
 * Decode with WebCodecs → encode VP8 → mux into WebM
 */
async function transcode(track, samples) {
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs API not supported');
  }

  // Build AVC description (SPS/PPS)
  const { codec, video: { width, height }, avcC, nb_samples } = track;
  if (!avcC) throw new Error('Missing codec config (avcC)');

  const annexB = [];
  const prefix = new Uint8Array([0,0,0,1]);
  for (let sps of avcC.sequenceParameterSets) annexB.push(prefix, new Uint8Array(sps));
  for (let pps of avcC.pictureParameterSets)    annexB.push(prefix, new Uint8Array(pps));
  const description = concat(annexB).buffer;

  // Setup WebM muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'V_VP8', width, height, frameRate: 30 }
  });

  let processed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      updateProgress(20 + (processed / nb_samples) * 75);
    },
    error: e => { throw e; }
  });
  encoder.configure({ codec: 'vp8', width, height, bitrate: 1_000_000, framerate: 30 });

  const decoder = new VideoDecoder({
    output: frame => { 
      encoder.encode(frame); 
      frame.close();
    },
    error: e => { throw e; }
  });
  decoder.configure({ codec, description });

  // Process all samples
  for (let s of samples) {
    const chunk = new EncodedVideoChunk({
      type:      s.is_rap ? 'key' : 'delta',
      timestamp: s.cts,
      data:      s.data
    });
    decoder.decode(chunk);
  }
  await decoder.flush();
  await encoder.flush();

  // Finalize WebM and trigger download
  muxer.finalize();
  const { buffer } = muxer.target;
  const blob = new Blob([buffer], { type: 'video/webm' });
  saveBlob(blob, file.name.replace(/\.mp4$/i, '.webm'));
  updateProgress(100);
}

/** Concatenate many Uint8Arrays into one */
function concat(chunks) {
  let length = 0;
  for (let c of chunks) length += c.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (let c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/** Update progress bar (0–100) */
function updateProgress(pct) {
  const p = Math.min(100, Math.max(0, pct));
  progressBar.style.width = p + '%';
}

/** Update status text */
function updateStatus(msg) {
  statusMessage.textContent = msg;
}

/** Reset UI on error or after finishing */
function resetUI() {
  progressContainer.hidden = true;
  dropZone.hidden = false;
}

/** Trigger a download from a Blob */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
