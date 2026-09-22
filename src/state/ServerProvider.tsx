import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import { DEFAULT_SERVER_ID, datasets, serverList } from '../data/datasets'
import {
  ApiError, fetchDataset, fetchServerRecords, fetchStatus, liveDataset, loadConfig, saveConfig,
  type ApiConfig, type ApiStatus,
} from '../data/live'
import type { ServerDataset, ServerRecord, SteamId } from '../../shared/types'

/**
 * live       talking to a NABRust API; every server shown is a real one
 * demo       no API reachable; the bundled demo datasets, labelled as such
 * connecting first attempt still in flight
 */
export type DataMode = 'live' | 'demo' | 'connecting'

export interface Connection {
  mode: DataMode
  /** Why we're in demo mode, when we are. */
  error: string | null
  config: ApiConfig
  lastSync: number | null
}

interface Ctx {
  serverId: string
  server: ServerRecord
  data: ServerDataset
  servers: ServerRecord[]
  setServerId: (id: string) => void
  /** Current display name for a steam id on THIS server. */
  nameOf: (id: SteamId) => string
  connection: Connection
  setApiConfig: (c: ApiConfig) => void
  /** Re-fetch now — after a parse-map, or a change made from the UI. */
  refresh: () => void
  /** True for our own team — never shown as a threat. */
  isUs: (id: SteamId | string) => boolean
  /** Integration health for Settings and the rail, live mode only. */
  status: ApiStatus | null
  /** Whether the full dataset for the active server has arrived yet. */
  datasetLoaded: boolean
}

const ServerCtx = createContext<Ctx | null>(null)

/** Population and map status change slowly; a minute is plenty. */
const REFRESH_MS = 60_000
/** Events and team positions move; the active server refreshes faster. */
const DATASET_REFRESH_MS = 20_000
const REQUEST_TIMEOUT_MS = 8_000

export function ServerProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ApiConfig>(() => loadConfig())
  const [records, setRecords] = useState<ServerRecord[] | null>(null)
  const [mode, setMode] = useState<DataMode>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const [serverId, setServerId] = useState<string>(DEFAULT_SERVER_ID)

  useEffect(() => {
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const pull = async () => {
      // An unroutable remote address would otherwise hang on "connecting"
      // forever; give each attempt a deadline of its own.
      const attempt = new AbortController()
      const onAbort = () => attempt.abort()
      ctl.signal.addEventListener('abort', onAbort)
      const deadline = setTimeout(() => attempt.abort(), REQUEST_TIMEOUT_MS)
      try {
        const recs = await fetchServerRecords(config, attempt.signal)
        if (ctl.signal.aborted) return
        if (recs.length === 0) {
          setRecords(null)
          setMode('demo')
          setError('The API is up but tracks no servers yet — run `nab init`.')
        } else {
          setRecords(recs)
          setMode('live')
          setError(null)
          setLastSync(Date.now())
        }
      } catch (e) {
        if (ctl.signal.aborted) return
        // A blip while live keeps the last good data rather than flipping the
        // whole app to demo mid-session.
        setMode((m) => (m === 'live' ? 'live' : 'demo'))
        setError(
          e instanceof ApiError ? e.message
            : attempt.signal.aborted
              ? `The NABRust API did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
              : 'Could not reach the NABRust API — is `nab serve` running?',
        )
      } finally {
        clearTimeout(deadline)
        ctl.signal.removeEventListener('abort', onAbort)
      }
      if (!ctl.signal.aborted) timer = setTimeout(pull, REFRESH_MS)
    }
    void pull()

    return () => {
      ctl.abort()
      if (timer) clearTimeout(timer)
    }
  }, [config, tick])

  const live = mode === 'live' && records !== null
  const servers = live ? records : serverList

  // Keep the selection valid when the list changes under it (demo -> live).
  useEffect(() => {
    if (!servers.some((s) => s.id === serverId) && servers[0]) setServerId(servers[0].id)
  }, [servers, serverId])

  // --- the active server's full dataset (live mode) ---
  const [liveData, setLiveData] = useState<ServerDataset | null>(null)
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const activeLiveId = live ? (records.find((r) => r.id === serverId) ?? records[0])?.id ?? null : null

  useEffect(() => {
    setLiveData((d) => (d && d.server.id === activeLiveId ? d : null))
    setStatus((st) => (activeLiveId ? st : null))
    if (!activeLiveId) return
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const pull = async () => {
      try {
        const [ds, st] = await Promise.all([
          fetchDataset(config, activeLiveId, ctl.signal),
          fetchStatus(config, activeLiveId, ctl.signal).catch(() => null),
        ])
        if (ctl.signal.aborted) return
        setLiveData(ds)
        setStatus(st)
      } catch {
        // Keep whatever we last had; the server list poll reports outages.
      }
      if (!ctl.signal.aborted) timer = setTimeout(pull, DATASET_REFRESH_MS)
    }
    void pull()
    return () => { ctl.abort(); if (timer) clearTimeout(timer) }
  }, [activeLiveId, config, tick])

  const data: ServerDataset = useMemo(() => {
    if (live) {
      const rec = records.find((r) => r.id === serverId) ?? records[0]
      // Until the full dataset lands, show the server's real map and nothing
      // else — never the demo collections.
      if (liveData && liveData.server.id === rec.id) {
        // The record from the list poll is fresher for pop/map than a dataset
        // fetched up to 20 s ago; the dataset's heat is the computed one.
        return { ...liveData, server: { ...rec, heat: liveData.server.heat } }
      }
      return liveDataset(rec)
    }
    return datasets[serverId] ?? datasets[DEFAULT_SERVER_ID]
  }, [live, records, serverId, liveData])

  const isUs = useCallback((id: string) => {
    if (data.self && id === data.self) return true
    return data.teamIds?.includes(id) ?? false
  }, [data])

  const nameOf = useCallback(
    (id: SteamId) =>
      data.players[id]?.names.find((n) => n.lastSeen === null)?.name ?? `…${id.slice(-5)}`,
    [data],
  )

  const setApiConfig = useCallback((c: ApiConfig) => {
    saveConfig(c)
    setMode('connecting')
    setConfig(c)
  }, [])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  const value = useMemo<Ctx>(
    () => ({
      serverId: data.server.id,
      server: data.server,
      data,
      servers,
      setServerId,
      nameOf,
      connection: { mode, error, config, lastSync },
      setApiConfig,
      refresh,
      isUs,
      status,
      datasetLoaded: !live || (liveData !== null && liveData.server.id === data.server.id),
    }),
    [data, servers, nameOf, mode, error, config, lastSync, setApiConfig, refresh, isUs, status, live, liveData],
  )

  return <ServerCtx.Provider value={value}>{children}</ServerCtx.Provider>
}

export function useServer(): Ctx {
  const ctx = useContext(ServerCtx)
  if (!ctx) throw new Error('useServer must be used inside <ServerProvider>')
  return ctx
}

/** Convenience: the active server's dataset. */
export function useDataset(): ServerDataset {
  return useServer().data
}
