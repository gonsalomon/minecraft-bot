/**
 * Lumberjack Skills
 * =================
 * Tree finding, cutting, leaf clearing, sapling replanting, exploration.
 * Best-of from bot_leñador.js (leaves + replanting) and bot.js (ensureAxe crafting).
 */

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { flags, locations } = require('../core/state')

const WOOD_BLOCKS = new Set([
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'
])

const LEAVES_BLOCKS = new Set([
  'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
  'azalea_leaves', 'flowering_azalea_leaves'
])

const TREE_HEIGHT_LIMIT = 12

function createLumberjack(bot, movement, inventory) {
  const { safeGoto, safeSetGoal, sleep, getNearestHostile } = movement
  const { equipBestAxe, depositInChest, checkAndEat, getItemFromChest } = inventory

  // ── Tree Detection ────────────────────────────────────────────
  function findCompleteTree(maxDistance = 24) {
    const log = bot.findBlock({
      matching: b => WOOD_BLOCKS.has(b?.name),
      maxDistance,
    })
    if (!log) return null

    const treeBlocks = []
    for (let y = -1; y <= TREE_HEIGHT_LIMIT; y++) {
      const block = bot.blockAt(log.position.offset(0, y, 0))
      if (block && WOOD_BLOCKS.has(block.name)) treeBlocks.push(block)
    }
    return treeBlocks.length ? { blocks: treeBlocks, basePos: treeBlocks[0].position } : null
  }

  // ── Leaf Clearing ─────────────────────────────────────────────
  async function breakLeavesAround(treePos) {
    const toBreak = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -1; dy <= TREE_HEIGHT_LIMIT; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          const pos = treePos.offset(dx, dy, dz)
          const block = bot.blockAt(pos)
          if (block && LEAVES_BLOCKS.has(block.name)) toBreak.push(block)
        }
      }
    }
    // Break leaves bare-handed to preserve tool durability
    for (const leaf of toBreak) {
      try {
        await safeGoto(leaf.position.x, leaf.position.y, leaf.position.z, 2)
        await bot.dig(leaf)
        await sleep(50)
      } catch {}
    }
  }

  // ── Sapling Replanting ────────────────────────────────────────
  async function plantSapling(treeBasePos) {
    const sapling = bot.inventory.items().find(i => i.name.includes('sapling'))
    if (!sapling) { console.log('[Lumberjack] No sapling to replant'); return false }

    const groundBlock = bot.blockAt(treeBasePos)
    if (groundBlock && groundBlock.name !== 'air') {
      // Try adjacent spots
      for (const [ox, oz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const adjPos = treeBasePos.offset(ox, 0, oz)
        if (bot.blockAt(adjPos)?.name === 'air') {
          const supportPos = adjPos.offset(0, -1, 0)
          const support = bot.blockAt(supportPos)
          if (support && support.name !== 'air') {
            await safeGoto(adjPos.x, adjPos.y, adjPos.z, 1)
            await bot.equip(sapling, 'hand')
            try { await bot.placeBlock(support, new Vec3(0, 1, 0)); return true } catch {}
          }
        }
      }
    } else {
      const support = bot.blockAt(treeBasePos.offset(0, -1, 0))
      if (support && support.name !== 'air') {
        await safeGoto(treeBasePos.x, treeBasePos.y, treeBasePos.z, 1)
        await bot.equip(sapling, 'hand')
        try { await bot.placeBlock(support, new Vec3(0, 1, 0)); return true } catch {}
      }
    }
    return false
  }

  // ── Ensure Axe ────────────────────────────────────────────────
  async function ensureAxe() {
    if (await inventory.equipBestAxe()) return true

    // Try crafting stone_axe
    if (!locations.craftingTable) return false
    console.log('[Lumberjack] Trying to craft stone_axe...')

    const mcData = bot.registry
    const axeItem = mcData.itemsByName?.['stone_axe']
    if (!axeItem) return false

    // Check materials
    const cobble = bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((s,i) => s+i.count, 0)
    const sticks = bot.inventory.items().filter(i => i.name === 'stick').reduce((s,i) => s+i.count, 0)

    // Can we craft? (simplified, no recursive material gathering here)
    if (cobble < 3 || sticks < 2) {
      console.log('[Lumberjack] Missing materials for stone_axe')
      return false
    }

    await safeGoto(locations.craftingTable.x, locations.craftingTable.y, locations.craftingTable.z, 2)
    const table = bot.blockAt(new Vec3(locations.craftingTable.x, locations.craftingTable.y, locations.craftingTable.z))
    const recipes = bot.recipesFor(axeItem.id, null, 1, table)
    if (!recipes.length) return false

    await bot.craft(recipes[0], 1, table)
    const crafted = bot.inventory.items().find(i => i.name === 'stone_axe')
    if (crafted) { await bot.equip(crafted, 'hand'); return true }
    return false
  }

  // ── Cut Tree ──────────────────────────────────────────────────
  async function cutTree(tree) {
    flags.woodcuttingActive = true
    if (!await ensureAxe()) {
      console.log('[Lumberjack] No axe available')
      flags.woodcuttingActive = false
      return false
    }

    // Cut logs bottom to top
    for (const block of tree.blocks) {
      if (!flags.woodcuttingActive && !flags.explorationActive) break
      if (getNearestHostile(8)) { flags.woodcuttingActive = false; return false }

      await safeGoto(block.position.x, block.position.y, block.position.z, 2)
      try { await bot.dig(block) } catch {}
      await sleep(100)

      if (bot.inventory.emptySlotCount() < 4) {
        await depositInChest()
      }
    }

    // Clear leaves
    await breakLeavesAround(tree.basePos)

    // Collect drops
    await pickupNearbyItems()

    // Replant
    await plantSapling(tree.basePos)

    flags.woodcuttingActive = false
    return true
  }

  // ── Pickup ────────────────────────────────────────────────────
  async function pickupNearbyItems() {
    const dropped = Object.values(bot.entities).filter(e =>
      e.name === 'item' && e.position.distanceTo(bot.entity.position) < 6
    )
    for (const item of dropped) {
      try {
        await safeSetGoal(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1), true)
        await sleep(200)
      } catch {}
    }
  }

  // ── Explore & Cut Loop ────────────────────────────────────────
  /**
   * Explore chunks in a snake pattern, cutting every tree found.
   * Runs until flags.explorationActive is false or targetLogs reached.
   * @param {number} targetLogs  stop when this many logs are in inventory
   */
  async function exploreCutUntil(targetLogs = 64) {
    flags.explorationActive = true
    let lastChunkX = Math.floor(bot.entity.position.x / 16)
    let lastChunkZ = Math.floor(bot.entity.position.z / 16)

    while (flags.explorationActive) {
      await checkAndEat()

      const logCount = bot.inventory.items()
        .filter(i => WOOD_BLOCKS.has(i.name))
        .reduce((s,i) => s + i.count, 0)

      if (logCount >= targetLogs) {
        console.log(`[Lumberjack] Reached ${logCount}/${targetLogs} logs`)
        break
      }

      const tree = findCompleteTree(16)
      if (tree) {
        await cutTree(tree)
        await depositIfNeeded()
        continue
      }

      // Snake pattern exploration
      const cx = Math.floor(bot.entity.position.x / 16)
      const cz = Math.floor(bot.entity.position.z / 16)
      let nextX = (cx + 1) * 16 + 8
      let nextZ = cz * 16 + 8
      if (Math.abs(cx - lastChunkX) > 5) {
        nextX = cx * 16 + 8
        nextZ = (cz + 1) * 16 + 8
      }
      lastChunkX = cx; lastChunkZ = cz
      await safeGoto(nextX, bot.entity.position.y, nextZ, 8)
      await sleep(1000)
    }

    flags.explorationActive = false
    flags.woodcuttingActive = false
  }

  async function depositIfNeeded() {
    const freeSlots = 36 - bot.inventory.items().length
    if (freeSlots < 4) await depositInChest()
  }

  return {
    findCompleteTree,
    breakLeavesAround,
    plantSapling,
    ensureAxe,
    cutTree,
    pickupNearbyItems,
    exploreCutUntil,
    WOOD_BLOCKS,
    LEAVES_BLOCKS,
  }
}

module.exports = { createLumberjack }