import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'webm-muxer'; // use named exports :contentReference[oaicite:0]{index=0}

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
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
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
  let totalSamples = 0, processedSamples = 0;
  const samples = [];

  mp4boxFile.onError = e => { throw new Error(e); };
  mp4boxFile.onReady = info => {
    const track = info.tracks.find(t => t.codec.startsWith('avc'));
    if (!track) throw new Error('No H.264 track found');
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

  // 2. Set up the WebM muxer with an ArrayBufferTarget
  const firstDesc = samples[0].description;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),      // gather output into memory
    video: {
      codec: 'V_VP8',
      width: firstDesc.width,
      height: firstDesc.height,
      frameRate: 30
    }
  });

  // 3. Configure decoder & encoder
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

  const videoDecoder = new VideoDecoder({
    output: frame => {
      videoEncoder.encode(frame);
      frame.close();
    },
    error: e => { throw e; }
  });
  videoDecoder.configure({ codec: firstDesc.codec });

  // 4. Decode → Re-encode pipeline
  for (const s of samples) {
    const chunk = new EncodedVideoChunk({
      type: s.is_rap ? 'key' : 'delta',
      timestamp: s.cts,
      data: s.data
    });
    videoDecoder.decode(chunk);
  }
  await videoDecoder.flush();
  await videoEncoder.flush();

  // 5. Finalize muxer & download
  muxer.finalize();                        // finalize container
  const { buffer: webmBuffer } = muxer.target; // extract the ArrayBuffer
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
