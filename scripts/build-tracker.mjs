import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['lib/tracker-standalone.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'PocketScience',
  outfile: 'public/tracker.js',
  target: ['es2020'],
});
console.log('Built public/tracker.js');
