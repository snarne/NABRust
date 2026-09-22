// ---------------------------------------------------------------------------
// Monument names from prefab ids.
//
// A world file's prefab id is Rust's StringPool id for the prefab path, and
// that id is the first four bytes (little-endian) of the MD5 of the path.
// So a list of known monument paths is enough to name them offline — checked
// against a real procedural map, where it resolved 56 of 64 monument ids.
// Anything not in this list keeps its measured label ("large monument").
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'

const M = 'assets/bundled/prefabs/autospawn/monument/'
const A = 'assets/bundled/prefabs/autospawn/'

/** Prefab path → the name players use for it. */
const NAMES: Record<string, string> = {
  [`${M}xlarge/launch_site_1.prefab`]: 'Launch Site',
  [`${M}large/airfield_1.prefab`]: 'Airfield',
  [`${M}large/military_tunnel_1.prefab`]: 'Military Tunnel',
  [`${M}large/powerplant_1.prefab`]: 'Power Plant',
  [`${M}large/trainyard_1.prefab`]: 'Train Yard',
  [`${M}large/water_treatment_plant_1.prefab`]: 'Water Treatment',
  [`${M}large/excavator_1.prefab`]: 'Giant Excavator',
  [`${M}medium/junkyard_1.prefab`]: 'Junkyard',
  [`${M}medium/radtown_small_3.prefab`]: 'Sewer Branch',
  [`${M}medium/nuclear_missile_silo.prefab`]: 'Missile Silo',
  [`${M}medium/compound.prefab`]: 'Outpost',
  [`${M}medium/bandit_town.prefab`]: 'Bandit Camp',
  [`${M}harbor/harbor_1.prefab`]: 'Harbor',
  [`${M}harbor/harbor_2.prefab`]: 'Harbor',
  [`${M}harbor/ferry_terminal_1.prefab`]: 'Ferry Terminal',
  [`${M}lighthouse/lighthouse.prefab`]: 'Lighthouse',
  [`${M}offshore/oilrig_1.prefab`]: 'Large Oil Rig',
  [`${M}offshore/oilrig_2.prefab`]: 'Oil Rig',
  [`${M}military_bases/desert_military_base_a.prefab`]: 'Abandoned Military Base',
  [`${M}military_bases/desert_military_base_b.prefab`]: 'Abandoned Military Base',
  [`${M}military_bases/desert_military_base_c.prefab`]: 'Abandoned Military Base',
  [`${M}military_bases/desert_military_base_d.prefab`]: 'Abandoned Military Base',
  [`${M}arctic_bases/arctic_research_base_a.prefab`]: 'Arctic Research Base',
  [`${M}small/satellite_dish.prefab`]: 'Satellite Dish',
  [`${M}small/sphere_tank.prefab`]: 'The Dome',
  [`${M}small/mining_quarry_a.prefab`]: 'Quarry',
  [`${M}small/mining_quarry_b.prefab`]: 'Quarry',
  [`${M}small/mining_quarry_c.prefab`]: 'Quarry',
  [`${M}small/stables_a.prefab`]: 'Ranch',
  [`${M}small/stables_b.prefab`]: 'Large Barn',
  [`${M}roadside/gas_station_1.prefab`]: 'Gas Station',
  [`${M}roadside/supermarket_1.prefab`]: 'Supermarket',
  [`${M}roadside/warehouse.prefab`]: 'Mining Outpost',
  [`${M}roadside/radtown_1.prefab`]: 'Radtown',
  [`${M}fishing_village/fishing_village_a.prefab`]: 'Fishing Village',
  [`${M}fishing_village/fishing_village_b.prefab`]: 'Fishing Village',
  [`${M}fishing_village/fishing_village_c.prefab`]: 'Fishing Village',
  [`${M}swamp/swamp_a.prefab`]: 'Swamp',
  [`${M}swamp/swamp_b.prefab`]: 'Swamp',
  [`${M}swamp/swamp_c.prefab`]: 'Abandoned Cabins',
  [`${M}underwater_lab/underwater_lab_a.prefab`]: 'Underwater Lab',
  [`${M}underwater_lab/underwater_lab_b.prefab`]: 'Underwater Lab',
  [`${M}underwater_lab/underwater_lab_c.prefab`]: 'Underwater Lab',
  [`${M}underwater_lab/underwater_lab_d.prefab`]: 'Underwater Lab',
  [`${M}ice_lakes/ice_lake_1.prefab`]: 'Ice Lake',
  [`${M}ice_lakes/ice_lake_2.prefab`]: 'Ice Lake',
  [`${M}ice_lakes/ice_lake_3.prefab`]: 'Ice Lake',
  [`${M}ice_lakes/ice_lake_4.prefab`]: 'Ice Lake',
  [`${M}cave/cave_small_easy.prefab`]: 'Cave',
  [`${M}cave/cave_small_medium.prefab`]: 'Cave',
  [`${M}cave/cave_small_hard.prefab`]: 'Cave',
  [`${M}cave/cave_medium_easy.prefab`]: 'Cave',
  [`${M}cave/cave_medium_medium.prefab`]: 'Cave',
  [`${M}cave/cave_medium_hard.prefab`]: 'Cave',
  [`${M}cave/cave_large_medium.prefab`]: 'Cave',
  [`${M}cave/cave_large_hard.prefab`]: 'Cave',
  [`${M}cave/cave_large_sewers_hard.prefab`]: 'Sewer Cave',
  [`${M}tiny/water_well_a.prefab`]: 'Water Well',
  [`${M}tiny/water_well_b.prefab`]: 'Water Well',
  [`${M}tiny/water_well_c.prefab`]: 'Water Well',
  [`${M}tiny/water_well_d.prefab`]: 'Water Well',
  [`${M}tiny/water_well_e.prefab`]: 'Water Well',
  [`${A}tunnel-entrance/entrance_bunker_a.prefab`]: 'Train Tunnel',
  [`${A}tunnel-entrance/entrance_bunker_b.prefab`]: 'Train Tunnel',
  [`${A}tunnel-entrance/entrance_bunker_c.prefab`]: 'Train Tunnel',
  [`${A}tunnel-entrance/entrance_bunker_d.prefab`]: 'Train Tunnel',
}

/** Rust's StringPool id for a path. */
export function prefabId(path: string): number {
  return createHash('md5').update(path).digest().readUInt32LE(0)
}

const BY_ID = new Map<number, string>(
  Object.entries(NAMES).map(([path, name]) => [prefabId(path), name]),
)

/** The player-facing name for a monument prefab, or null if it isn't known. */
export function monumentName(id: number | null | undefined): string | null {
  return id == null ? null : BY_ID.get(id) ?? null
}

/**
 * Player-facing name for a stored monument. Resolves known prefabs even on
 * maps parsed before names existed, and drops the old "#prefabId" suffix.
 * Rust+ monuments (no prefab id) already carry real names.
 */
export function displayMonument(name: string, id: number | null): { name: string; named: boolean } {
  const known = monumentName(id)
  if (known) return { name: known, named: true }
  return { name: name.replace(/ #\d+$/, ''), named: id === null }
}
