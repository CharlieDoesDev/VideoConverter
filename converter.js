// converter.js
// Requires in index.html:
// <script src="https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js"></script>
// <script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.2/build/webm-muxer.js"></script>

(async function() {
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const { createFile: createMP4BoxFile } = MP4Box;

  // UI elements
  const dropzone          = document.getElementById('dropzone');
  const fileInput         = document.getElementById('fileInput');
  const progressContainer = document.getElementById('progress-container');
  const progressBar       = document.getElementById('progress-bar');
  const statusText        = document.getElementById('status-text');
  const outputDiv         = document.getElementById('output');

  // Feature check
  if (!window.VideoDecoder || !window.VideoEncoder) {
    dropzone.textContent = '❌ WebCodecs not supported.';
    dropzone.style.cursor = 'not-allowed';
    return;
  }

  // Reset UI
  function resetUI() {
    progressBar.style.width = '0%';
    statusText.textContent = '';
    progressContainer.classList.add('hidden');
    dropzone.classList.remove('disabled');
    dropzone.textContent = '📁 Drag & drop an MP4 here, or click to select';
    outputDiv.innerHTML = '';
  }
  resetUI();

  // Progress update
  function updateProgress(pct, msg) {
    progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    statusText.textContent = msg || '';
  }

  // Drag & drop + click
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  // Main handler
  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.mp4')) {
      alert('Please select an MP4 file.');
      return;
    }
    dropzone.classList.add('disabled');
    progressContainer.classList.remove('hidden');
    updateProgress(0, 'Reading file…');

    try {
      // Step 1: Demux MP4
      const { track, samples } = await demuxMp4(file);
      const total = samples.length;
      updateProgress(20, 'Demux complete');

      // Step 2: Build decoder config
      const decoderConfig = { codec: track.codec };
      // dimensions
      if (track.video?.width && track.video?.height) {
        decoderConfig.codedWidth  = track.video.width;
        decoderConfig.codedHeight = track.video.height;
      }
      // H.264 out-of-band config
      if (track.codec.startsWith('avc1')) {
        if (!track.avcC) throw new Error('Missing H.264 config (avcC)');
        const prefix = new Uint8Array([0,0,0,1]);
        const parts = [];
        for (const sps of track.avcC.sequenceParameterSets) parts.push(prefix, new Uint8Array(sps));
        for (const pps of track.avcC.pictureParameterSets)    parts.push(prefix, new Uint8Array(pps));
        decoderConfig.description = concat(parts).buffer;
      }
      // H.265
      if (track.codec.startsWith('hvc1') && track.hvcC?.buffer) {
        decoderConfig.description = track.hvcC.buffer;
      }
      // VP9
      if (track.codec.startsWith('vp09') && track.vpcC?.buffer) {
        decoderConfig.description = track.vpcC.buffer;
      }
      // AV1
      if (track.codec.startsWith('av01') && track.av1C?.buffer) {
        decoderConfig.description = track.av1C.buffer;
      }

      // Step 3: Support checks
      updateProgress(25, 'Checking support…');
      const decSup = await VideoDecoder.isConfigSupported(decoderConfig);
      if (!decSup.supported) {
        throw new Error(`Decoding ${track.codec} not supported.`);
      }
      const encConfig = { codec:'vp8', width:track.video.width, height:track.video.height };
      const encSup = await VideoEncoder.isConfigSupported(encConfig);
      if (!encSup.supported) {
        throw new Error('VP8 encoding not supported.');
      }

      // Step 4: Initialize muxer, decoder, encoder
      updateProgress(30, 'Initializing codecs…');
      const muxer   = new Muxer({ target: new ArrayBufferTarget(), video: { codec:'V_VP8', width:track.video.width, height:track.video.height } });
      let decodedCount = 0;

      const decoder = new VideoDecoder({
        output: frame => {
          encoder.encode(frame);
          frame.close();
          decodedCount++;
          updateProgress(30 + Math.round((decodedCount/total)*60), `Transcoding frame ${decodedCount}/${total}…`);
        },
        error: e => { throw e; }
      });
      decoder.configure(decoderConfig);

      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { throw e; }
      });
      encoder.configure(encConfig);

      // Step 5: Feed samples
      updateProgress(35, 'Feeding samples…');
      for (const s of samples) {
        let data = new Uint8Array(s.data);
        // For in-band H.264 (avc3), convert to Annex-B
        if (!decoderConfig.description && track.codec.startsWith('avc3')) {
          data = mp4ToAnnexB(s.data);
        }
        const chunk = new EncodedVideoChunk({
          type:      s.is_rap? 'key':'delta',
          timestamp: Math.round(s.cts * (1e6/track.timescale)),
          data
        });
        decoder.decode(chunk);
      }

      // Step 6: Flush and finalize
      await decoder.flush();
      await encoder.flush();
      updateProgress(95, 'Finalizing…');
      const webmBuffer = muxer.finalize();
      const blob = new Blob([webmBuffer], { type:'video/webm' });
      const url  = URL.createObjectURL(blob);
      const name = file.name.replace(/\.mp4$/i, '') + '.webm';

      // Show download link
      outputDiv.innerHTML = `✅ Complete! <a href="${url}" download="${name}">Download WebM</a>`;
      updateProgress(100, 'Done');
    } catch (err) {
      console.error(err);
      updateProgress(0, 'Error: ' + err.message);
      setTimeout(resetUI, 4000);
    }
  }

  // Demux helper
  async function demuxMp4(file) {
    const arrayBuffer = await file.arrayBuffer();
    arrayBuffer.fileStart = 0;
    const mp4boxFile = createMP4BoxFile();
    let trackInfo, samples = [];

    return new Promise((resolve, reject) => {
      mp4boxFile.onError = e => reject(new Error(e));
      mp4boxFile.onReady = info => {
        trackInfo = info.tracks.find(t => t.video);
        if (!trackInfo) return reject(new Error('No video track'));
        mp4boxFile.setExtractionOptions(trackInfo.id, null, { nbSamples: trackInfo.nb_samples, rapAlignement:true });
        mp4boxFile.start();
      };
      mp4boxFile.onSamples = (_id, _usr, sArr) => samples.push(...sArr);
      try {
        mp4boxFile.appendBuffer(arrayBuffer);
        mp4boxFile.flush();
      } catch (e) {
        reject(e);
      }
      (function wait() {
        if (trackInfo && samples.length >= trackInfo.nb_samples) {
          resolve({ track: trackInfo, samples });
        } else {
          setTimeout(wait, 50);
        }
      })();
    });
  }

  // Convert MP4-style NAL (length-prefixed) to Annex-B (start-code prefixed)
  function mp4ToAnnexB(buffer) {
    const dv = new DataView(buffer);
    let offset = 0;
    const parts = [];
    const prefix = new Uint8Array([0,0,0,1]);
    while (offset + 4 <= dv.byteLength) {
      const size = dv.getUint32(offset); offset += 4;
      if (offset + size > dv.byteLength) break;
      parts.push(prefix);
      parts.push(new Uint8Array(buffer, offset, size));
      offset += size;
    }
    return concat(parts);
  }

  // Concatenate Uint8Arrays into one
  function concat(arrays) {
    let len = 0; arrays.forEach(a => len += a.length);
    const out = new Uint8Array(len);
    let pos = 0;
    for (const a of arrays) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
  }
})();
