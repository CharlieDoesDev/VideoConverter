(async function() {
  // Globals from UMD bundles
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const { createFile: createMP4BoxFile }  = MP4Box;

  // UI elements
  const dropzone        = document.getElementById('dropzone');
  const fileInput       = document.getElementById('fileInput');
  const progressContainer = document.getElementById('progress-container');
  const progressBar       = document.getElementById('progress-bar');
  const statusText        = document.getElementById('status-text');
  const outputDiv         = document.getElementById('output');

  // Check WebCodecs support
  if (!window.VideoDecoder || !window.VideoEncoder) {
    dropzone.textContent = '❌ WebCodecs not supported in this browser.';
    dropzone.style.cursor = 'not-allowed';
    return;
  }

  // Utility to update progress bar and text
  function updateProgress(pct, msg) {
    progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    statusText.textContent = msg || '';
  }
  // Reset UI for next file
  function resetUI() {
    progressBar.style.width = '0%';
    statusText.textContent = '';
    progressContainer.classList.add('hidden');
    dropzone.classList.remove('disabled');
    dropzone.textContent = '📁 Drag & drop an MP4 here, or click to select';
    outputDiv.innerHTML = '';
  }

  // Wire up drag&drop + click
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
    // Disable UI
    dropzone.classList.add('disabled');
    progressContainer.classList.remove('hidden');
    updateProgress(0, 'Reading file…');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const mp4boxFile = createMP4BoxFile();
      let videoTrack, totalSamples = 0;

      // Deal with mp4box.js events
      const samplesQueue = [];
      mp4boxFile.onError = e => { throw new Error(e); };
      mp4boxFile.onReady = info => {
        // pick the first video track
        videoTrack = info.tracks.find(t => t.video);
        if (!videoTrack) throw new Error('No video track found.');
        totalSamples = videoTrack.nb_samples;
        mp4boxFile.setExtractionOptions(
          videoTrack.id, null,
          { nbSamples: totalSamples, rapAlignement: true }
        );
        mp4boxFile.start();
      };
      mp4boxFile.onSamples = (_id, _user, samples) => {
        samplesQueue.push(...samples);
        updateProgress(
          totalSamples
            ? Math.round((samplesQueue.length/totalSamples)*20)
            : 20,
          'Demuxing…'
        );
      };
      // Feed the file to mp4box
      arrayBuffer.fileStart = 0;
      mp4boxFile.appendBuffer(arrayBuffer);
      mp4boxFile.flush();

      // Wait until we have all samples
      await new Promise(resolve => {
        (function waitForSamples() {
          if (videoTrack && samplesQueue.length >= totalSamples) resolve();
          else setTimeout(waitForSamples, 50);
        })();
      });

      // Set up WebCodecs decoder & encoder & WebM muxer
      // 1) build VideoDecoderConfig
      const codec = videoTrack.codec; // e.g. "avc1.4d401e", "vp09…" etc.
      const decoderConfig = { codec };
      // Coded dimensions
      if (videoTrack.video.width && videoTrack.video.height) {
        decoderConfig.codedWidth  = videoTrack.video.width;
        decoderConfig.codedHeight = videoTrack.video.height;
      }
      // H.264 out-of-band config:
      if (codec.startsWith('avc1')) {
        if (!videoTrack.avcC) {
          throw new Error('Missing H.264 config (avcC)');
        }
        // build description from track.avcC SPS/PPS
        const prefix = new Uint8Array([0,0,0,1]);
        const parts = [];
        for (const sps of videoTrack.avcC.sequenceParameterSets) {
          parts.push(prefix, new Uint8Array(sps));
        }
        for (const pps of videoTrack.avcC.pictureParameterSets) {
          parts.push(prefix, new Uint8Array(pps));
        }
        decoderConfig.description = concat(parts).buffer;
      }
      // avc3 (in-band) → no description
      // H.265
      if (codec.startsWith('hvc1') && videoTrack.hvcC) {
        decoderConfig.description = videoTrack.hvcC.buffer;
      }
      // VP9
      if (codec.startsWith('vp09') && videoTrack.vpcC) {
        decoderConfig.description = videoTrack.vpcC.buffer;
      }
      // AV1
      if (codec.startsWith('av01') && videoTrack.av1C) {
        decoderConfig.description = videoTrack.av1C.buffer;
      }

      // Check support
      const decSup = await VideoDecoder.isConfigSupported(decoderConfig);
      if (!decSup.supported) {
        throw new Error(`Decoding ${codec} not supported.`);
      }
      // Encoder only VP8
      const encConfig = {
        codec:'vp8',
        width:videoTrack.video.width,
        height:videoTrack.video.height,
      };
      const encSup = await VideoEncoder.isConfigSupported(encConfig);
      if (!encSup.supported) {
        throw new Error('VP8 encoding not supported.');
      }

      // Create muxer
      const muxer = new WebMMuxer({
        target:'buffer',
        video:{ codec:'V_VP8', width:videoTrack.video.width, height:videoTrack.video.height }
      });

      // Set up WebCodecs
      let framesDecoded = 0;
      const decoder = new VideoDecoder({
        output: frame => {
          encoder.encode(frame);
          frame.close();
          framesDecoded++;
          updateProgress(
            20 + Math.round((framesDecoded/totalSamples)*75),
            `Transcoding frame ${framesDecoded}/${totalSamples}…`
          );
        },
        error: e => console.error('Decoder error:', e)
      });
      decoder.configure(decoderConfig);

      const encoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
        error: e => console.error('Encoder error:', e)
      });
      encoder.configure(encConfig);

      // Feed samples to decoder
      for (const s of samplesQueue) {
        const chunk = new EncodedVideoChunk({
          type: s.is_rap?'key':'delta',
          timestamp: Math.round(s.cts*(1e6/videoTrack.timescale)),
          data: new Uint8Array(s.data)
        });
        decoder.decode(chunk);
      }
      await decoder.flush();
      await encoder.flush();

      // Finalize WebM
      const webmBuffer = muxer.finalize();
      const blob = new Blob([webmBuffer], { type:'video/webm' });
      const url = URL.createObjectURL(blob);
      const name = file.name.replace(/\.mp4$/i,'') + '.webm';
      outputDiv.innerHTML =
        `✅ Done! <a href="${url}" download="${name}">Download WebM</a>`;
      updateProgress(100, 'Conversion complete');
    } catch (err) {
      console.error(err);
      updateProgress(0, 'Error: ' + err.message);
      setTimeout(resetUI, 4000);
    }
  }

  // Concatenate typed arrays helper
  function concat(arrays) {
    let length = 0;
    for (const a of arrays) length += a.length;
    const result = new Uint8Array(length);
    let offset = 0;
    for (const a of arrays) {
      result.set(a, offset);
      offset += a.length;
    }
    return result;
  }
})();
