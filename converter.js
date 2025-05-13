(async function() {
  // UI element references
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const statusText = document.getElementById('status-text');
  const outputDiv = document.getElementById('output');

  // Feature detection: ensure WebCodecs is available
  const supportsWebCodecs = ('VideoEncoder' in window) && ('VideoDecoder' in window);
  if (!supportsWebCodecs) {
    dropzone.textContent = '❌ Your browser does not support the WebCodecs API required for conversion.';
    dropzone.style.cursor = 'not-allowed';
    return;
  }

  // Utility: Update progress bar and text
  function updateProgress(percent, message) {
    progressBar.style.width = percent + '%';
    statusText.textContent = message || '';
  }

  // Utility: Reset UI to initial state for new conversion
  function resetUI() {
    progressBar.style.width = '0%';
    statusText.textContent = '';
    progressContainer.classList.add('hidden');
    outputDiv.innerHTML = '';
    dropzone.classList.remove('disabled');
    dropzone.innerHTML = '📁 <b>Drag & drop an MP4 video here, or click to select</b>';
  }

  // Initialize UI state
  resetUI();

  // Drag & drop events
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
  // Click on dropzone opens file dialog
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFile(fileInput.files[0]);
    }
  });

  // Main file handling and conversion function
  async function handleFile(file) {
    // Only accept MP4 files
    if (!file.name.toLowerCase().endsWith('.mp4') && file.type !== 'video/mp4') {
      alert('Please select an MP4 video file.');
      return;
    }

    // Prepare UI for conversion
    dropzone.innerHTML = '⌛ Processing...';
    dropzone.classList.add('disabled');
    progressContainer.classList.remove('hidden');
    updateProgress(0, 'Starting conversion...');

    try {
      // Read file into ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      // Initialize MP4Box for parsing
      const mp4boxfile = MP4Box.createFile();
      let videoTrackId = null;
      let videoTrackInfo = null;
      let totalFrames = 0;

      // Set up MP4Box event callbacks
      mp4boxfile.onError = (e) => { throw new Error('MP4 parsing error: ' + e); };
      mp4boxfile.onReady = (info) => {
        // Find first video track
        const videoTracks = info.tracks.filter(t => t.video);
        if (videoTracks.length === 0) {
          throw new Error('No video track found in file.');
        }
        videoTrackInfo = videoTracks[0];
        videoTrackId = videoTrackInfo.id;
        totalFrames = videoTrackInfo.nb_samples || 0;
        // Set extraction options for the video track (all samples, starting at RAP)
        mp4boxfile.setExtractionOptions(videoTrackId, null, { nbSamples: totalFrames, rapAlignement: true });
        mp4boxfile.start();
      };

      // Create WebCodecs decoder/encoder and muxer (to be configured later when ready)
      let decoder, encoder, muxer;
      // Flags to ensure one-time setup
      let decoderConfigured = false;
      let framesDecoded = 0;

      // Decoder output callback: encode video frames as they arrive
      const handleFrame = (frame) => {
        try {
          // On receiving a decoded frame, encode it to VP8
          encoder.encode(frame);  // let encoder decide keyFrame internally
          frame.close();
          framesDecoded++;
          // Update progress based on frames processed
          if (totalFrames) {
            const percent = Math.round((framesDecoded / totalFrames) * 100);
            updateProgress(percent, `Transcoding frame ${framesDecoded} of ${totalFrames}...`);
          }
        } catch (err) {
          console.error('Error during frame encode:', err);
        }
      };

      // Encoder output callback: feed encoded chunk to muxer
      const handleChunk = (chunk, metadata) => {
        muxer.addVideoChunk(chunk, metadata);
      };

      // Set up sample extraction callback
      mp4boxfile.onSamples = async (id, user, samples) => {
        // Only initialize decoder, encoder, and muxer once (on first batch of samples)
        if (!decoderConfigured) {
          decoderConfigured = true;
          const track = videoTrackInfo;
          // Prepare VideoDecoder config for the input codec
          /** Determine codec string and extradata (if needed) **/
          const codec = track.codec;  // e.g., "avc1.64001e", "vp09.00.10.08", etc.
          const decoderConfig = { codec };
          // Set coded width/height if available (for better compatibility)
          if (track.video && track.video.width && track.video.height) {
            decoderConfig.codedWidth = track.video.width;
            decoderConfig.codedHeight = track.video.height;
          }
          // If codec is H.264/AVC or similar that needs config bytes:
          if ((codec.startsWith('avc1') || codec.startsWith('avc3')) && samples[0]?.description) {
            // Attempt to get AVC config (SPS/PPS) from the sample description
            const desc = samples[0].description;
            if (desc.avcC) {
              // Use the avcC box bytes as description:contentReference[oaicite:4]{index=4}
              decoderConfig.description = desc.avcC; 
            } else {
              // Fallback: extract SPS/PPS from first sample in-stream (if avcC not provided)
              decoderConfig.description = extractAvcConfig(samples[0].data);
            }
          }
          // If codec is AV1 and has config box
          if (codec.startsWith('av01') && samples[0]?.description && samples[0].description.av1C) {
            decoderConfig.description = samples[0].description.av1C;
          }
          // If codec is VP9 and has config (vpcC) box
          if (codec.startsWith('vp09') && samples[0]?.description && samples[0].description.vpcC) {
            decoderConfig.description = samples[0].description.vpcC;
          }

          // Check decoder support for this config:contentReference[oaicite:5]{index=5}
          const supportInfo = await VideoDecoder.isConfigSupported(decoderConfig);
          if (!supportInfo.supported) {
            throw new Error(`Decoding codec ${codec} is not supported on this platform.`);
          }

          // Initialize decoder
          decoder = new VideoDecoder({
            output: handleFrame,
            error: e => console.error('Decoder error:', e)
          });
          decoder.configure(decoderConfig);

          // Check encoder support for VP8 output
          const encConfig = { codec: 'vp8', width: track.video.width, height: track.video.height };
          const encSupport = await VideoEncoder.isConfigSupported(encConfig);
          if (!encSupport.supported) {
            throw new Error('VP8 encoding is not supported in this browser.');
          }

          // Initialize muxer for WebM output (video track only):contentReference[oaicite:6]{index=6}
          muxer = new WebMMuxer({
            target: 'buffer',  // store output in ArrayBuffer internally
            video: { codec: 'V_VP8', width: track.video.width, height: track.video.height }
          });
          // Initialize encoder
          encoder = new VideoEncoder({
            output: handleChunk,
            error: e => console.error('Encoder error:', e)
          });
          encoder.configure(encConfig);
        }

        // Process each video sample: feed to decoder
        for (const sample of samples) {
          // Create EncodedVideoChunk from sample
          const chunk = new EncodedVideoChunk({
            type: sample.is_rap ? 'key' : 'delta',
            timestamp: Math.round(sample.cts * (1000000 / videoTrackInfo.timescale)), // microseconds
            data: new Uint8Array(sample.data)  // copy sample data
          });
          decoder.decode(chunk);
        }

        // Release the memory of processed samples from mp4box
        const lastSampleNum = samples[samples.length - 1].number;
        mp4boxfile.releaseUsedSamples(id, lastSampleNum);
      };

      // Append the entire file buffer to mp4box (parsing happens here)
      arrayBuffer.fileStart = 0;
      mp4boxfile.appendBuffer(arrayBuffer);
      mp4boxfile.flush();  // signal end of file data

      // Wait for all decoding to finish
      await decoder.flush();
      // Wait for all encoding to finish
      await encoder.flush();
      // Finalize WebM file
      const webmBuffer = muxer.finalize();
      const webmBlob = new Blob([webmBuffer], { type: 'video/webm' });

      // Provide download link to user
      const fileName = file.name.replace(/\.[^/.]+$/, ''); // name without extension
      const downloadName = fileName + '_converted.webm';
      const url = URL.createObjectURL(webmBlob);
      outputDiv.innerHTML = `✅ Conversion complete. <a href="${url}" download="${downloadName}">Download WebM</a>`;
      updateProgress(100, 'Conversion complete.');
    } catch (err) {
      console.error(err);
      statusText.textContent = 'Error: ' + err.message;
    }
  }

  // Helper: Extract SPS/PPS NAL units from raw H.264 sample data to build decoder config:contentReference[oaicite:7]{index=7}
  function extractAvcConfig(sampleData) {
    // Parse the first sample for SPS/PPS (assuming length-prefixed NALs)
    const dataView = new DataView(sampleData);
    let offset = 0;
    const spsCount = 1; // typically one SPS
    const ppsCount = 1; // typically one PPS
    const configArray = [];
    // Extract SPS
    if (sampleData.byteLength > 4) {
      const spsLength = dataView.getUint32(offset); offset += 4;
      configArray.push(new Uint8Array(sampleData, offset, spsLength));
      offset += spsLength;
      // Extract PPS
      if (sampleData.byteLength >= offset + 4) {
        const ppsLength = dataView.getUint32(offset); offset += 4;
        configArray.push(new Uint8Array(sampleData, offset, ppsLength));
        // No need to offset further for config
      }
    }
    // Concatenate SPS/PPS arrays into one Uint8Array (AVCDecoderConfigRecord format expectation)
    let totalLen = 0;
    configArray.forEach(arr => totalLen += arr.length);
    const combined = new Uint8Array(totalLen);
    let cur = 0;
    configArray.forEach(arr => { combined.set(arr, cur); cur += arr.length; });
    return combined.buffer;
  }
})();
