// converter.js
// Dependencies (in index.html):
// <script src="https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js"></script>
// <script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.2/build/webm-muxer.js"></script>

(async function() {
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const { createFile: createMP4BoxFile } = MP4Box;

  // DOM refs
  const dropzone        = document.getElementById('dropzone');
  const fileInput       = document.getElementById('fileInput');
  const progressWrapper = document.getElementById('progress-container');
  const progressBar     = document.getElementById('progress-bar');
  const statusText      = document.getElementById('status-text');
  const outputDiv       = document.getElementById('output');

  // Ensure WebCodecs support
  if (!window.VideoDecoder || !window.VideoEncoder) {
    dropzone.textContent = 'Your browser does not support WebCodecs.';
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
    progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    statusText.textContent = msg || '';
  }
  resetUI();

  // Wire up drag & drop + click
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

  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.mp4')) {
      alert('Please select an MP4 file.');
      return;
    }
    dropzone.classList.add('disabled');
    progressWrapper.classList.remove('hidden');
    updateProgress(0, 'Loading…');

    try {
      // 1. Demux MP4
      updateProgress(5, 'Demuxing MP4…');
      const { track, samples } = await demuxMp4(file);
      const totalSamples = samples.length;
      updateProgress(20, 'Demux complete');

      // 2. Build decoder config
      const decCfg = { codec: track.codec };
      if (track.video?.width && track.video?.height) {
        decCfg.codedWidth  = track.video.width;
        decCfg.codedHeight = track.video.height;
      }
      // H.264 (avc1) out-of-band config or fallback in-band
      if (track.codec.startsWith('avc1')) {
        if (track.avcC) {
          const prefix = new Uint8Array([0,0,0,1]);
          const parts = [];
          track.avcC.sequenceParameterSets.forEach(s => parts.push(prefix, new Uint8Array(s)));
          track.avcC.pictureParameterSets   .forEach(p => parts.push(prefix, new Uint8Array(p)));
          decCfg.description = concat(parts).buffer;
        } else {
          // fallback: extract SPS/PPS from first sample
          const desc = extractSpsPps(samples[0].data);
          if (!desc) throw new Error('Cannot extract SPS/PPS');
          decCfg.description = desc;
        }
      }
      // H.265
      if (track.codec.startsWith('hvc1') && track.hvcC?.buffer) {
        decCfg.description = track.hvcC.buffer;
      }
      // VP9
      if (track.codec.startsWith('vp09') && track.vpcC?.buffer) {
        decCfg.description = track.vpcC.buffer;
      }
      // AV1
      if (track.codec.startsWith('av01') && track.av1C?.buffer) {
        decCfg.description = track.av1C.buffer;
      }

      // 3. Capability checks
      updateProgress(25, 'Checking codec support…');
      const decSup = await VideoDecoder.isConfigSupported(decCfg);
      if (!decSup.supported) throw new Error(`Decoding ${track.codec} not supported.`);
      const encCfg = { codec:'vp8', width:track.video.width, height:track.video.height };
      const encSup = await VideoEncoder.isConfigSupported(encCfg);
      if (!encSup.supported) throw new Error('VP8 encoding not supported.');

      // 4. Init muxer, decoder, encoder
      updateProgress(30, 'Initializing…');
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video:  { codec:'V_VP8', width:track.video.width, height:track.video.height }
      });

      let decoded = 0;
      const decoder = new VideoDecoder({
        output: frame => {
          encoder.encode(frame);
          frame.close();
          decoded++;
          updateProgress(30 + Math.round((decoded/totalSamples)*60),
                         `Transcoding frame ${decoded}/${totalSamples}…`);
        },
        error: e => { throw e; }
      });
      decoder.configure(decCfg);

      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { throw e; }
      });
      encoder.configure(encCfg);

      // 5. Feed samples
      updateProgress(35, 'Feeding samples…');
      for (const s of samples) {
        const data = new Uint8Array(s.data);
        const chunk = new EncodedVideoChunk({
          type:      s.is_rap ? 'key' : 'delta',
          timestamp: Math.round(s.cts * (1e6/track.timescale)),
          data
        });
        decoder.decode(chunk);
      }

      // 6. Flush & finalize
      await decoder.flush();
      await encoder.flush();
      updateProgress(95, 'Finalizing…');
      const webmBuf = muxer.finalize();
      const blob    = new Blob([webmBuf], { type:'video/webm' });
      const url     = URL.createObjectURL(blob);
      const name    = file.name.replace(/\.mp4$/i, '') + '.webm';

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
    const buf = await file.arrayBuffer();
    buf.fileStart = 0;
    const mp4 = createMP4BoxFile();
    let trackInfo, samples = [];

    return new Promise((res, rej) => {
      mp4.onError = e => rej(e);
      mp4.onReady = info => {
        trackInfo = info.tracks.find(t => t.video);
        if (!trackInfo) return rej(new Error('No video track'));
        mp4.setExtractionOptions(trackInfo.id, null,
                                 { nbSamples:trackInfo.nb_samples, rapAlignement:true });
        mp4.start();
      };
      mp4.onSamples = (_id, _usr, arr) => samples.push(...arr);

      try {
        mp4.appendBuffer(buf);
        mp4.flush();
      } catch(e) {
        rej(e);
      }

      ;(function wait() {
        if (trackInfo && samples.length >= trackInfo.nb_samples) {
          res({ track: trackInfo, samples });
        } else setTimeout(wait, 50);
      })();
    });
  }

  // Convert length-prefixed NALs to Annex-B SPS/PPS extractor
  function extractSpsPps(buffer) {
    const dv = new DataView(buffer), parts = [];
    let offset = 0;
    const prefix = new Uint8Array([0,0,0,1]);
    // grab first two NALs (SPS=7, PPS=8)
    while (parts.length < 2 && offset + 4 <= dv.byteLength) {
      const size = dv.getUint32(offset); offset += 4;
      if (offset + size > dv.byteLength) break;
      const nal = new Uint8Array(buffer, offset, size);
      const type = nal[0] & 0x1f;
      if (type === 7 || type === 8) parts.push(prefix, nal);
      offset += size;
    }
    if (parts.length < 2) return null;
    return concat(parts).buffer;
  }

  // Concatenate many Uint8Arrays
  function concat(arrays) {
    let length = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(length);
    let pos = 0;
    for (const a of arrays) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
  }
})();
