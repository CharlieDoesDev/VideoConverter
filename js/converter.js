// js/converter.js

// UMD globals from your HTML:
// <script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.2/build/webm-muxer.js"></script>
// <script src="https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js"></script>
const { Muxer, ArrayBufferTarget } = WebMMuxer;
const { createFile: createMP4BoxFile } = MP4Box;

// Elements
const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');
const statusMessage     = document.getElementById('status-message');

// Wire up UI
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

async function demuxMp4(file) {
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  const mp4boxFile = createMP4BoxFile();
  let trackInfo, samples = [];
  return new Promise((resolve, reject) => {
    mp4boxFile.onError = e => reject(new Error(e));
    mp4boxFile.onReady = info => {
      trackInfo = info.tracks.find(t => t.type === 'video' && t.codec?.startsWith('avc'));
      if (!trackInfo) return reject(new Error('No H.264 track found'));
      mp4boxFile.setExtractionOptions(trackInfo.id, null, { nbSamples: trackInfo.nb_samples });
      mp4boxFile.start();
    };
    mp4boxFile.onSamples = (_id, _user, arr) => {
      samples.push(...arr);
      updateProgress(Math.min(20, samples.length / trackInfo.nb_samples * 20));
    };
    try { mp4boxFile.appendBuffer(buffer); mp4boxFile.flush(); }
    catch(e){ reject(e); }
    (function checkDone() {
      if (trackInfo && samples.length >= trackInfo.nb_samples) resolve({ track: trackInfo, samples });
      else setTimeout(checkDone, 50);
    })();
  });
}

async function transcode(track, samples, originalName) {
  if (!window.VideoDecoder || !window.VideoEncoder) throw new Error('WebCodecs not supported');

  const { codec, video:{width, height}, avcDecoderConfigRecord, nb_samples } = track;

  // build description: try avcDecoderConfigRecord, else manual extract
  let description = avcDecoderConfigRecord?.buffer;
  if (!description) {
    description = extractSpsPps(samples);
    if (!description) throw new Error('Could not extract SPS/PPS for decoder');
  }

  // muxer setup
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video:{ codec:'V_VP8', width, height, frameRate:30 }});
  let processed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      updateProgress(20 + (processed/nb_samples)*75);
    },
    error: e=>{ throw new Error(`Encode error: ${e.message}`); }
  });
  encoder.configure({ codec:'vp8', width, height, bitrate:1_000_000, framerate:30 });

  const decoder = new VideoDecoder({
    output: frame => { encoder.encode(frame); frame.close(); },
    error: e => { throw new Error(`Decode error: ${e.message}`); }
  });
  decoder.configure({ codec, description });

  for (let s of samples) {
    const chunk = new EncodedVideoChunk({ type: s.is_rap?'key':'delta', timestamp:s.cts, data:s.data });
    decoder.decode(chunk);
  }
  await decoder.flush();
  await encoder.flush();

  muxer.finalize();
  const { buffer } = muxer.target;
  saveBlob(new Blob([buffer],{type:'video/webm'}), originalName.replace(/\.mp4$/i,'.webm'));
  updateProgress(100);
}

// scans first few samples for Annex-B SPS (type=7) and PPS (8)
function extractSpsPps(samples) {
  const prefix = new Uint8Array([0,0,0,1]);
  let sps, pps;
  outer: for (let i=0;i<Math.min(samples.length,10);i++){
    const data = new Uint8Array(samples[i].data);
    for (let j=0;j+4<data.length;j++){
      if (data[j]===0 && data[j+1]===0 && data[j+2]===0 && data[j+3]===1){
        const nalType = data[j+4]&0x1F;
        if (nalType===7 && !sps) {
          // read until next start code or end
          const end = findNextStart(data,j+4);
          sps = data.subarray(j,end);
        }
        if (nalType===8 && !pps) {
          const end = findNextStart(data,j+4);
          pps = data.subarray(j,end);
        }
        if (sps && pps) break outer;
      }
    }
  }
  if (sps && pps) {
    // concat prefix+sps + prefix+pps
    const out = new Uint8Array(prefix.length+sps.length+prefix.length+pps.length);
    let off=0;
    out.set(prefix,off); off+=prefix.length;
    out.set(sps,off);    off+=sps.length;
    out.set(prefix,off); off+=prefix.length;
    out.set(pps,off);
    return out.buffer;
  }
  return null;
}
function findNextStart(data, pos){
  for (let i=pos;i+4<data.length;i++){
    if (data[i]===0&&data[i+1]===0&&data[i+2]===0&&data[i+3]===1) return i;
  }
  return data.length;
}

function updateProgress(p){ progressBar.style.width = Math.min(100,Math.max(0,p))+'%'; }
function updateStatus(m){ statusMessage.textContent = m; }
function resetUI(){ progressContainer.hidden=true; dropZone.hidden=false; }
function saveBlob(blob,name){
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=name; document.body.appendChild(a);
  a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),100);
}
