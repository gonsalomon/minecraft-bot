/**
 * Farming & Trading Skills
 * ========================
 * Wheat harvest, bread crafting, village finding, villager trade reading.
 */

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { flags, locations } = require('../core/state')

// ══════════════════════════════════════════════════════════════
//  FARMING
// ══════════════════════════════════════════════════════════════
function createFarming(bot, movement, inventory) {
  const { safeGoto, sleep } = movement
  const { depositInChest } = inventory

  async function harvestWheat() {
    if (!locations.farm) throw new Error('No farm location registered')
    await safeGoto(locations.farm.x, locations.farm.y, locations.farm.z, 4)

    let harvested = 0
    while (true) {
      const wheat = bot.findBlock({
        matching: b => b?.name === 'wheat' && b.getProperties().age === 7,
        maxDistance: 32,
      })
      if (!wheat) break

      await bot.pathfinder.goto(new goals.GoalNear(wheat.position.x, wheat.position.y, wheat.position.z, 1))
      try { await bot.dig(wheat); harvested++ } catch {}

      // Replant
      const seed = bot.inventory.items().find(i => i.name === 'wheat_seeds')
      const farmland = bot.blockAt(wheat.position.offset(0, -1, 0))
      if (seed && farmland?.name === 'farmland') {
        try { await bot.placeBlock(farmland, new Vec3(0, 1, 0)) } catch {}
      }
    }
    console.log(`[Farming] Harvested ${harvested} wheat plants`)
    return harvested
  }

  async function makeBread() {
    if (!locations.craftingTable) return false
    const wheatCount = bot.inventory.items()
      .filter(i => i.name === 'wheat')
      .reduce((s, i) => s + i.count, 0)

    if (wheatCount < 3) return false

    const mcData = bot.registry
    const breadItem = mcData.itemsByName?.['bread']
    if (!breadItem) return false

    const recipes = bot.recipesFor(breadItem.id, null, Math.floor(wheatCount / 3), null)
    if (recipes.length) {
      await bot.craft(recipes[0], Math.floor(wheatCount / 3), null)
      return true
    }
    return false
  }

  async function farmCycle() {
    await harvestWheat()
    await makeBread()
    await depositInChest()
  }

  return { harvestWheat, makeBread, farmCycle }
}

// ══════════════════════════════════════════════════════════════
//  TRADING / VILLAGES
// ══════════════════════════════════════════════════════════════
const VILLAGE_BLOCKS = new Set([
  'bed', 'cartography_table', 'lectern', 'composter', 'blast_furnace',
  'smoker', 'loom', 'grindstone', 'stonecutter', 'barrel',
  'fletching_table', 'smithing_table', 'bell'
])
const VILLAGE_RADIUS = 64

function createTrading(bot, movement, state) {
  const { safeGoto, sleep } = movement

  // ── Village Detection ─────────────────────────────────────────
  async function findVillage() {
    const pos = bot.entity.position
    const startX = Math.floor(pos.x)
    const startY = Math.floor(pos.y)
    const startZ = Math.floor(pos.z)

    const beds = [], workBlocks = [], bells = [], villagers = []

    console.log('[Trading] Scanning for village...')

    for (let x = startX - VILLAGE_RADIUS; x <= startX + VILLAGE_RADIUS; x++) {
      for (let z = startZ - VILLAGE_RADIUS; z <= startZ + VILLAGE_RADIUS; z++) {
        for (let y = Math.max(0, startY - 10); y <= Math.min(255, startY + 10); y++) {
          const block = bot.blockAt(new Vec3(x, y, z))
          if (!block) continue
          if (block.name === 'bed') beds.push({ x, y, z })
          else if (block.name === 'bell') bells.push({ x, y, z })
          else if (VILLAGE_BLOCKS.has(block.name)) workBlocks.push({ x, y, z })
        }
      }
    }

    Object.values(bot.entities).forEach(entity => {
      if ((entity.name === 'villager' || entity.name === 'villager_v2') &&
          entity.position.distanceTo(pos) <= VILLAGE_RADIUS) {
        villagers.push(entity)
      }
    })

    const total = beds.length + workBlocks.length + bells.length + villagers.length
    if (total < 3) {
      console.log('[Trading] No village found nearby')
      return false
    }

    const allPoints = [...beds, ...workBlocks, ...bells, ...villagers.map(v => v.position)]
    const cx = Math.round(allPoints.reduce((s, p) => s + p.x, 0) / allPoints.length)
    const cy = Math.round(allPoints.reduce((s, p) => s + p.y, 0) / allPoints.length)
    const cz = Math.round(allPoints.reduce((s, p) => s + p.z, 0) / allPoints.length)

    locations.village = { x: cx, y: cy, z: cz }

    // Nearest bed to center
    let nearestBed = null, minDist = Infinity
    for (const bed of beds) {
      const d = Math.sqrt((bed.x - cx) ** 2 + (bed.z - cz) ** 2)
      if (d < minDist) { minDist = d; nearestBed = bed }
    }
    locations.villageBed = nearestBed

    state.saveState()
    console.log(`[Trading] Village found at ${cx} ${cy} ${cz}`)
    return true
  }

  // ── Villager Filtering ────────────────────────────────────────
  function getVillagersWithProfession(maxDistance = 64) {
    return Object.values(bot.entities).filter(e => {
      if (e.name !== 'villager' && e.name !== 'villager_v2') return false
      if (!e.metadata || !e.metadata[18]) return false
      const prof = e.metadata[18].profession
      return prof && prof !== 'none' && prof !== 'nitwit'
    }).filter(e => e.position.distanceTo(bot.entity.position) <= maxDistance)
  }

  // ── Fetch Trades ──────────────────────────────────────────────
  async function fetchVillagerTrades(villagerEntity) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let win = null
      try {
        win = await bot.openVillager(villagerEntity)
        await sleep(200)
        const trades = win.trades
        if (trades && trades.length > 0) return { trades, window: win }
        win.close()
        await sleep(500)
      } catch (err) {
        console.error(`[Trading] fetchVillagerTrades attempt ${attempt + 1} failed:`, err.message)
        if (win) try { win.close() } catch {}
        await sleep(1000)
      }
    }
    return { trades: null, window: null }
  }

  async function investigateAllVillagers() {
    const villagers = getVillagersWithProfession()
    if (!villagers.length) {
      console.log('[Trading] No villagers with professions found')
      return 0
    }

    console.log(`[Trading] Investigating ${villagers.length} villagers...`)
    let registered = 0

    for (let i = 0; i < villagers.length; i++) {
      const villager = villagers[i]
      try {
        await Promise.race([
          safeGoto(villager.position.x, villager.position.y, villager.position.z, 3),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 15000))
        ])
        await sleep(500)

        const { trades, window } = await fetchVillagerTrades(villager)
        if (trades && trades.length > 0) {
          state.villagerTrades[villager.id] = trades
          registered++
        }
        if (window) try { window.close() } catch {}
      } catch (err) {
        console.error(`[Trading] Error with villager ${i + 1}:`, err.message)
        try { bot.pathfinder.setGoal(null) } catch {}
      }

      if (i < villagers.length - 1) await sleep(1500)
    }

    state.saveState()
    console.log(`[Trading] Registered ${registered}/${villagers.length} villagers`)
    return registered
  }

  // ── Sleeping with village bed ─────────────────────────────────
  async function sleepInBed() {
    const bedLoc = locations.bed || locations.villageBed
    if (!bedLoc) { console.log('[Sleeping] No bed location'); return false }

    await safeGoto(bedLoc.x, bedLoc.y, bedLoc.z, 2)
    const bed = bot.blockAt(new Vec3(bedLoc.x, bedLoc.y, bedLoc.z))
    if (!bed?.name.includes('bed')) { console.log('[Sleeping] Bed not found'); return false }

    try {
      await bot.sleep(bed)
      console.log('[Sleeping] Sleeping...')
      return true
    } catch (err) {
      console.log(`[Sleeping] Cannot sleep: ${err.message}`)
      return false
    }
  }

  // Read trades from the nearest villager (by optional profession) and store them
  async function readVillagerTrades(profession = null) {
    const villagers = getVillagersWithProfession()
    let villager = villagers[0] ?? null
    if (profession) {
      villager = villagers.find(e => {
        const prof = e.metadata?.[18]?.profession ?? ''
        return prof.toLowerCase().includes(profession.toLowerCase())
      }) ?? null
    }
    if (!villager) { console.log(`[Trading] No villager${profession ? ` (${profession})` : ''} found`); return false }

    await safeGoto(villager.position.x, villager.position.y, villager.position.z, 2)
    await sleep(500)
    const { trades, window } = await fetchVillagerTrades(villager)
    if (!trades?.length) { console.log('[Trading] No trades obtained'); return false }

    state.villagerTrades[villager.id] = trades
    state.saveState()
    console.log(`[Trading] Stored ${trades.length} trades for villager ${villager.id}`)
    if (window) try { window.close() } catch {}
    return true
  }

  return {
    findVillage,
    getVillagersWithProfession,
    fetchVillagerTrades,
    readVillagerTrades,
    investigateAllVillagers,
    sleepInBed,
    VILLAGE_BLOCKS,
  }
}

module.exports = { createFarming, createTrading }