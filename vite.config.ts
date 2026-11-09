import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    // device motion needs a secure context: `npm run dev:https` to test on a phone
    process.env.HTTPS ? basicSsl() : null,
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Pour – acrylic pouring',
        short_name: 'Pour',
        description: 'Acrylic open cup pour simulator. Tilt your phone to make the paint flow.',
        theme_color: '#131416',
        background_color: '#131416',
        display: 'fullscreen',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // screenshots/ is for gnass.buzz and link previews, not for the app
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,jpg,ico,webmanifest,mp3}'], globIgnores: ['screenshots/**'] },
    }),
  ],
});
