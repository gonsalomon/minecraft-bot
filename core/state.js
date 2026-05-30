/**
 * Core State
 * ==========
 * Single source of truth for all bot location data and runtime flags.
 * Everything that was previously scattered as module-level globals lives here.
 */

const fs = require('fs')
const path = require('path')

const STATE_FILE     = path.join(__dirname, '..', 'state.json')
const MINING_FILE    = path.join(__dirname, '..', 'mining_state.json')

// ── Location State ───────────────────────────────────────────
const locations = {
  chest:         null,   // { x, y, z }
  craftingTable: null,
  mine:          null,
  farm:          null,
  bed:           null,
  village:       null,
  villageBed:    null,
}

// ── Mining Progress ──────────────────────────────────────────
const mining = {
  active:       false,
  target:       null,    // block name
  currentY:     null,
  chunkX:       null,
  chunkZ:       null,
  startX:       null,
  startZ:       null,
}

// ── Runtime Flags ────────────────────────────────────────────
// These are checked by skills to know if they should abort loops.
const flags = {
  miningActive:     false,
  huntingActive:    false,
  followingPlayer:  false,
  explorationActive:false,
  woodcuttingActive:false,
  isEating:         false,
  isDodging:        false,
  depositActive:    false,
  dagRunning:       false,   // true while any DAG is executing
}

// ── Villager Data ─────────────────────────────────────────────
let villagerTrades = {}   // UUID → trades[]

// ── Persistence ──────────────────────────────────────────────
function saveState() {
  const data = {
    locations,
    villagerTrades,
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[State] Error saving state:', err.message)
  }
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (data.locations) {
      Object.assign(locations, data.locations)
    }
    if (data.villagerTrades) {
      villagerTrades = data.villagerTrades
    }
    console.log('[State] Loaded:', JSON.stringify(locations))
  } catch {
    console.log('[State] No previous state, starting fresh.')
  }
}

function saveMiningProgress() {
  try {
    fs.writeFileSync(MINING_FILE, JSON.stringify(mining, null, 2))
  } catch (err) {
    console.error('[State] Error saving mining progress:', err.message)
  }
}

function loadMiningProgress() {
  try {
    const data = JSON.parse(fs.readFileSync(MINING_FILE, 'utf8'))
    if (data.active && data.target) {
      Object.assign(mining, data)
      console.log('[State] Mining progress loaded:', data)
      return true
    }
  } catch {}
  return false
}

function clearMiningProgress() {
  if (fs.existsSync(MINING_FILE)) {
    try { fs.unlinkSync(MINING_FILE) } catch {}
  }
  mining.active  = false
  mining.target  = null
  mining.currentY = null
  mining.chunkX  = null
  mining.chunkZ  = null
  mining.startX  = null
  mining.startZ  = null
}

/** Stop all active tasks. Used by 'basta' command and DAG abort. */
function stopAll() {
  for (const key of Object.keys(flags)) {
    if (typeof flags[key] === 'boolean') flags[key] = false
  }
}

module.exports = {
  locations,
  mining,
  flags,
  get villagerTrades() { return villagerTrades },
  set villagerTrades(v) { villagerTrades = v },
  saveState,
  loadState,
  saveMiningProgress,
  loadMiningProgress,
  clearMiningProgress,
  stopAll,
}