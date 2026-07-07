// Tiny build script for the vanilla-TS frontend. Bundles frontend/src/main.ts
// (plus qr-code-styling + jsqr from node_modules) into a single static file
// served by the Express server — no CDN dependency at runtime, no heavyweight
// frontend framework/build pipeline.
//
// Usage: node esbuild.config.mjs [--watch]
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['frontend/src/main.ts'],
  bundle: true,
  outfile: 'public/bundle.js',
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild watching frontend/src/main.ts -> public/bundle.js');
} else {
  await esbuild.build(options);
}
