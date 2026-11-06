import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    // device motion needs a secure context: `npm run dev:https` to test on a phone
    process.env.HTTPS ? basicSsl() : null,
    VitePWA({
      registerType: 'autoUpdate',
      pwaAssets: { config: true },
      manifest: {
        name: 'Pour – acrylic pouring',
        short_name: 'Pour',
        description: 'Acrylic open cup pour simulator. Tilt your phone to make the paint flow.',
        theme_color: '#131416',
        background_color: '#131416',
        display: 'fullscreen',
        orientation: 'portrait',
        start_url: '/',
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,mp3}'] },
    }),
  ],
});
