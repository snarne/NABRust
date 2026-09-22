import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Chip, T } from '../components/ui'
import { Icon } from '../components/icons'
import { MapCanvas } from '../components/MapCanvas'
import { useServer } from '../state/ServerProvider'

type State = 'done' | 'current' | 'todo'

function Step({ n, title, desc, state, children }: {
  n: number; title: string; desc: string; state: State; children?: ReactNode
}) {
  const done = state === 'done'
  const cur = state === 'current'
  const bg = done ? T.green : cur ? T.rust : T.surf3
  const fg = done || cur ? '#0c0e0f' : T.txt3
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{
          width: 34, height: 34, borderRadius: '50%', background: bg, color: fg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 16, flexShrink: 0,
        }}>
          {done ? Icon.check({ size: 17 }) : n}
        </span>
        <span style={{ flexGrow: 1, width: 2, background: done ? T.green : T.border, margin: '6px 0' }} />
      </div>
      <div style={{ flexGrow: 1, paddingBottom: 22 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: done || cur ? T.txt : T.txt2 }}>{title}</div>
        <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.55, margin: '5px 0 0', maxWidth: 470 }}>{desc}</p>
        {children}
      </div>
    </div>
  )
}

export function Onboarding() {
  const { server, status, connection } = useServer()
  const live = connection.mode === 'live'
  // Each step ticks off from what has actually happened, not from a script.
  const steps = [
    { done: live, title: 'Start NABRust', desc: 'Run `./nab serve` on the machine that hosts NABRust and leave it running, then `npm run dev` for this app. Everything else depends on it.' },
    { done: !!status?.battlemetrics.lastPoll, title: 'Collect sessions from Battlemetrics', desc: 'Register your server with `nab init --battlemetrics <id>`. The collector polls once a minute; teammate detection needs days of it, so start early and keep it running.' },
    { done: !!status?.map.parsedAt, title: "Load the server's real map", desc: '`nab map --world` downloads the world file for the current seed; `nab parse-map` renders it and extracts monuments and terrain. Re-run both after each wipe.' },
    { done: !!status?.rustplus.paired, title: 'Pair Rust+', desc: "Pair the server from the in-game menu (SETUP.md step 6). NABRust gets your team's positions, deaths, in-game time and events like cargo and heli over Facepunch's companion socket — nothing touches the game client." },
    { done: (status?.agents.length ?? 0) > 0, title: 'Install the log agent and the combatlog keybind', desc: 'The agent tails each gaming PC\'s client log and sends combat logs: file reads and a socket, no GPU cost. Chain combatlog onto a key you already press after fights — no macros, synthetic input is what scripting detection looks for.', code: 'bind f2 consoletoggle;clear;combatlog' },
  ]
  const doneCount = steps.filter((x) => x.done).length
  const current = steps.findIndex((x) => !x.done)
  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div style={{
        width: 520, flexShrink: 0, position: 'relative',
        background: 'var(--ocean)', borderRight: `1px solid ${T.border}`, overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.35 }}>
          <MapCanvas server={server} showMonuments={false} compact />
        </div>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(180deg, rgba(12,14,15,.55), rgba(12,14,15,.92))',
        }} />
        <div style={{ position: 'relative', padding: '48px 44px', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              width: 40, height: 40, borderRadius: 9,
              background: `linear-gradient(135deg, ${T.rust}, ${T.rustBr})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#160b03',
            }}>{Icon.bolt({ size: 20 })}</span>
            <span className="rjd" style={{ fontSize: 26, fontWeight: 700, letterSpacing: 1.6 }}>
              NAB<span style={{ color: T.rust }}>RUST</span>
            </span>
          </div>
          <div style={{ flexGrow: 1 }} />
          <div className="rjd" style={{ fontSize: 38, fontWeight: 700, lineHeight: 1.15 }}>
            Know who you’re<br />up against before<br />you spawn in.
          </div>
          <p style={{ fontSize: 15, color: T.txt2, lineHeight: 1.6, marginTop: 16, maxWidth: 380 }}>
            Clan detection, shooter retracing and raid costing — built entirely on public data and your own
            combat logs.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            <Chip color={T.green} bg="rgba(87,176,111,.13)">NO CLIENT ACCESS</Chip>
            <Chip color={T.green} bg="rgba(87,176,111,.13)">READS NO GAME MEMORY</Chip>
            <Chip color={T.steel} bg={T.steelDim}>SELF-HOSTED</Chip>
          </div>
        </div>
      </div>

      <div style={{ flexGrow: 1, padding: '56px 56px 40px', overflowY: 'auto' }}>
        <div className="label">SETUP · {doneCount} OF {steps.length} COMPLETE</div>
        <div className="rjd" style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>Connect your team</div>
        <div style={{ height: 4, borderRadius: 2, background: T.surf3, overflow: 'hidden', maxWidth: 520, marginTop: 12 }}>
          <div style={{ height: '100%', width: `${(doneCount / steps.length) * 100}%`, background: T.rust }} />
        </div>
        <div style={{ height: 30 }} />

        {steps.map((st, i) => (
          <Step key={st.title} n={i + 1} state={st.done ? 'done' : i === current ? 'current' : 'todo'} title={st.title} desc={st.desc}>
            {st.code && (
              <div style={{ marginTop: 12, background: 'var(--bg)', border: `1px solid ${T.border}`, borderRadius: 8, padding: '12px 14px' }}>
                <code className="mono" style={{ fontSize: 12, color: T.rustBr }}>{st.code}</code>
              </div>
            )}
          </Step>
        ))}
        <Link to="/" className="btn btn--primary" style={{ height: 38, display: 'inline-flex', padding: '0 20px' }}>
          {doneCount === steps.length ? 'Open the command map' : 'Continue to the app'}
        </Link>
      </div>
    </div>
  )
}
