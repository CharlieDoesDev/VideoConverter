// rollup.config.js
import resolve  from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser   from '@rollup/plugin-terser';  // default import, not destructured

export default {
  input: 'js/converter.js',
  output: {
    file:      'js/vendor/bundle.js',
    format:    'iife',        // immediately‐invoked for browsers
    name:      'VideoConverter',
    sourcemap: true,          // generate source maps
    plugins:   [ terser() ]   // minify via terser()
  },
  plugins: [
    resolve(),   // bundle MP4Box & webm-muxer
    commonjs()   // convert any CommonJS modules
  ]
};
