const { defineConfig } = require('vite');
const { resolve, dirname } = require('path');
const fs = require('fs');

module.exports = defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup.html'),
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  closeBundle: () => {
    const filesToCopy = [
      { from: 'manifest.json', to: 'dist/manifest.json' },
      { from: 'src/style.css', to: 'dist/style.css' },
    ];

    filesToCopy.forEach(({ from, to }) => {
      const source = resolve(__dirname, from);
      const destination = resolve(__dirname, to);
      fs.mkdirSync(dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    });
  },
});
