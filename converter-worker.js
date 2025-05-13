// converter-worker.js
// -------------------

// Load the ffmpeg-webm WASM build into the Worker
importScripts('https://cdn.jsdelivr.net/npm/@salomvary/ffmpeg.js-umd@3.1.9001/ffmpeg-webm.js');

self.onmessage = e => {
  const { inputData, args } = e.data;

  try {
    const result = ffmpeg({
      arguments: args,
      MEMFS: [{ name: 'input.mp4', data: inputData }]
    });
    self.postMessage({ type: 'done', MEMFS: result.MEMFS });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
