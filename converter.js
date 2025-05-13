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

  // WebCodecs feature check
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

  // Drag & drop / click handling
  ;['dragover','dragleave','drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.toggle('dragover', evt==='dragover');
      if (evt==='drop' && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
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
    updateProgress(0, 'Reading…');

    try {
      // 1) Demux MP4
      updateProgress(5, 'Demuxing…');
      const { track, samples } = await demuxMp4(file);
      const total = samples.length;
      updateProgress(20, 'Demux complete');

      // 2) Build VideoDecoderConfig
      let decCfg = { codec: track.codec };
      if (track.video) {
        decCfg.codedWidth  = track.video.width;
        decCfg.codedHeight = track.video.height;
      }

      // H.264: attach avcC or fallback to Annex-B SPS/PPS
      let needAnnexB = false, annexBConfig = null;
      if (track.codec.startsWith('avc1')) {
        if (track.avcC) {
          const prefix = new Uint8Array([0,0,0,1]);
          const parts = [];
          track.avcC.sequenceParameterSets.forEach(sps => parts.push(prefix, new Uint8Array(sps)));
          track.avcC.pictureParameterSets.forEach(pps => parts.push(prefix, new Uint8Array(pps)));
          decCfg.description = concat(parts).buffer;
        } else {
          // fallback: extract SPS/PPS from first sample
          needAnnexB = true;
          annexBConfig = extractSpsPps(samples[0].data);
          if (!annexBConfig) {
            throw new Error('Unable to extract H.264 SPS/PPS for Annex-B fallback');
          }
          // do not set decCfg.description → Annex-B mode
        }
      }

      // HEVC, VP9, AV1 config
      if (track.codec.startsWith('hvc1') && track.hvcC?.buffer) {
        decCfg.description = track.hvcC.buffer;
      }
      if (track.codec.startsWith('vp09') && track.vpcC?.buffer) {
        decCfg.description = track.vpcC.buffer;
      }
      if (track.codec.startsWith('av01') && track.av1C?.buffer) {
        decCfg.description = track.av1C.buffer;
      }

      // 3) Capability & profile fallback
      updateProgress(25, 'Checking codec support…');
      let support = await VideoDecoder.isConfigSupported(decCfg);
      if (!support.supported && track.codec.startsWith('avc1')) {
        console.warn(`Profile ${track.codec} unsupported; falling back to Baseline (avc1.42001E)`);
        decCfg.codec = 'avc1.42001E';
        support = await VideoDecoder.isConfigSupported(decCfg);
      }
      if (!support.supported) {
        throw new Error(`Cannot decode codec ${decCfg.codec}`);
      }

      // VP8 encoder support
      const encCfg = { codec:'vp8', width:track.video.width, height:track.video.height };
      const encSup = await VideoEncoder.isConfigSupported(encCfg);
      if (!encSup.supported) {
        throw new Error('VP8 encoding not supported');
      }

      // 4) Init muxer, decoder, encoder
      updateProgress(30, 'Initializing…');
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video:  { codec:'V_VP8', width:track.video.width, height:track.video.height }
      });

      let decodedCount = 0;
      const decoder = new VideoDecoder({
        output: frame => {
          encoder.encode(frame);
          frame.close();
          decodedCount++;
          updateProgress(
            30 + (decodedCount/total)*60,
            `Transcoded frame ${decodedCount}/${total}`
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

      // 5) Feed samples
      updateProgress(35, 'Transcoding…');
      for (const s of samples) {
        // Always convert to Annex-B
        let data = mp4ToAnnexB(s.data);

        // If H.264 fallback, prepend SPS/PPS on keyframes
        if (needAnnexB && s.is_rap) {
          data = concat([new Uint8Array(annexBConfig), data]);
        }

        const chunk = new EncodedVideoChunk({
          type:      s.is_rap ? 'key' : 'delta',
          timestamp: Math.round(s.cts * (1e6/track.timescale)),
          data
        });
        decoder.decode(chunk);
      }

      // 6) Flush & finalize
      await decoder.flush();
      await encoder.flush();
      updateProgress(95, 'Finalizing…');
      const webmBuf = muxer.finalize();
      const blob    = new Blob([webmBuf], { type:'video/webm' });
      const url     = URL.createObjectURL(blob);
      const outName = file.name.replace(/\.mp4$/i, '') + '.webm';
      outputDiv.innerHTML = `<a href="${url}" download="${outName}">Download WebM</a>`;
      updateProgress(100, 'Done');
    }
    catch (err) {
      console.error(err);
      updateProgress(0, 'Error: ' + err.message);
      setTimeout(resetUI, 5000);
    }
  }

  // Demux helper: returns { track, samples }
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
      mp4.onSamples = (_id, _u, arr) => samples.push(...arr);
      try { mp4.appendBuffer(ab); mp4.flush(); }
      catch(e) { rej(e); }
      (function waitForAll() {
        if (trackInfo && samples.length >= trackInfo.nb_samples) {
          res({ track: trackInfo, samples });
        } else {
          setTimeout(waitForAll, 50);
        }
      })();
    });
  }

  // Convert MP4 length-prefixed NALs to Annex-B Uint8Array
  function mp4ToAnnexB(input) {
    const buf = input instanceof ArrayBuffer ? input
              : ArrayBuffer.isView(input)         ? input.buffer
              : null;
    if (!buf) return new Uint8Array();
    const dv = new DataView(buf, input.byteOffset || 0, input.byteLength || buf.byteLength);
    const parts = [];
    const prefix = new Uint8Array([0,0,0,1]);
    let pos = 0;
    while (pos + 4 <= dv.byteLength) {
      const size = dv.getUint32(pos);
      pos += 4;
      if (pos + size > dv.byteLength) break;
      parts.push(prefix, new Uint8Array(dv.buffer, dv.byteOffset + pos, size));
      pos += size;
    }
    return concat(parts);
  }

  // Extract SPS/PPS NALs from first H.264 sample for fallback
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
      const t = nal[0] & 0x1f;
      if (t === 7 || t === 8) parts.push(prefix, nal);
      pos += sz;
    }
    if (parts.length < 2) return null;
    return concat(parts).buffer;
  }

  // Concatenate multiple Uint8Arrays into one
  function concat(arr) {
    let total = arr.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arr) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }
})();
