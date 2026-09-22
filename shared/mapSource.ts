// ---------------------------------------------------------------------------
// Where a server's map image comes from.
//
// The map is NOT a drawing we invent. Every server runs a procedurally
// generated world defined by (seed, worldSize), and there are two legitimate
// ways to get the real thing:
//
//   1. Rust+  — getMap() returns the server's own rendered map as a JPEG,
//               with monument icons already baked in. Requires pairing.
//   2. Parsed — the server's own .map world file, decoded by
//               server/src/parsers and rendered locally, plus monument
//               footprints, topology and the heightmap as data.
//
// Until one of those has loaded for the active server we render a placeholder
// derived from the seed, clearly marked as such. The placeholder is never
// presented as the real map.
// ---------------------------------------------------------------------------

import type { ServerRecord } from './types.ts'

export type MapSource =
  | {
      kind: 'rustplus'
      url: string
      /** Rust+ bakes monument icons into the image, so we don't re-draw them. */
      monumentsBaked: true
      label: string
    }
  | {
      /**
       * Battlemetrics exposes a rendered map for the server's seed via
       * `details.rust_maps`. No pairing required, so this is usually the
       * fastest route out of placeholder mode.
       */
      kind: 'battlemetrics'
      url: string
      monumentsBaked: true
      label: string
    }
  | {
      kind: 'parsed'
      url: string
      monumentsBaked: false
      label: string
    }
  | {
      kind: 'placeholder'
      /** Shown to the user so it is obvious why the real map isn't up. */
      reason: string
      label: string
    }

export function resolveMapSource(server: ServerRecord): MapSource {
  if (server.map.rustPlusImageUrl) {
    return {
      kind: 'rustplus',
      url: server.map.rustPlusImageUrl,
      monumentsBaked: true,
      label: 'RUST+ LIVE MAP',
    }
  }
  if (server.map.parsedRenderUrl) {
    return {
      kind: 'parsed',
      url: server.map.parsedRenderUrl,
      monumentsBaked: false,
      label: 'PARSED WORLD FILE',
    }
  }
  return {
    kind: 'placeholder',
    reason: server.map.pairedWithRustPlus
      ? 'Rust+ paired — map image still downloading'
      : server.seed
        ? 'Parse the seed or pair Rust+ to load the real map'
        : 'Server seed unknown — join the server to read it',
    label: 'PLACEHOLDER',
  }
}

export function isRealMap(src: MapSource): boolean {
  return src.kind !== 'placeholder'
}
