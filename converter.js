// converter-ffmpeg.js
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: true });

const drop  = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const progWrap = document.getElementById('progress-container');
const bar      = document.getElementById('progress-bar');
const status   = document.getElementById('status-text');
const output   = document.getElementById('output');

function resetUI() {
  bar.style.width = '0%';
  status.textContent = '';
  progWrap.classList.add('hidden');
  output.innerHTML = '';
  drop.classList.remove('disabled');
  drop.textContent = 'Drag & drop an MP4 here, or click to select';
}
function updateProgress(pct, msg='') {
  bar.style.width = `${pct}%`;
  status.textContent = msg;
}
resetUI();

// Drag/drop + click
;['dragover','dragleave','drop'].forEach(evt => {
  drop.addEventListener(evt, e => {
    e.preventDefault();
    drop.classList.toggle('dragover', evt==='dragover');
    if (evt==='drop' && e.dataTransfer.files[0]) convert(e.dataTransfer.files[0]);
  });
});
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => fileInput.files[0] && convert(fileInput.files[0]));

async function convert(file) {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    alert('Please select an MP4 file.');
    return;
  }
  drop.classList.add('disabled');
  progWrap.classList.remove('hidden');
  updateProgress(0, 'Loading FFmpeg…');

  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }

  // Write input into FFmpeg FS
  ffmpeg.FS('writeFile', 'in.mp4', await fetchFile(file));

  // Run the transcoding command:
  //  - VP8 at 1 Mbps, speed 4 for faster encode, Opus audio
  updateProgress(10, 'Transcoding…');
  await ffmpeg.run(
    '-i','in.mp4',
    '-c:v','libvpx-vp8','-b:v','1M','-speed','4',
    '-c:a','libopus',
    'out.webm'
  );

  updateProgress(80, 'Collecting output…');
  const data = ffmpeg.FS('readFile', 'out.webm');
  const blob = new Blob([data.buffer], { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);
  const name = file.name.replace(/\.mp4$/i, '') + '.webm';

  output.innerHTML = `<a href="${url}" download="${name}">Download WebM</a>`;
  updateProgress(100, 'Done');
}
