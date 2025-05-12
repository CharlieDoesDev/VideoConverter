// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { terser } from 'rollup-plugin-terser';

export default {
  input: 'js/converter.js',
  output: {
    file: 'js/vendor/bundle.js',
    format: 'iife',        // immediately-invoked for browsers
    name: 'VideoConverter',
    plugins: [terser()]
  },
  plugins: [
    resolve(),            // locate and bundle mp4box & webm-muxer
    commonjs()            // convert CommonJS modules to ES
  ]
};