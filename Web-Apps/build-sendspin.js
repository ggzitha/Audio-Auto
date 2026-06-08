const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['sendspin-entry.js'],
  bundle: true,
  outfile: 'app/static/sendspin-bundle.js',
  format: 'iife',
  globalName: 'SendspinJS',
  minify: true,
  sourcemap: true,
}).catch(() => process.exit(1));
