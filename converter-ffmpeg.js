// Get references to UI elements
const dropZone    = document.getElementById('dropZone');
const fileInput   = document.getElementById('fileInput');
const qualitySlider = document.getElementById('qualitySlider');
const qualityLabel  = document.getElementById('qualityLabel');
const convertBtn  = document.getElementById('convertBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar  = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const outputSection = document.getElementById('output');
const outputVideo  = document.getElementById('outputVideo');
const downloadLink = document.getElementById('downloadLink');

// Initialize FFmpeg.wasm instance with progress callback
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
  log: true,
  corePath: 'https://unpkg.com/@ffmpeg/core@0.11.8/dist/ffmpeg-core.js',
  progress: ({ ratio }) => {
    // Update progress bar and text
    const percent = (ratio * 100).toFixed(2);
    progressBar.value = percent;
    progressText.textContent = percent + '%';
  }
});
let ffmpegLoaded = false;
let selectedFile = null;
let originalDuration = 0;  // in seconds

// Update quality label when slider moves
qualitySlider.addEventListener('input', () => {
  qualityLabel.textContent = qualitySlider.value + '%';
});

// Handle drag-and-drop events on the drop zone
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('hover');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('hover');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('hover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleFileSelection(e.dataTransfer.files[0]);
  }
});
// Clicking the drop zone triggers file input
dropZone.addEventListener('click', () => fileInput.click());

// Handle file input selection
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleFileSelection(e.target.files[0]);
  }
});

// When a file is selected (via drop or file dialog)
async function handleFileSelection(file) {
  selectedFile = file;
  // Enable the convert button
  convertBtn.disabled = false;
  // Show the selected file name in the drop zone text
  dropZone.textContent = `Selected file: ${file.name}`;
  // Load video metadata to get duration (for bitrate calculation)
  originalDuration = await getVideoDuration(file);
}

// Utility: get video duration using a temporary video element
function getVideoDuration(file) {
  return new Promise((resolve) => {
    const tempVideo = document.createElement('video');
    tempVideo.preload = 'metadata';
    tempVideo.src = URL.createObjectURL(file);
    tempVideo.onloadedmetadata = () => {
      URL.revokeObjectURL(tempVideo.src);
      resolve(tempVideo.duration);
    };
  });
}

// Convert button click -> perform conversion
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  // Ensure FFmpeg core is loaded
  if (!ffmpegLoaded) {
    progressText.textContent = 'Loading FFmpeg...';
    progressContainer.classList.remove('hidden');
    await ffmpeg.load();  // load WASM FFmpeg core
    ffmpegLoaded = true;
  }
  // Show progress UI and reset to 0%
  progressText.textContent = '0%';
  progressBar.value = 0;
  progressContainer.classList.remove('hidden');
  outputSection.classList.add('hidden');  // hide previous output if any

  // Write input file to FFmpeg FS
  const data = await fetchFile(selectedFile);
  await ffmpeg.FS('writeFile', 'input.mp4', data);

  // Build ffmpeg command with scale filter and bitrates
  const scaleFactor = parseFloat(qualitySlider.value) / 100.0;
  const scaleFilter = `scale=iw*${scaleFactor}:ih*${scaleFactor}`;  // e.g. 0.5 for half size:contentReference[oaicite:10]{index=10}
  // Calculate video bitrate (scale original bitrate by factor)
  let totalBitrate = (selectedFile.size * 8) / originalDuration;  // bits per second
  let videoBitrate = totalBitrate * scaleFactor;
  const audioBitrate = 128000;  // 128k for audio in bits/sec
  if (videoBitrate < 1_00000) {  // ensure a minimum video bitrate ~100kbps
    videoBitrate = 1_00000;
  }
  // Format video bitrate as 'XXXk'
  const videoKbps = Math.floor(videoBitrate / 1000);

  // Run FFmpeg conversion: MP4 -> WebM (VP8/Opus)
  progressText.textContent = 'Converting...';
  try {
    await ffmpeg.run(
      '-y',                             // overwrite output if exists
      '-i', 'input.mp4',                // input file
      '-vf', scaleFilter,               // scale video filter with factor
      '-c:v', 'libvpx',                 // VP8 video codec:contentReference[oaicite:11]{index=11}
      '-b:v', `${videoKbps}k`,          // scaled video bitrate
      '-c:a', 'libopus',                // Opus audio codec:contentReference[oaicite:12]{index=12}
      '-b:a', '128k',                   // audio bitrate 128k
      'output.webm'                     // output file name
    );
  } catch (err) {
    progressText.textContent = 'Error during conversion';
    console.error(err);
    return;
  }

  // Read the output WebM file from FS
  const outputData = ffmpeg.FS('readFile', 'output.webm');
  // Create a blob URL for the output video
  const blob = new Blob([outputData.buffer], { type: 'video/webm' });
  const blobUrl = URL.createObjectURL(blob);

  // Show the output video and download link
  outputVideo.src = blobUrl;
  downloadLink.href = blobUrl;
  outputSection.classList.remove('hidden');
  progressText.textContent = 'Conversion complete!';
});
