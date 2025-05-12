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
  // 1. Read & demux MP4
  const arrayBuffer = await file.arrayBuffer();
  arrayBuffer.fileStart = 0;
  const mp4boxFile = MP4Box.createFile();
  let videoCodecString = '';
  let videoCodecConfig = null;
  let totalSamples = 0;
  let processedSamples = 0;
  const samples = [];

  mp4boxFile.onError = e => { throw new Error(e); };
  mp4boxFile.onReady = info => {
    const track = info.tracks.find(t => t.codec.startsWith('avc'));
    if (!track) throw new Error('No H.264 track found in MP4');
    videoCodecString = track.codec;               // e.g. "avc1.42E01E"
    if (track.avcDecoderConfigRecord?.buffer) {
      videoCodecConfig = track.avcDecoderConfigRecord.buffer;
    }
    totalSamples = track.nb_samples;
    mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: totalSamples });
    mp4boxFile.start();
  };
  mp4boxFile.onSamples = (_id, _user, sArr) => samples.push(...sArr);

  mp4boxFile.appendBuffer(arrayBuffer);
  mp4boxFile.flush();

  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs API not supported in this browser');
  }

  // 2. Set up WebM muxer
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

  // 3. Configure VideoEncoder
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processedSamples++;
      updateProgress((processedSamples / totalSamples) * 100);
    },
    error: e => { throw e; }
  });
  videoEncoder.configure({
    codec: 'vp8',
    width: firstDesc.width,
    height: firstDesc.height,
    bitrate: 1_000_000,
    framerate: 30
  });

  // 4. Configure VideoDecoder
  const videoDecoder = new VideoDecoder({
    output: frame => {
      videoEncoder.encode(frame);
      frame.close();
    },
    error: e => { throw e; }
  });
  const decoderConfig = { codec: videoCodecString };
  if (videoCodecConfig) {
    decoderConfig.description = videoCodecConfig;
  }
  videoDecoder.configure(decoderConfig);

  // 5. Decode → Re-encode pipeline
  for (const sample of samples) {
    const chunk = new EncodedVideoChunk({
      type: sample.is_rap ? 'key' : 'delta',
      timestamp: sample.cts,
      data: sample.data
    });
    videoDecoder.decode(chunk);
  }
  await videoDecoder.flush();
  await videoEncoder.flush();

  // 6. Finalize & download
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
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 100);
}
