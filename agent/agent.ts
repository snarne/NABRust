#!/usr/bin/env node
// ---------------------------------------------------------------------------
// NABRust log agent — the ONLY component that runs on a gaming PC.
//
// It tails the Rust client log and ships new lines to your NABRust box. That
// is the whole job: file I/O and an HTTP POST. No GPU work, no game memory,
// no network interception, no injected input. Rust is a GPU-bound game and
// this must never compete with it.
//
// Setup on each teammate's machine:
//   1. Steam -> Rust -> Properties -> Launch Options:
//        -logfile "C:\rust-logs\client.log"
//   2. In game, bind combatlog onto a key you already press after fights:
//        bind f2 consoletoggle;clear;combatlog
//      That is an ordinary keybind, not a macro. Do NOT use input-automation
//      software to press it for you — synthetic input is exactly what
//      anti-cheat scripting detection looks for.
//   3. node --experimental-strip-types agent/agent.ts \
//        --log "C:\rust-logs\client.log" --server example-trio \
//        --me 7656119... --url http://nab-box:8787 --token secret
// ---------------------------------------------------------------------------

import { open, stat, type FileHandle } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

interface Options {
  logPath: string
  serverId: string
  steamId: string
  url: string
  token: string
  pollMs: number
  batchMs: number
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback?: string): string => {
    const i = argv.indexOf(`--${name}`)
    const v = i >= 0 ? argv[i + 1] : fallback
    if (v === undefined) {
      console.error(`missing --${name}`)
      process.exit(1)
    }
    return v
  }
  return {
    logPath: get('log'),
    serverId: get('server'),
    steamId: get('me'),
    url: get('url', 'http://127.0.0.1:8787').replace(/\/$/, ''),
    token: get('token'),
    pollMs: Number(get('poll', '2000')),
    batchMs: Number(get('batch', '5000')),
  }
}

/**
 * Only combat-log table rows are worth shipping. Everything else in a Unity
 * player log is noise, and not sending it keeps the agent cheap and avoids
 * forwarding anything unrelated to the game off the machine.
 */
const COMBAT_ROW = /^\s*\d+(\.\d+)?s?\s+\S+.*\b\d{17}\b/
const COMBAT_HEADER = /^\s*time\s+attacker/i

function isInteresting(line: string): boolean {
  return COMBAT_ROW.test(line) || COMBAT_HEADER.test(line)
}

async function post(opts: Options, text: string): Promise<void> {
  const res = await fetch(`${opts.url}/ingest/combatlog`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: opts.serverId,
      reporterId: opts.steamId,
      text,
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const report = (await res.json()) as { encounters: number; events: number }
  console.log(`shipped → ${report.encounters} encounters, ${report.events} events`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  console.log(`watching ${opts.logPath}`)
  console.log(`reporting as ${opts.steamId} on ${opts.serverId} → ${opts.url}`)

  let offset = 0
  let handle: FileHandle | null = null
  let pending: string[] = []
  let lastFlush = Date.now()
  let carry = ''

  // Start at the end so we don't ship the whole history on first run.
  try {
    offset = (await stat(opts.logPath)).size
  } catch {
    console.log('log not found yet — waiting for Rust to create it')
  }

  for (;;) {
    try {
      const info = await stat(opts.logPath)

      // Rust rewrites the log on launch; a shrink means a new session.
      if (info.size < offset) {
        console.log('log rotated — restarting from the top')
        offset = 0
        carry = ''
        if (handle) { await handle.close(); handle = null }
      }

      if (info.size > offset) {
        handle ??= await open(opts.logPath, 'r')
        const len = info.size - offset
        const buf = Buffer.alloc(len)
        await handle.read(buf, 0, len, offset)
        offset = info.size

        const chunk = carry + buf.toString('utf8')
        const lines = chunk.split(/\r?\n/)
        carry = lines.pop() ?? ''          // keep the partial last line
        for (const l of lines) if (isInteresting(l)) pending.push(l)
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error('read error:', (e as Error).message)
      if (handle) { await handle.close().catch(() => {}); handle = null }
    }

    // Batch so a burst of combat doesn't become a burst of requests.
    if (pending.length && Date.now() - lastFlush >= opts.batchMs) {
      const batch = pending
      pending = []
      lastFlush = Date.now()
      try {
        await post(opts, batch.join('\n'))
      } catch (e) {
        console.error('ship failed, requeueing:', (e as Error).message)
        pending = batch.concat(pending)   // don't lose data on a blip
      }
    }

    await sleep(opts.pollMs)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
