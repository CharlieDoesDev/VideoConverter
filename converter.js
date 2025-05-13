// converter.js
// index.html must include mp4box.js and webm-muxer UMD before this script.

(async function() {
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const { createFile: createMP4BoxFile } = MP4Box;

  // UI references
  const dropzone        = document.getElementById('dropzone');
  const fileInput       = document.getElementById('fileInput');
  const progressWrapper = document.getElementById('progress-container');
  const progressBar     = document.getElementById('progress-bar');
  const statusText      = document.getElementById('status-text');
  const outputDiv       = document.getElementById('output');

  // Helpers
  function resetUI() {
    progressBar.style.width = '0%';
    statusText.textContent = '';
    progressWrapper.classList.add('hidden');
    outputDiv.innerHTML = '';
    dropzone.classList.remove('disabled');
    dropzone.textContent = 'Drag & drop an MP4 here, or click to select';
  }
  function updateProgress(pct, msg = '') {
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    statusText.textContent = msg;
  }
  resetUI();

  // Drag & drop + click
  ;['dragover','dragleave','drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.toggle('dragover', evt === 'dragover');
      if (evt === 'drop' && e.dataTransfer.files[0]) start(e.dataTransfer.files[0]);
    });
  });
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => fileInput.files[0] && start(fileInput.files[0]));

  async function start(file) {
    if (!file.name.match(/\.mp4$/i)) {
      return alert('Please pick an MP4 file.');
    }
    dropzone.classList.add('disabled');
    progressWrapper.classList.remove('hidden');
    updateProgress(0, 'Demuxing…');

    // 1) Demux
    const { track, samples } = await demuxMp4(file);
    const total = samples.length;
    updateProgress(10, 'Demux complete');

    // 2) Build VideoDecoderConfig
    let decCfg = { codec: track.codec };
    if (track.video) {
      decCfg.codedWidth  = track.video.width;
      decCfg.codedHeight = track.video.height;
    }

    // Always supply SPS/PPS for H.264
    if (track.codec.startsWith('avc1')) {
      let desc;
      if (track.avcC) {
        const prefix = new Uint8Array([0,0,0,1]), parts = [];
        track.avcC.sequenceParameterSets.forEach(s => parts.push(prefix, new Uint8Array(s)));
        track.avcC.pictureParameterSets.forEach(p => parts.push(prefix, new Uint8Array(p)));
        desc = concat(parts).buffer;
      } else {
        desc = extractSpsPps(samples[0].data);
      }
      if (!desc) throw new Error('Unable to extract H.264 SPS/PPS');
      decCfg.description = desc;
    }
    // HEVC / VP9 / AV1
    if (track.codec.startsWith('hvc1') && track.hvcC?.buffer) decCfg.description = track.hvcC.buffer;
    if (track.codec.startsWith('vp09') && track.vpcC?.buffer) decCfg.description = track.vpcC.buffer;
    if (track.codec.startsWith('av01') && track.av1C?.buffer) decCfg.description = track.av1C.buffer;

    // 3) Check support & fallback H.264 baseline
    updateProgress(20, 'Checking codec support…');
    let sup = await VideoDecoder.isConfigSupported(decCfg);
    if (!sup.supported && track.codec.startsWith('avc1')) {
      console.warn('Falling back to baseline profile');
      decCfg.codec = 'avc1.42001E';
      sup = await VideoDecoder.isConfigSupported(decCfg);
    }
    if (!sup.supported) throw new Error(`Cannot decode ${decCfg.codec}`);

    // 4) VP8 encoder config
    const encCfg = {
      codec: 'vp8',
      width: track.video.width,
      height: track.video.height,
      bitrate: track.bitrate || 1_000_000,
      framerate: 30
    };
    const encSup = await VideoEncoder.isConfigSupported(encCfg);
    if (!encSup.supported) throw new Error('VP8 encoding not supported');

    // 5) Init muxer, decoder, encoder
    updateProgress(30, 'Initializing…');
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video:  { codec: 'V_VP8', width: track.video.width, height: track.video.height }
    });

    let decoded = 0;
    const decoder = new VideoDecoder({
      output: frame => {
        encoder.encode(frame);
        frame.close();
        decoded++;
        updateProgress(30 + (decoded/total)*60, `Frame ${decoded}/${total}`);
      },
      error: e => { throw e; }
    });
    decoder.configure(decCfg);

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { throw e; }
    });
    encoder.configure(encCfg);

    // 6) Decode → Encode
    updateProgress(40, 'Transcoding…');
    for (const s of samples) {
      const chunk = new EncodedVideoChunk({
        type:      s.is_rap ? 'key' : 'delta',
        timestamp: Math.round(s.cts * 1e6 / track.timescale),
        data:      new Uint8Array(s.data)
      });
      decoder.decode(chunk);
    }

    // 7) Flush & finalize
    await decoder.flush();
    await encoder.flush();
    updateProgress(95, 'Finalizing…');
    const webmBuf = muxer.finalize();
    const blob   = new Blob([webmBuf], { type: 'video/webm' });
    const url    = URL.createObjectURL(blob);
    const name   = file.name.replace(/\.mp4$/i, '') + '.webm';

    outputDiv.innerHTML = `<a href="${url}" download="${name}">Download WebM</a>`;
    updateProgress(100, 'Done');
  }

  // demux via mp4box.js
  async function demuxMp4(file) {
    const buf = await file.arrayBuffer();
    buf.fileStart = 0;
    const mp4 = createMP4BoxFile();
    let ti, samples = [];

    return new Promise((res, rej) => {
      mp4.onError = e => rej(e);
      mp4.onReady = info => {
        ti = info.tracks.find(t => t.video);
        if (!ti) return rej('No video track');
        mp4.setExtractionOptions(ti.id, null, { nbSamples: ti.nb_samples });
        mp4.start();
      };
      mp4.onSamples = (_, __, arr) => samples.push(...arr);
      try {
        mp4.appendBuffer(buf);
        mp4.flush();
      } catch(e) {
        rej(e);
      }
      (function wait() {
        if (ti && samples.length >= ti.nb_samples) {
          res({ track: ti, samples });
        } else {
          setTimeout(wait, 50);
        }
      })();
    });
  }

  // FIXED extractSpsPps: accepts ArrayBuffer or TypedArray
  function extractSpsPps(input) {
    let ab, offset = 0, length;
    if (input instanceof ArrayBuffer) {
      ab = input; length = ab.byteLength;
    } else if (ArrayBuffer.isView(input)) {
      ab = input.buffer; 
      offset = input.byteOffset;
      length = input.byteLength;
    } else {
      return null;
    }
    const dv = new DataView(ab, offset, length);
    const parts = [];
    const prefix = new Uint8Array([0,0,0,1]);
    let pos = 0;
    while (parts.length < 2 && pos + 4 <= dv.byteLength) {
      const sz = dv.getUint32(pos); pos += 4;
      if (pos + sz > dv.byteLength) break;
      const nal = new Uint8Array(ab, offset + pos, sz);
      const t = nal[0] & 0x1f;
      if (t === 7 || t === 8) parts.push(prefix, nal);
      pos += sz;
    }
    return parts.length === 2 ? concat(parts).buffer : null;
  }

  // simple concat helper
  function concat(arrays) {
    let total = arrays.reduce((sum,a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }

})();
