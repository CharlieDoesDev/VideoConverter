import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

// Get DOM elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const statusMessage = document.createElement('div');
statusMessage.id = 'status-message';
progressContainer.appendChild(statusMessage);

// Set up event listeners
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => e.target.files[0] && handleFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { 
  e.preventDefault(); 
  e.stopPropagation();
  dropZone.classList.add('dragover'); 
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
  }
});

/**
 * Handle the selected file and start conversion
 * @param {File} file - The MP4 file to convert
 */
async function handleFile(file) {
  // Check if the file is an MP4
  if (!file.type.includes('mp4') && !file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  
  // Hide drop zone and show progress
  dropZone.hidden = true;
  progressContainer.hidden = false;
  updateStatus('Starting conversion...');
  
  try {
    await convertMp4ToWebM(file);
    updateStatus('Conversion complete!');
  } catch (err) {
    console.error('Conversion error:', err);
    updateStatus(`Error: ${err.message}`);
    setTimeout(() => {
      progressContainer.hidden = true;
      dropZone.hidden = false;
    }, 3000);
  }
}

/**
 * Update the status message
 * @param {string} message - Status message to display
 */
function updateStatus(message) {
  statusMessage.textContent = message;
}

/**
 * Convert MP4 to WebM using WebCodecs
 * @param {File} file - The MP4 file to convert
 */
async function convertMp4ToWebM(file) {
  // Check WebCodecs API availability
  if (!window.VideoDecoder || !window.VideoEncoder) {
    throw new Error('WebCodecs API not supported in this browser');
  }

  updateStatus('Demuxing MP4 file...');
  
  // 1) Demux the MP4 file and get video track data
  const { track, samples } = await demuxMp4(file);
  
  if (!track || !samples || samples.length === 0) {
    throw new Error('Failed to extract video samples from the MP4 file');
  }
  
  updateStatus('Setting up conversion pipeline...');
  
  const {
    codec: rawCodecString,
    video: { width: trackWidth, height: trackHeight },
    avcC,
    timescale,
    nb_samples: totalSamples
  } = track;

  // Ensure we have a valid codec string
  const codecString = rawCodecString || '';
  console.log('Original codec string:', codecString);

  // 2) Build AVC description from SPS/PPS for decoder configuration
  let descriptionBuffer = null;
  if (avcC) {
    const prefix = new Uint8Array([0, 0, 0, 1]);
    const parts = [];
    
    for (const sps of avcC.sequenceParameterSets) {
      parts.push(prefix, new Uint8Array(sps));
    }
    
    for (const pps of avcC.pictureParameterSets) {
      parts.push(prefix, new Uint8Array(pps));
    }
    
    descriptionBuffer = concat(parts).buffer;
  } else {
    throw new Error('Missing codec configuration (avcC)');
  }

  // Calculate proper framerate
  let frameRate = 30; // Default
  if (track.moov && track.moov.mvhd && track.moov.mvhd.duration && track.moov.mvhd.timescale) {
    const duration = track.moov.mvhd.duration / track.moov.mvhd.timescale;
    if (duration > 0) {
      frameRate = Math.round(totalSamples / duration);
    }
  }

  // Use higher quality settings for better output
  const bitrate = Math.max(1_500_000, track.bitrate || 0);

  // 3) Initialize WebM muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP8',
      width: trackWidth,
      height: trackHeight,
      frameRate: frameRate,
    },
  });

  // 4) Create promise to track conversion completion
  let processed = 0;
  
  // 5) Configure VideoEncoder
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      processed++;
      
      // Update progress every 5 frames or on multiples of 1%
      if (processed % 5 === 0 || processed / totalSamples * 100 >= (Math.floor((processed - 1) / totalSamples * 100) + 1)) {
        const percentage = Math.min(95, processed / totalSamples * 100);
        updateProgress(percentage);
        updateStatus(`Converting: ${processed}/${totalSamples} frames processed`);
      }
    },
    error: e => { 
      throw new Error(`Encoding error: ${e.message}`);
    }
  });
  
  await encoder.configure({
    codec: 'vp8',
    width: trackWidth,
    height: trackHeight,
    bitrate: bitrate,
    framerate: frameRate,
    latencyMode: 'quality',
  });

  // 6) Configure VideoDecoder
  const decoder = new VideoDecoder({
    output: frame => {
      encoder.encode(frame, { keyFrame: frame.type === 'key' });
      frame.close();
    },
    error: e => { 
      throw new Error(`Decoding error: ${e.message}`);
    }
  });
  
  // Make sure codec string is properly formatted for WebCodecs
  // H.264 codec strings should be in format 'avc1.PPCCLL' where:
  // PP = profile (42 = Baseline, 4D = Main, 64 = High)
  // CC = constraints
  // LL = level (e.g., 1F = Level 3.1)
  let codec = codecString;
  if (!codec || codec === 'undefined') {
    // Fallback to a common H.264 profile if codec string is missing
    codec = 'avc1.42001E'; // H.264 Baseline Profile Level 3.0
    console.warn('Missing codec string, using fallback:', codec);
  } else if (!codec.startsWith('avc1.')) {
    // Fix codec string format if it's not properly formatted
    // Extract the profile, constraint and level info if available in another format
    const match = codec.match(/^(avc|AVC)(.*)$/);
    if (match) {
      // Try to preserve any profile/level info that might exist
      const suffix = match[2] || '42001E';
      codec = 'avc1.' + suffix.replace(/^[^0-9a-fA-F]/, '');
    } else {
      codec = 'avc1.42001E'; // Fallback
    }
    console.warn('Reformatted codec string:', codec);
  }
  
  // Create decoder configuration
  const decConfig = { 
    codec: codec,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: false
  };
  
  if (descriptionBuffer) {
    decConfig.description = descriptionBuffer;
  }
  
  console.log('Using decoder config:', decConfig);
  
  try {
    await decoder.configure(decConfig);
  } catch (e) {
    console.error('Decoder configuration failed:', e);
    
    // Try alternative configurations if the first attempt fails
    if (e.message.includes('codec') || e.message.includes('Required member is undefined')) {
      // Try with a standard H.264 profile as fallback
      console.log('Trying fallback codec configuration...');
      await decoder.configure({
        codec: 'avc1.42001E', // Baseline Profile Level 3.0
        description: descriptionBuffer
      });
    } else {
      throw e; // Re-throw if it's not a codec issue
    }
  }

  // 7) Process all samples
  updateStatus('Converting video frames...');
  try {
    for (const sample of samples) {
      // Check if the sample data is valid
      if (!sample.data || sample.data.byteLength === 0) {
        console.warn('Skipping empty sample');
        continue;
      }
      
      const chunk = new EncodedVideoChunk({
        type: sample.is_rap ? 'key' : 'delta',
        timestamp: Math.round(sample.cts * 1000000 / timescale), // Convert to microseconds
        duration: Math.round(sample.duration * 1000000 / timescale),
        data: sample.data
      });
      
      decoder.decode(chunk);
    }
    
    updateStatus('Finalizing conversion...');
    
    // Wait for all frames to be processed
    await decoder.flush();
    await encoder.flush();
    
    // 8) Finalize and download
    muxer.finalize();
    const { buffer: webmBuffer } = muxer.target;
    
    if (!webmBuffer || webmBuffer.byteLength === 0) {
      throw new Error('Generated WebM file is empty');
    }
    
    const blob = new Blob([webmBuffer], { type: 'video/webm' });
    const outputFilename = file.name.replace(/\.mp4$/i, '') + '.webm';
    saveBlob(blob, outputFilename);
    
    updateProgress(100);
    return true;
    
  } catch (error) {
    throw new Error(`Processing error: ${error.message}`);
  }
}

/**
 * Concatenate multiple Uint8Array chunks
 * @param {Array<Uint8Array>} chunks - Array of Uint8Array to concatenate
 * @return {Uint8Array} Concatenated array
 */
function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  
  return out;
}

/**
 * Demux an MP4 file to extract video track and samples
 * @param {File} file - The MP4 file to demux
 * @return {Promise<Object>} Object containing track info and samples
 */
async function demuxMp4(file) {
  try {
    const buffer = await file.arrayBuffer();
    buffer.fileStart = 0;
    const mp4boxFile = MP4Box.createFile();

    return new Promise((resolve, reject) => {
      let trackInfo;
      const samples = [];
      let timeoutId;

      // Set timeout to prevent hanging
      timeoutId = setTimeout(() => {
        reject(new Error('Demuxing timed out after 30 seconds'));
      }, 30000);

      mp4boxFile.onError = err => {
        clearTimeout(timeoutId);
        reject(new Error(`MP4Box error: ${err}`));
      };
      
      mp4boxFile.onReady = info => {
        try {
          if (!info || !info.tracks || info.tracks.length === 0) {
            clearTimeout(timeoutId);
            return reject(new Error('No tracks found in the MP4 file'));
          }

          // Look for H.264 video track
          trackInfo = info.tracks.find(t => 
            t.type === 'video' && (t.codec?.startsWith('avc') || t.codec?.startsWith('AVC'))
          );

          if (!trackInfo) {
            clearTimeout(timeoutId);
            return reject(new Error('No H.264 video track found in the file'));
          }
          
          // Ensure the codec string is properly formatted
          if (!trackInfo.codec) {
            // Try to reconstruct a codec string from available information
            if (trackInfo.avcC) {
              // Extract profile and level from avcC box if available
              let profile = '42'; // Baseline profile by default
              let level = '1E';   // Level 3.0 by default
              
              if (trackInfo.avcC.AVCProfileIndication) {
                profile = trackInfo.avcC.AVCProfileIndication.toString(16).padStart(2, '0');
              }
              
              if (trackInfo.avcC.AVCLevelIndication) {
                level = trackInfo.avcC.AVCLevelIndication.toString(16).padStart(2, '0');
              }
              
              trackInfo.codec = `avc1.${profile}001${level}`;
              console.log('Reconstructed codec string:', trackInfo.codec);
            } else {
              // Fallback to a common H.264 profile
              trackInfo.codec = 'avc1.42001E'; // H.264 Baseline Profile Level 3.0
              console.log('Using fallback codec string:', trackInfo.codec);
            }
          }

          mp4boxFile.setExtractionOptions(
            trackInfo.id,
            null,
            { nbSamples: trackInfo.nb_samples }
          );
          
          mp4boxFile.start();
        } catch (e) {
          clearTimeout(timeoutId);
          reject(new Error(`Error processing MP4 header: ${e.message}`));
        }
      };

      mp4boxFile.onSamples = (_id, _user, sArr) => {
        try {
          if (!sArr || sArr.length === 0) {
            return;
          }
          
          samples.push(...sArr);
          
          updateProgress(Math.min(30, samples.length / (trackInfo?.nb_samples || 100) * 30));
          
          if (samples.length >= (trackInfo?.nb_samples || 0)) {
            clearTimeout(timeoutId);
            resolve({ track: trackInfo, samples });
          }
        } catch (e) {
          clearTimeout(timeoutId);
          reject(new Error(`Error processing samples: ${e.message}`));
        }
      };

      try {
        mp4boxFile.appendBuffer(buffer);
        mp4boxFile.flush();
      } catch (e) {
        clearTimeout(timeoutId);
        reject(new Error(`Error appending buffer: ${e.message}`));
      }
    });
  } catch (err) {
    throw new Error(`Failed to read file: ${err.message}`);
  }
}

/**
 * Update the progress bar
 * @param {number} pct - Progress percentage (0-100)
 */
function updateProgress(pct) {
  const percentage = Math.max(0, Math.min(100, pct));
  progressBar.style.width = `${percentage}%`;
  progressBar.setAttribute('aria-valuenow', percentage);
}

/**
 * Save a blob as a file download
 * @param {Blob} blob - Blob to save
 * @param {string} filename - Filename to use
 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
    updateStatus(`Saved as ${filename}`);
    
    // Add reset button
    const resetButton = document.createElement('button');
    resetButton.textContent = 'Convert Another File';
    resetButton.className = 'reset-button';
    resetButton.onclick = () => {
      progressContainer.hidden = true;
      dropZone.hidden = false;
      if (resetButton.parentNode) {
        resetButton.parentNode.removeChild(resetButton);
      }
    };
    progressContainer.appendChild(resetButton);
  }, 100);
}