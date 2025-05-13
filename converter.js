// converter.js
// index.html must include mp4box.js and webm-muxer UMD before this script.

(async function() {
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const { createFile: createMP4BoxFile } = MP4Box;

  // UI refs
  const dropzone        = document.getElementById('dropzone');
  const fileInput       = document.getElementById('fileInput');
  const progressWrapper = document.getElementById('progress-container');
  const progressBar     = document.getElementById('progress-bar');
  const statusText      = document.getElementById('status-text');
  const outputDiv       = document.getElementById('output');

  if (!window.VideoDecoder || !window.VideoEncoder) {
    dropzone.textContent = 'Your browser doesn’t support WebCodecs';
    dropzone.style.cursor = 'not-allowed';
    return;
  }

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

  // Drag & drop & click
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
    updateProgress(0, 'Reading file…');

    try {
      // 1) Demux
      updateProgress(5, 'Demuxing MP4…');
      const { track, samples } = await demuxMp4(file);
      const total = samples.length;
      updateProgress(20, 'Demux complete');

      // 2) Build decoderConfig
      const decCfg = { codec: track.codec };
      if (track.video) {
        decCfg.codedWidth  = track.video.width;
        decCfg.codedHeight = track.video.height;
      }

      if (track.codec.startsWith('avc1')) {
        // Out-of-band avcC if present
        if (track.avcC) {
          const prefix = new Uint8Array([0,0,0,1]);
          const parts = [];
          track.avcC.sequenceParameterSets.forEach(sps => parts.push(prefix, new Uint8Array(sps)));
          track.avcC.pictureParameterSets   .forEach(pps => parts.push(prefix, new Uint8Array(pps)));
          decCfg.description = concat(parts).buffer;
        } else {
          // Fallback: extract from first sample
          const desc = extractSpsPps(samples[0].data);
          if (!desc) throw new Error('Unable to extract H.264 SPS/PPS');
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

      // 3) Capability checks
      updateProgress(25, 'Checking codec support…');
      const { supported: decOk } = await VideoDecoder.isConfigSupported(decCfg);
      if (!decOk) throw new Error(`Cannot decode ${track.codec}`);
      const encCfg = { codec:'vp8', width:track.video.width, height:track.video.height };
      const { supported: encOk } = await VideoEncoder.isConfigSupported(encCfg);
      if (!encOk) throw new Error('VP8 encoding not supported');

      // 4) Init
      updateProgress(30, 'Initializing codecs…');
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
          updateProgress(
            30 + (decoded/total)*60,
            `Transcoding frame ${decoded}/${total}…`
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

      // 5) Decode→Encode
      updateProgress(35, 'Processing samples…');
      for (const s of samples) {
        const data = new Uint8Array(s.data);
        const chunk = new EncodedVideoChunk({
          type:      s.is_rap ? 'key':'delta',
          timestamp: Math.round(s.cts * (1e6/track.timescale)),
          data
        });
        decoder.decode(chunk);
      }

      // 6) Flush & finish
      await decoder.flush();
      await encoder.flush();
      updateProgress(95, 'Finalizing…');
      const webmBuffer = muxer.finalize();
      const blob       = new Blob([webmBuffer], { type:'video/webm' });
      const url        = URL.createObjectURL(blob);
      const name       = file.name.replace(/\.mp4$/i,'') + '.webm';

      outputDiv.innerHTML = `<a href="${url}" download="${name}">Download WebM</a>`;
      updateProgress(100, 'Done');
    }
    catch (err) {
      console.error(err);
      updateProgress(0, 'Error: ' + err.message);
      setTimeout(resetUI, 5000);
    }
  }

  // --- helpers ---

  // Demux MP4 → track & samples
  async function demuxMp4(file) {
    const buf = await file.arrayBuffer();
    buf.fileStart = 0;
    const mp4 = createMP4BoxFile();
    let trackInfo, samples = [];
    return new Promise((res, rej) => {
      mp4.onError = e => rej(e);
      mp4.onReady = info => {
        trackInfo = info.tracks.find(t=>t.video);
        if (!trackInfo) return rej(new Error('No video track'));
        mp4.setExtractionOptions(
          trackInfo.id, null,
          { nbSamples:trackInfo.nb_samples, rapAlignement:true }
        );
        mp4.start();
      };
      mp4.onSamples = (_id,_u,arr) => samples.push(...arr);
      try { mp4.appendBuffer(buf); mp4.flush(); }
      catch(e) { rej(e); }
      (function wait() {
        if (trackInfo && samples.length >= trackInfo.nb_samples) {
          res({ track: trackInfo, samples });
        } else setTimeout(wait, 50);
      })();
    });
  }

  // Extract SPS+PPS from first H.264 sample buffer
  function extractSpsPps(buffer) {
    const dv = new DataView(buffer), parts = [];
    let off = 0;
    const prefix = new Uint8Array([0,0,0,1]);
    // collect two NALs
    while (parts.length < 2 && off + 4 <= dv.byteLength) {
      const size = dv.getUint32(off); off += 4;
      if (off + size > dv.byteLength) break;
      const nal = new Uint8Array(buffer, off, size);
      const t = nal[0] & 0x1f;
      if (t === 7 || t === 8) parts.push(prefix, nal);
      off += size;
    }
    if (parts.length < 2) return null;
    return concat(parts).buffer;
  }

  // Concatenate many Uint8Arrays
  function concat(arrays) {
    let len = arrays.reduce((sum,a)=>sum+a.length,0);
    const out = new Uint8Array(len);
    let pos = 0;
    for (const a of arrays) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
  }

})();
