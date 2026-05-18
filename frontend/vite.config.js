import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false // SEGURANÇA: não gerar source maps em produção (exposição de código-fonte)
  }
})
