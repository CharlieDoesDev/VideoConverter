import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { terser } from 'rollup-plugin-terser';

export default {
  input: 'js/converter.js',         // your entrypoint
  output: {
    file: 'js/vendor/bundle.js',    // bundled UMD output
    format: 'iife',                 // immediately-invoked browser script
    name: 'VideoConverter',         // global var if needed
    plugins: [terser()]             // minify
  },
  plugins: [
    resolve(),      // locate mp4box & webm-muxer modules
    commonjs()      // convert CommonJS→ESM if needed
  ]
};
