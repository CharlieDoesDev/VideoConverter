// import ffmpeg-webm.js into the Worker scope
importScripts('https://cdn.jsdelivr.net/npm/@salomvary/ffmpeg.js-umd@3.1.9001/ffmpeg-webm.js');

self.onmessage = e => {
  const { inputData, args } = e.data;
  let out;
  try {
    out = ffmpeg({
      arguments: args,
      MEMFS: [{ name: 'input.mp4', data: inputData }]
    });
    self.postMessage({ type: 'done', MEMFS: out.MEMFS });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
