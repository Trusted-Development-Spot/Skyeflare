import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

const htmlPages = [
  'index.html',
  'hostinger-vs-bluehost.html',
  'coupons.html',
  'about.html',
  'contact.html',
  'privacy-policy.html',
  'terms.html',
];

export default defineConfig(() => {
  return {
    plugins: [
      tailwindcss(),
      {
        name: 'copy-static-site-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) {
            return;
          }

          const srcData = path.resolve(__dirname, 'data');
          const distData = path.resolve(distDir, 'data');
          if (fs.existsSync(srcData)) {
            fs.cpSync(srcData, distData, {recursive: true, force: true});
          }

          for (const staticFile of ['CNAME', 'robots.txt', 'sitemap.xml']) {
            const srcPath = path.resolve(__dirname, staticFile);
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, path.resolve(distDir, staticFile));
            }
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        input: Object.fromEntries(
          htmlPages.map((page) => [
            page.replace('.html', ''),
            path.resolve(__dirname, page),
          ]),
        ),
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
