// js/converter.js
import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');

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
  // 1) Demux with mp4box.js and extract codec info + samples
  const arrayBuffer = await file.arrayBuffer();
  arrayBuffer.fileStart = 0;
  const mp4boxFile = MP4Box.createFile();

  let codecString = '';
  let codecConfig = null;
  let trackWidth = 0, trackHeight = 0, totalSamples = 0;
  const samples = [];

  // Wrap demux in a Promise so we wait for onReady → start() to fire
  await new Promise((resolve, reject) => {
    mp4boxFile.onError = e => reject(e);

    mp4boxFile.onReady = info => {
      // find H264 video track
      const track = info.tracks.find(t => t.type === 'video' && t.codec.startsWith('avc'));
      if (!track) {
        reject(new Error('No H.264 video track found'));
        return;
      }
      codecString = track.codec;  // e.g. "avc1.42E01E"
      if (track.avcDecoderConfigRecord?.buffer) {
        codecConfig = track.avcDecoderConfigRecord.buffer;
      }
      trackWidth = track.video.width;
      trackHeight = track.video.height;
      totalSamples = track.nb_samples;

      // ask mp4box to extract all samples
      mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: totalSamples });
      mp4boxFile.start();
    };

    mp4boxFile.onSamples = (_id, _user, sArr) => {
      samples.push(...sArr);
    };

    mp4boxFile.appendBuffer(arrayBuffer);
    mp4boxFile.flush();

    // schedule a check at end of event loop
    setTimeout(() => {
      if (!codecString) {
        reject(new Error('mp4box failed to parse track header'));
      } else {
        resolve();
      }
    }, 0);
  });

  // 2) WebCodecs support check
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs API not supported in this browser');
  }

  // 3) Set up WebM muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP8',
      width: trackWidth,
      height: trackHeight,
      frameRate: 30,
    },
  });

  // 4) Configure encoder
  let processed = 0;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      updateProgress((processed / totalSamples) * 100);
    },
    error: e => { throw e; },
  });
  videoEncoder.configure({
    codec: 'vp8',
    width: trackWidth,
    height: trackHeight,
    bitrate: 1_000_000,
    framerate: 30,
  });

  // 5) Configure decoder *after* codecString is set
  const videoDecoder = new VideoDecoder({
    output: frame => {
      videoEncoder.encode(frame);
      frame.close();
    },
    error: e => { throw e; },
  });
  const decoderConfig = { codec: codecString };
  if (codecConfig) decoderConfig.description = codecConfig;
  videoDecoder.configure(decoderConfig);

  // 6) Run decode → encode
  for (const s of samples) {
    const chunk = new EncodedVideoChunk({
      type: s.is_rap ? 'key' : 'delta',
      timestamp: s.cts,
      data: s.data,
    });
    videoDecoder.decode(chunk);
  }
  await videoDecoder.flush();
  await videoEncoder.flush();

  // 7) Finalize WebM and trigger download
  muxer.finalize();
  const { buffer: webmBuffer } = muxer.target;
  const blob = new Blob([webmBuffer], { type: 'video/webm' });
  saveBlob(blob, file.name.replace(/\.mp4$/i, '.webm'));
  updateProgress(100);
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
