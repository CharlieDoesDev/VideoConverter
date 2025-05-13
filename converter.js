// converter.js
// Requires in index.html:
// <script src="https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js"></script>
// <script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.2/build/webm-muxer.js"></script>

(async function() {
  const { Muxer } = WebMMuxer;
  const { createFile: createMP4BoxFile } = MP4Box;

  // UI refs
  const dropzone        = document.getElementById('dropzone');
  const fileInput       = document.getElementById('fileInput');
  const progressWrapper = document.getElementById('progress-container');
  const progressBar     = document.getElementById('progress-bar');
  const statusText      = document.getElementById('status-text');
  const outputDiv       = document.getElementById('output');

  // Feature check
  if (!window.VideoDecoder || !window.VideoEncoder) {
    dropzone.textContent = 'WebCodecs not supported in this browser.';
    dropzone.style.cursor = 'not-allowed';
    return;
  }

  // UI helpers
  function resetUI() {
    progressBar.style.width = '0%';
    statusText.textContent = '';
    progressWrapper.classList.add('hidden');
    outputDiv.innerHTML = '';
    dropzone.classList.remove('disabled');
    dropzone.textContent = 'Drag & drop an MP4 here, or click to select';
  }
  function updateProgress(pct, msg) {
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    statusText.textContent = msg || '';
  }
  resetUI();

  // Drag & drop + click
  ;['dragover','dragleave','drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.toggle('dragover', evt === 'dragover');
      if (evt === 'drop' && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
  });
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  // Main pipeline
  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.mp4')) {
      alert('Please select an MP4 file.');
      return;
    }
    dropzone.classList.add('disabled');
    progressWrapper.classList.remove('hidden');
    updateProgress(0, 'Reading file…');

    try {
      // 1) Demux
      updateProgress(5, 'Demuxing…');
      const { track, samples } = await demuxMp4(file);
      const total = samples.length;
      updateProgress(20, 'Demux complete');

      // 2) Build decoder config
      let decCfg = { codec: track.codec };
      if (track.video) {
        decCfg.codedWidth  = track.video.width;
        decCfg.codedHeight = track.video.height;
      }

      // H.264 SPS/PPS
      if (track.codec.startsWith('avc1')) {
        const spspps = track.avcC
          ? (() => {
              const prefix = new Uint8Array([0,0,0,1]);
              const parts = [];
              track.avcC.sequenceParameterSets.forEach(sps =>
                parts.push(prefix, new Uint8Array(sps))
              );
              track.avcC.pictureParameterSets.forEach(pps =>
                parts.push(prefix, new Uint8Array(pps))
              );
              return concat(parts).buffer;
            })()
          : extractSpsPps(samples[0].data);
        if (!spspps) throw new Error('Cannot extract H.264 SPS/PPS');
        decCfg.description = spspps;
      }

      // HEVC, VP9, AV1
      if (track.codec.startsWith('hvc1') && track.hvcC?.buffer) decCfg.description = track.hvcC.buffer;
      if (track.codec.startsWith('vp09') && track.vpcC?.buffer) decCfg.description = track.vpcC.buffer;
      if (track.codec.startsWith('av01') && track.av1C?.buffer) decCfg.description = track.av1C.buffer;

      // 3) Check support & fallback for H.264
      updateProgress(25, 'Checking codec support…');
      let support = await VideoDecoder.isConfigSupported(decCfg);
      if (!support.supported && track.codec.startsWith('avc1')) {
        console.warn(`Falling back to baseline profile`);
        decCfg.codec = 'avc1.42001E';
        support = await VideoDecoder.isConfigSupported(decCfg);
      }
      if (!support.supported) throw new Error(`Cannot decode ${decCfg.codec}`);

      // 4) VP8 encoder config
      const framerate = 30;
      const bitrate   = track.bitrate || 1_000_000;
      const encCfg = {
        codec:     'vp8',
        width:     track.video.width,
        height:    track.video.height,
        framerate,
        bitrate
      };
      const encSup = await VideoEncoder.isConfigSupported(encCfg);
      if (!encSup.supported) throw new Error('VP8 encoding not supported');

      // 5) Initialize muxer, decoder, encoder
      updateProgress(30, 'Initializing…');
      const muxer = new Muxer({
        target: 'buffer',  // let it manage its own buffer
        video:  {
          codec:  'V_VP8',
          width:  track.video.width,
          height: track.video.height
        }
      });

      let decodedCount = 0;
      const decoder = new VideoDecoder({
        output: frame => {
          encoder.encode(frame);
          frame.close();
          decodedCount++;
          updateProgress(
            30 + (decodedCount/total)*60,
            `Frame ${decodedCount}/${total}`
          );
        },
        error: e => { throw e; }
      });
      decoder.configure(decCfg);

      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { throw e; }
      });
      encoder.configure(encCfg);

      // 6) Feed samples (convert each to Annex-B)
      updateProgress(35, 'Transcoding…');
      for (const s of samples) {
        const raw = mp4ToAnnexB(s.data);
        const evc = new EncodedVideoChunk({
          type:      s.is_rap ? 'key' : 'delta',
          timestamp: Math.round(s.cts * (1e6/track.timescale)),
          data:      raw
        });
        decoder.decode(evc);
      }

      // 7) Flush & finalize
      await decoder.flush();
      await encoder.flush();
      updateProgress(95, 'Finalizing…');
      const webm = muxer.finalize();       // Uint8Array
      const blob = new Blob([webm], { type:'video/webm' });
      const url  = URL.createObjectURL(blob);
      const name = file.name.replace(/\.mp4$/i,'') + '.webm';

      outputDiv.innerHTML = `<a href="${url}" download="${name}">Download WebM</a>`;
      updateProgress(100, 'Done');
    }
    catch (err) {
      console.error(err);
      updateProgress(0, 'Error: ' + err.message);
      setTimeout(resetUI, 5000);
    }
  }

  // Demux helper
  async function demuxMp4(file) {
    const ab = await file.arrayBuffer();
    ab.fileStart = 0;
    const mp4 = createMP4BoxFile();
    let trackInfo, samples = [];

    return new Promise((res, rej) => {
      mp4.onError = e => rej(e);
      mp4.onReady = info => {
        trackInfo = info.tracks.find(t => t.video);
        if (!trackInfo) return rej(new Error('No video track'));
        mp4.setExtractionOptions(
          trackInfo.id, null,
          { nbSamples: trackInfo.nb_samples, rapAlignement: true }
        );
        mp4.start();
      };
      mp4.onSamples = (_id,_u,arr) => samples.push(...arr);
      try {
        mp4.appendBuffer(ab);
        mp4.flush();
      } catch(e) {
        rej(e);
      }
      (function waitAll() {
        if (trackInfo && samples.length >= trackInfo.nb_samples) {
          res({ track: trackInfo, samples });
        } else {
          setTimeout(waitAll, 50);
        }
      })();
    });
  }

  // Convert MP4 length-prefixed NAL → Annex-B Uint8Array
  function mp4ToAnnexB(input) {
    const buf = input instanceof ArrayBuffer
      ? input
      : ArrayBuffer.isView(input)
        ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        : new ArrayBuffer(0);
    const dv = new DataView(buf);
    const parts = [];
    const prefix = new Uint8Array([0,0,0,1]);
    let pos = 0;
    while (pos + 4 <= dv.byteLength) {
      const size = dv.getUint32(pos);
      pos += 4;
      if (pos + size > dv.byteLength) break;
      parts.push(prefix, new Uint8Array(buf, pos, size));
      pos += size;
    }
    return concat(parts);
  }

  // Extract SPS/PPS from first sample
  function extractSpsPps(input) {
    const view = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
    if (!view) return null;

    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const parts = [];
    const prefix = new Uint8Array([0,0,0,1]);
    let pos = 0;
    while (parts.length < 2 && pos + 4 <= dv.byteLength) {
      const sz = dv.getUint32(pos);
      pos += 4;
      if (pos + sz > dv.byteLength) break;
      const nal = new Uint8Array(dv.buffer, dv.byteOffset + pos, sz);
      const type = nal[0] & 0x1f;
      if (type === 7 || type === 8) parts.push(prefix, nal);
      pos += sz;
    }
    return parts.length === 2 ? concat(parts).buffer : null;
  }

  // Concatenate Uint8Array[]
  function concat(arrays) {
    let len = arrays.reduce((sum,a) => sum + a.length, 0);
    const out = new Uint8Array(len);
    let offs = 0;
    for (const a of arrays) {
      out.set(a, offs);
      offs += a.length;
    }
    return out;
  }

})();
