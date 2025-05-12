import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');

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
    return alert('Please select an MP4 file.');
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
  // 1) Demux & collect all samples + track metadata
  const { track, samples } = await demuxMp4(file);
  const {
    codec: codecString,
    video: { width: trackWidth, height: trackHeight },
    avcC,
    nb_samples: totalSamples
  } = track;

  // 2) Build AVC ‘description’ from SPS/PPS for configure()
  let descriptionBuffer = null;
  if (avcC) {
    const prefix = new Uint8Array([0,0,0,1]);
    const parts = [];
    for (const sps of avcC.sequenceParameterSets) {
      parts.push(prefix, new Uint8Array(sps));
    }
    for (const pps of avcC.pictureParameterSets) {
      parts.push(prefix, new Uint8Array(pps));
    }
    descriptionBuffer = concat(parts).buffer;
  }

  // 3) Check WebCodecs availability
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs API not supported in this browser');
  }

  // 4) Init WebM muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP8',
      width: trackWidth,
      height: trackHeight,
      frameRate: 30,
    },
  });

  // 5) Configure VideoEncoder
  let processed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      updateProgress(++processed / totalSamples * 100);
    },
    error: e => { throw e; }
  });
  encoder.configure({
    codec: 'vp8',
    width: trackWidth,
    height: trackHeight,
    bitrate: 1_000_000,
    framerate: 30,
  });

  // 6) Configure VideoDecoder (with codec + description)
  const decoder = new VideoDecoder({
    output: frame => {
      encoder.encode(frame);
      frame.close();
    },
    error: e => { throw e; }
  });
  const decConfig = { codec: codecString };
  if (descriptionBuffer) decConfig.description = descriptionBuffer;
  decoder.configure(decConfig);

  // 7) Push through decode→encode
  for (const s of samples) {
    const chunk = new EncodedVideoChunk({
      type:      s.is_rap ? 'key' : 'delta',
      timestamp: s.cts,
      data:      s.data,
    });
    decoder.decode(chunk);
  }
  await decoder.flush();
  await encoder.flush();

  // 8) Finalize & download
  muxer.finalize();
  const { buffer: webmBuffer } = muxer.target;
  const blob = new Blob([webmBuffer], { type: 'video/webm' });
  saveBlob(blob, file.name.replace(/\.mp4$/i, '.webm'));
  updateProgress(100);
}

function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function demuxMp4(file) {
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  const mp4boxFile = MP4Box.createFile();

  return new Promise((resolve, reject) => {
    let trackInfo;
    const samples = [];

    mp4boxFile.onError = err => reject(err);
    mp4boxFile.onReady = info => {
      trackInfo = info.tracks.find(t =>
        t.type === 'video' && t.codec.startsWith('avc')
      );
      if (!trackInfo) {
        return reject(new Error('No H.264 video track found'));
      }
      mp4boxFile.setExtractionOptions(
        trackInfo.id,
        null,
        { nbSamples: trackInfo.nb_samples }
      );
      mp4boxFile.start();
    };

    mp4boxFile.onSamples = (_id, _user, sArr) => {
      samples.push(...sArr);
      if (samples.length >= trackInfo.nb_samples) {
        resolve({ track: trackInfo, samples });
      }
    };

    mp4boxFile.appendBuffer(buffer);
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
