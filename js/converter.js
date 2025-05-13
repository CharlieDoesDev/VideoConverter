// js/converter.js

// We’re using the UMD build, so WebMMuxer is global
const { Muxer, ArrayBufferTarget } = WebMMuxer;
const { createFile: createMP4BoxFile } = MP4Box;

// DOM elements
const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');
const statusMessage     = document.getElementById('status-message');

// Wire up drag & drop / click
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => e.target.files[0] && handleFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]);
});

// Main entry
async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  dropZone.hidden = true;
  progressContainer.hidden = false;
  updateStatus('Demuxing MP4…');

  try {
    const { track, samples } = await demuxMp4(file);
    updateStatus('Transcoding frames…');
    await transcode(track, samples, file.name);
    updateStatus('Conversion complete!');
  } catch (err) {
    console.error(err);
    updateStatus(`Error: ${err.message}`);
    setTimeout(resetUI, 3000);
  }
}

/**
 * Demux MP4 → track metadata + raw H264 samples
 */
async function demuxMp4(file) {
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  const mp4boxFile = createMP4BoxFile();
  let trackInfo, samples = [];

  return new Promise((resolve, reject) => {
    mp4boxFile.onError = e => reject(new Error(e));

    mp4boxFile.onReady = info => {
      trackInfo = info.tracks.find(t =>
        t.type === 'video' && t.codec?.startsWith('avc')
      );
      if (!trackInfo) return reject(new Error('No H.264 track'));

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
 * Transcode via WebCodecs + mux to WebM
 */
async function transcode(track, samples, originalName) {
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs not supported');
  }

  const { codec, video: { width, height }, avcDecoderConfigRecord, nb_samples } = track;

  // Try to get SPS/PPS descriptor
  let description = avcDecoderConfigRecord?.buffer || null;

  // Setup muxer
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
    error: e => { throw new Error(`Encoding error: ${e.message}`); }
  });
  encoder.configure({ codec: 'vp8', width, height, bitrate: 1_000_000, framerate: 30 });

  const decoder = new VideoDecoder({
    output: frame => { encoder.encode(frame); frame.close(); },
    error: e => { throw new Error(`Decoding error: ${e.message}`); }
  });

  // Configure decoder, with fallback if description missing
  const decConfig = { codec };
  if (description) decConfig.description = description;

  try {
    decoder.configure(decConfig);
  } catch (e) {
    console.warn('Primary decoder.configure failed, retrying without description', e);
    decoder.configure({ codec });  // second attempt
  }

  // Feed samples
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

  // Finalize & save
  muxer.finalize();
  const { buffer } = muxer.target;
  const blob = new Blob([buffer], { type: 'video/webm' });
  saveBlob(blob, originalName.replace(/\.mp4$/i, '.webm'));
  updateProgress(100);
}

// Helpers
function updateProgress(pct) {
  const p = Math.min(100, Math.max(0, pct));
  progressBar.style.width = `${p}%`;
}
function updateStatus(msg) {
  statusMessage.textContent = msg;
}
function resetUI() {
  progressContainer.hidden = true;
  dropZone.hidden = false;
}
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
