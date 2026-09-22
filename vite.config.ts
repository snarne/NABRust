import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Read server/.env the same way `./nab` does, so the dev server knows the API
 * port and token without a second config file. KEY=VALUE lines only; comments
 * and blanks ignored.
 */
function serverEnv(): Record<string, string> {
  const path = new URL('./server/.env', import.meta.url)
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const env = serverEnv()
const api = `http://127.0.0.1:${env.PORT || 8787}`

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Attach the API token to proxied requests — but only ones that come from
 * this machine. `host: true` puts the dev server on the LAN, and a blanket
 * header would hand API access to anything on the same wifi. Teammates on
 * other machines use a token they were given, entered in Settings.
 */
type ProxyLike = {
  on(ev: 'proxyReq', fn: (
    proxyReq: { setHeader(k: string, v: string): void; getHeader(k: string): unknown },
    req: { socket: { remoteAddress?: string } },
  ) => void): void
}
function attachToken(proxy: ProxyLike): void {
  const token = env.NABRUST_TOKEN
  if (!token) return
  proxy.on('proxyReq', (proxyReq, req) => {
    if (proxyReq.getHeader('authorization')) return // browser brought its own
    if (LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      proxyReq.setHeader('authorization', `Bearer ${token}`)
    }
  })
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true, configure: (p) => attachToken(p as unknown as ProxyLike) },
      '/health': { target: api, changeOrigin: true },
    },
  },
})
