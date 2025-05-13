import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import copy from 'rollup-plugin-copy';

export default {
  input: 'src/converter.js',
  output: {
    file: 'docs/converter.bundle.js',
    format: 'es',
    sourcemap: true
  },
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    copy({
      targets: [
        {
          src: 'node_modules/@ffmpeg/core/dist/*',
          dest: 'docs/ffmpeg-core'
        }
      ]
    })
  ]
};
