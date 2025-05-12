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
  // 1) Demux + extract track metadata + samples
  const arrayBuffer = await file.arrayBuffer();
  arrayBuffer.fileStart = 0;
  const mp4boxFile = MP4Box.createFile();
  let codecString = '';
  let descriptionBuffer = null;
  let trackWidth = 0, trackHeight = 0, totalSamples = 0;
  const samples = [];

  await new Promise((resolve, reject) => {
    mp4boxFile.onError = e => reject(e);

    mp4boxFile.onReady = info => {
      // find the H.264 video track
      const track = info.tracks.find(t => t.type === 'video' && t.codec.startsWith('avc'));
      if (!track) return reject(new Error('No H.264 video track found'));

      codecString   = track.codec;                 // e.g. "avc1.42E01E"
      trackWidth    = track.video.width;
      trackHeight   = track.video.height;
      totalSamples  = track.nb_samples;

      // Build the `description` ArrayBuffer from SPS/PPS
      if (track.avcC) {
        const prefix = new Uint8Array([0, 0, 0, 1]);
        const parts  = [];
        for (const sps of track.avcC.sequenceParameterSets) {
          parts.push(prefix, new Uint8Array(sps));
        }
        for (const pps of track.avcC.pictureParameterSets) {
          parts.push(prefix, new Uint8Array(pps));
        }
        descriptionBuffer = concatUint8Arrays(parts).buffer;
      }

      // ask mp4box to extract all video samples
      mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: totalSamples });
      mp4boxFile.start();
    };

    mp4boxFile.onSamples = (_id, _user, sArr) => {
      samples.push(...sArr);
    };

    mp4boxFile.appendBuffer(arrayBuffer);
    mp4boxFile.flush();

    // wait one tick to ensure onReady fired
    setTimeout(() => {
      codecString ? resolve() : reject(new Error('Failed to parse track header'));
    }, 0);
  });

  // 2) WebCodecs check
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs API not supported in this browser');
  }

  // 3) WebM muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP8',
      width: trackWidth,
      height: trackHeight,
      frameRate: 30,
    },
  });

  // 4) VideoEncoder
  let processed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      updateProgress((processed / totalSamples) * 100);
    },
    error: e => { throw e; },
  });
  encoder.configure({
    codec: 'vp8',
    width: trackWidth,
    height: trackHeight,
    bitrate: 1_000_000,
    framerate: 30,
  });

  // 5) VideoDecoder (now with .description)
  const decoder = new VideoDecoder({
    output: frame => {
      encoder.encode(frame);
      frame.close();
    },
    error: e => { throw e; },
  });
  const decConfig = { codec: codecString };
  if (descriptionBuffer) decConfig.description = descriptionBuffer;
  decoder.configure(decConfig);

  // 6) Feed decode→encode
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

  // 7) Finalize & download
  muxer.finalize();
  const { buffer: webmBuffer } = muxer.target;
  const blob = new Blob([webmBuffer], { type: 'video/webm' });
  saveBlob(blob, file.name.replace(/\.mp4$/i, '.webm'));
  updateProgress(100);
}

// Helper: concatenate many Uint8Array chunks
function concatUint8Arrays(chunks) {
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result   = new Uint8Array(totalLen);
  let offset     = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
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
