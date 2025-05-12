// js/converter.js
import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
  if (file.type !== 'video/mp4') {
    alert('Please select an MP4 file.');
    return;
  }
  dropZone.hidden = true;
  progressContainer.hidden = false;
  try {
    await convertMp4ToWebM(file);
  } catch (err) {
    console.error(err);
    alert('Conversion failed: ' + err.message);
  }
}

async function convertMp4ToWebM(file) {
  const arrayBuffer = await file.arrayBuffer();

  // 1) Demux MP4 into raw samples + extract codec config
  const { samples, videoCodecString, videoCodecConfig, totalSamples } = await demuxMP4(arrayBuffer);

  // 2) Prepare WebM muxer
  const firstDesc = samples[0].description;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP8',
      width: firstDesc.width,
      height: firstDesc.height,
      frameRate: 30
    }
  });

  // 3) Configure VideoEncoder
  let processed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      updateProgress((processed / totalSamples) * 100);
    },
    error: e => { throw e; }
  });
  encoder.configure({
    codec: 'vp8',
    width: firstDesc.width,
    height: firstDesc.height,
    bitrate: 1_000_000,
    framerate: 30
  });

  // 4) Configure VideoDecoder
  const decoder = new VideoDecoder({
    output: frame => {
      encoder.encode(frame);
      frame.close();
    },
    error: e => { throw e; }
  });
  const decodeConfig = { codec: videoCodecString };
  if (videoCodecConfig) {
    decodeConfig.description = videoCodecConfig;
  }
  decoder.configure(decodeConfig);

  // 5) Run decode→encode
  for (const s of samples) {
    const chunk = new EncodedVideoChunk({
      type: s.is_rap ? 'key' : 'delta',
      timestamp: s.cts,
      data: s.data
    });
    decoder.decode(chunk);
  }
  await decoder.flush();
  await encoder.flush();

  // 6) Finalize WebM and trigger download
  muxer.finalize();
  const { buffer: webmBuffer } = muxer.target;
  const blob = new Blob([webmBuffer], { type: 'video/webm' });
  saveBlob(blob, file.name.replace(/\.mp4$/i, '.webm'));
  updateProgress(100);
}

// Demux helper returns when all samples are collected
function demuxMP4(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const mp4boxFile = MP4Box.createFile();
    let videoCodecString = '';
    let videoCodecConfig = null;
    let totalSamples = 0;
    const samples = [];

    mp4boxFile.onError = e => reject(new Error(e));
    mp4boxFile.onReady = info => {
      const track = info.tracks.find(t => t.codec.startsWith('avc'));
      if (!track) return reject(new Error('No H.264 track found'));
      videoCodecString = track.codec; // e.g. "avc1.42E01E"
      if (track.avcDecoderConfigRecord?.buffer) {
        videoCodecConfig = track.avcDecoderConfigRecord.buffer;
      }
      totalSamples = track.nb_samples;
      mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: totalSamples });
      mp4boxFile.start();
      // Immediately flush so onSamples is called
      mp4boxFile.flush();
    };
    mp4boxFile.onSamples = (_id, _user, sArr) => {
      samples.push(...sArr);
      if (samples.length >= totalSamples) {
        mp4boxFile.stop();
        resolve({ samples, videoCodecString, videoCodecConfig, totalSamples });
      }
    };

    // Kick off demux
    arrayBuffer.fileStart = 0;
    mp4boxFile.appendBuffer(arrayBuffer);
    mp4boxFile.flush();
  });
}

function updateProgress(pct) {
  progressBar.style.width = `${pct}%`;
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 100);
}
