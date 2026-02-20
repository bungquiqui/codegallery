import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // GitHub Pages project site path for https://<user>.github.io/codegallery/
  base: '/codegallery/',
  plugins: [react()],
  server: {
    host: true // Expose to network (optional, good for mobile testing)
  }
})
