/**
 * Mining Skills
 * =============
 * All mining modes: chunk descending, spiral, line, staircase.
 * Best-of from bot.js (staircase + chunk forward advance) and
 * bot_minero.js (serpentine layer, spiral, line, segment confirmation).
 */

const Vec3 = require('vec3')
const { flags, locations, mining, saveMiningProgress, clearMiningProgress } = require('../core/state')

const PROTECTED_BLOCKS = new Set([
  'oak_stairs', 'spruce_stairs', 'birch_stairs', 'jungle_stairs',
  'acacia_stairs', 'dark_oak_stairs', 'mangrove_stairs', 'cherry_stairs',
  'bamboo_stairs', 'stone_stairs', 'cobblestone_stairs', 'stone_brick_stairs',
  'sandstone_stairs', 'granite_stairs', 'diorite_stairs', 'andesite_stairs',
  'brick_stairs', 'nether_brick_stairs', 'quartz_stairs', 'red_sandstone_stairs',
  'purpur_stairs', 'prismarine_stairs', 'prismarine_brick_stairs', 'dark_prismarine_stairs',
  'polished_granite_stairs', 'polished_diorite_stairs', 'polished_andesite_stairs',
  'mossy_cobblestone_stairs', 'mossy_stone_brick_stairs', 'smooth_sandstone_stairs',
  'smooth_quartz_stairs', 'end_stone_brick_stairs', 'blackstone_stairs',
  'polished_blackstone_stairs', 'polished_blackstone_brick_stairs',
  'cut_copper_stairs', 'exposed_cut_copper_stairs', 'weathered_cut_copper_stairs',
  'oxidized_cut_copper_stairs', 'waxed_cut_copper_stairs',
  'oak_slab', 'spruce_slab', 'cobblestone_slab', 'stone_slab',
  'ladder', 'scaffolding',
  'chest', 'crafting_table', 'furnace', 'enchanting_table', 'torch', 'glass', 'glass_pane'
])

const MINEABLE_BLOCKS = new Set([
  'stone', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite',
  'gravel', 'dirt', 'sand', 'sandstone',
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore', 'diamond_ore', 'deepslate_diamond_ore',
  'emerald_ore', 'deepslate_emerald_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'copper_ore', 'deepslate_copper_ore'
])

const PICKAXE_REQUIRED = {
  'stone': 'wooden_pickaxe', 'cobblestone': 'wooden_pickaxe',
  'coal_ore': 'wooden_pickaxe', 'deepslate_coal_ore': 'wooden_pickaxe',
  'iron_ore': 'stone_pickaxe', 'deepslate_iron_ore': 'stone_pickaxe',
  'lapis_ore': 'stone_pickaxe', 'deepslate_lapis_ore': 'stone_pickaxe',
  'gold_ore': 'stone_pickaxe', 'deepslate_gold_ore': 'stone_pickaxe',
  'diamond_ore': 'iron_pickaxe', 'deepslate_diamond_ore': 'iron_pickaxe',
  'emerald_ore': 'iron_pickaxe', 'deepslate_emerald_ore': 'iron_pickaxe',
  'redstone_ore': 'iron_pickaxe', 'deepslate_redstone_ore': 'iron_pickaxe',
  'obsidian': 'diamond_pickaxe', 'ancient_debris': 'diamond_pickaxe',
}

const PICKAXE_TIER = {
  'wooden_pickaxe': 1, 'stone_pickaxe': 2, 'golden_pickaxe': 2,
  'iron_pickaxe': 3, 'diamond_pickaxe': 4, 'netherite_pickaxe': 5
}

const PICKAXE_CRAFT = {
  'wooden_pickaxe': [['oak_planks', 3], ['stick', 2]],
  'stone_pickaxe':  [['cobblestone', 3], ['stick', 2]],
  'iron_pickaxe':   [['iron_ingot', 3], ['stick', 2]],
  'diamond_pickaxe':[['diamond', 3], ['stick', 2]],
}

const OPTIMAL_Y = {
  'coal_ore': 96,      'deepslate_coal_ore': 0,
  'iron_ore': 16,      'deepslate_iron_ore': -16,
  'gold_ore': -16,     'deepslate_gold_ore': -16,
  'lapis_ore': 0,      'deepslate_lapis_ore': -32,
  'diamond_ore': -58,  'deepslate_diamond_ore': -58,
  'redstone_ore': -58, 'deepslate_redstone_ore': -58,
  'emerald_ore': -16,  'ancient_debris': 15,
  'obsidian': -40,
}

const TORCH_CONFIG = { lightLevel: 7 }

function createMining(bot, movement, inventory) {
  const { safeGoto, sleep, getNearestHostile } = movement
  const { getItemFromChest, depositInChest, equipBestWeapon, checkAndEat, PICKAXE_TIER: PT } = inventory

  // ── Lava check ───────────────────────────────────────────────
  function hasLavaNearby(pos) {
    return [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([dx,dy,dz]) => {
      const b = bot.blockAt(pos.offset(dx,dy,dz))
      return b && (b.name === 'lava' || b.name === 'flowing_lava')
    })
  }

  // ── Surface Y finder ─────────────────────────────────────────
  function getSurfaceY(x, z) {
    for (let y = 320; y >= -64; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (b && b.name !== 'air' && b.type !== 0) return y + 1
    }
    return 64
  }

  // ── safeDig ─────────────────────────────────────────────────
  async function safeDig(block) {
    if (!block || block.type === 0) return false
    const fresh = bot.blockAt(block.position)
    if (!fresh || fresh.type === 0 || fresh.name === 'air') return false
    if (PROTECTED_BLOCKS.has(fresh.name)) return false
    await ensurePickaxeForBlock(fresh.name)
    try {
      await bot.dig(fresh, true)
      return true
    } catch (err) {
      const msg = err.message ?? ''
      if (msg.includes('air') || msg.includes('already') || msg.includes('No path') || msg.includes('GoalChanged')) return false
      console.log(`[Mining] safeDig skipped: ${msg}`)
      return false  // non-fatal: continue mining loop
    }
  }

  // ── Torch placement ──────────────────────────────────────────
  async function placeTorchIfNeeded() {
    if (!flags.miningActive) return
    const pos = bot.entity.position
    const block = bot.blockAt(pos)
    if (!block || block.light >= TORCH_CONFIG.lightLevel) return

    const torch = bot.inventory.items().find(i => i.name === 'torch')
    if (!torch) return

    const placeAt = pos.offset(0, 1, 0)
    if (bot.blockAt(placeAt)?.name !== 'air') return

    for (const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]) {
      const support = bot.blockAt(placeAt.offset(dx,dy,dz))
      if (support && support.diggable === false && support.name !== 'air') {
        await bot.equip(torch, 'hand')
        try {
          await bot.placeBlock(support, new Vec3(-dx,-dy,-dz))
          await bot.waitForTicks(5)
        } catch {}
        break
      }
    }
  }

  // ── Torch crafting ───────────────────────────────────────────
  async function ensureTorches() {
    const count = bot.inventory.items()
      .filter(i => i.name === 'torch')
      .reduce((s,i) => s + i.count, 0)
    if (count >= 32) return true

    if (!locations.craftingTable) return false

    const coal = bot.inventory.items()
      .filter(i => i.name === 'coal' || i.name === 'charcoal')
      .reduce((s,i) => s + i.count, 0)
    if (coal < 1) {
      console.log('[Mining] No coal for torches')
      return false
    }

    const mcData = bot.registry
    await safeGoto(locations.craftingTable.x, locations.craftingTable.y, locations.craftingTable.z, 2)
    const table = bot.blockAt(new Vec3(locations.craftingTable.x, locations.craftingTable.y, locations.craftingTable.z))
    const torchItem = mcData.itemsByName?.['torch']
    if (!torchItem) return false
    const recipes = bot.recipesFor(torchItem.id, null, null, table)
    if (recipes.length) {
      await bot.craft(recipes[0], Math.min(coal * 4, 64), table)
      return true
    }
    return false
  }

  // ── Pickaxe management ───────────────────────────────────────
  async function ensurePickaxeForBlock(blockName) {
  const required    = PICKAXE_REQUIRED[blockName] || 'stone_pickaxe'
  const requiredTier = PICKAXE_TIER[required]

  // Incluir mano (36) y offhand (45)
  const heldSlots = [36, 45].map(s => bot.inventory.slots[s]).filter(Boolean)
  const allItems  = [...bot.inventory.items(), ...heldSlots]

  const equipped = bot.inventory.slots[36]
  if (equipped?.name.includes('pickaxe') && (PICKAXE_TIER[equipped.name] || 0) >= requiredTier) return true

  const suitable = allItems
    .filter(i => i.name.includes('pickaxe') && (PICKAXE_TIER[i.name] || 0) >= requiredTier)
    .sort((a, b) => (PICKAXE_TIER[b.name] || 0) - (PICKAXE_TIER[a.name] || 0))[0]

  if (suitable) { await bot.equip(suitable, 'hand'); return true }
  return false
}

  async function ensurePickaxe(blockName) {
    if (await ensurePickaxeForBlock(blockName)) return true

    const required = PICKAXE_REQUIRED[blockName] || 'stone_pickaxe'
    const requiredTier = PICKAXE_TIER[required]

    // Check chest
    if (locations.chest) {
      for (const [name, tier] of Object.entries(PICKAXE_TIER)) {
        if (tier >= requiredTier) {
          if (await getItemFromChest(name, 1)) {
            const found = bot.inventory.items().find(i => i.name === name)
            if (found) { await bot.equip(found, 'hand'); return true }
          }
        }
      }
    }

    // Try to craft
    return await tryCraftPickaxe(required)
  }

  async function tryCraftPickaxe(pickaxeName) {
    if (!locations.craftingTable) return false
    const recipe = PICKAXE_CRAFT[pickaxeName]
    if (!recipe) return false

    // Check/gather materials (simplified - no sub-DAG recursion here)
    for (const [mat, amt] of recipe) {
      const have = bot.inventory.items()
        .filter(i => i.name === mat)
        .reduce((s,i) => s + i.count, 0)
      if (have < amt) {
        if (!await getItemFromChest(mat, amt - have)) {
          console.log(`[Mining] Missing ${amt - have} ${mat} for ${pickaxeName}`)
          return false
        }
      }
    }

    const mcData = bot.registry
    await safeGoto(locations.craftingTable.x, locations.craftingTable.y, locations.craftingTable.z, 2)
    const table = bot.blockAt(new Vec3(locations.craftingTable.x, locations.craftingTable.y, locations.craftingTable.z))
    const itemDef = mcData.itemsByName?.[pickaxeName]
    if (!itemDef) return false
    const recipes = bot.recipesFor(itemDef.id, null, 1, table)
    if (!recipes.length) return false
    await bot.craft(recipes[0], 1, table)
    const crafted = bot.inventory.items().find(i => i.name === pickaxeName)
    if (crafted) { await bot.equip(crafted, 'hand'); return true }
    return false
  }

  // ── Navigation helpers ───────────────────────────────────────
  async function goToMineLocation() {
    if (!locations.mine) throw new Error('No mine location registered')
    await safeGoto(locations.mine.x, locations.mine.y, locations.mine.z, 8)
  }

  // ── Staircase descent (from bot.js) ──────────────────────────
  async function digStaircaseDown(targetY) {
    while (flags.miningActive && Math.floor(bot.entity.position.y) > targetY) {
      const currentY = Math.floor(bot.entity.position.y)
      mining.currentY = currentY
      saveMiningProgress()

      const x = Math.floor(bot.entity.position.x)
      const z = Math.floor(bot.entity.position.z)

      const downBlock = bot.blockAt(new Vec3(x, currentY - 1, z))
      if (downBlock?.diggable && !downBlock.name.includes('lava')) {
        await safeGoto(x, currentY, z, 1)
        await safeDig(downBlock)
      }
      await safeGoto(x, currentY - 1, z, 1)

      const frontBlock = bot.blockAt(new Vec3(x + 1, currentY - 1, z))
      if (frontBlock?.diggable && !frontBlock.name.includes('lava')) await safeDig(frontBlock)

      await placeTorchIfNeeded()
      if (bot.inventory.emptySlotCount() < 9) await depositInChest()
      await bot.waitForTicks(5)
    }
    saveMiningProgress()
  }

  async function ascendToSurface(surfaceY) {
    if (!surfaceY && locations.mine) surfaceY = locations.mine.y
    if (!surfaceY) surfaceY = Math.floor(bot.entity.position.y) + 60

    let currentY = Math.floor(bot.entity.position.y)
    while (flags.miningActive && currentY < surfaceY) {
      const x = Math.floor(bot.entity.position.x)
      const z = Math.floor(bot.entity.position.z)
      const upBlock = bot.blockAt(new Vec3(x, currentY + 1, z))
      if (upBlock && upBlock.name !== 'air') {
        await safeDig(upBlock)
        await bot.waitForTicks(5)
      }
      await safeGoto(x, currentY + 1, z, 1)
      currentY = Math.floor(bot.entity.position.y)
      await bot.waitForTicks(5)
    }
  }

  // ── Serpentine layer (from bot_minero.js) ────────────────────
  async function mineLayerSerpentine(baseX, baseZ, bottomY) {
    for (let row = 0; row < 16; row++) {
      if (!flags.miningActive) return
      const z      = baseZ + row
      const startX = row % 2 === 0 ? baseX : baseX + 15
      const endX   = row % 2 === 0 ? baseX + 15 : baseX
      const dx     = row % 2 === 0 ? 1 : -1

      // Ir al inicio de la fila (capa inferior)
      await safeGoto(startX, bottomY, z, 1)

      for (let x = startX; x !== endX + dx; x += dx) {
        if (!flags.miningActive) return

        // Minar ambas capas en la misma columna antes de avanzar
        for (const yy of [bottomY, bottomY + 1]) {
          const block = bot.blockAt(new Vec3(x, yy, z))
          if (!block || !block.diggable || PROTECTED_BLOCKS.has(block.name) || hasLavaNearby(block.position)) continue
          try { await bot.dig(block, true) } catch (err) {
            const msg = err.message ?? ''
            if (!msg.includes('air') && !msg.includes('already') && !msg.includes('GoalChanged'))
              console.log(`[Mining] dig skipped: ${msg}`)
          }
        }

        await placeTorchIfNeeded()
        await bot.waitForTicks(2)

        // Avanzar al siguiente bloque de la fila
        const nextX = x + dx
        if (nextX !== endX + dx) {
          await safeGoto(nextX, bottomY, z, 1)
        }
      }
    }
  }

  async function mineTwoLayers(chunkX, chunkZ, bottomY) {
  const startX = chunkX * 16
  const startZ = chunkZ * 16
  await mineLayerSerpentine(startX, startZ, bottomY)
}

  // ── Full chunk mining (from bot_minero.js) ────────────────────

  /**
   * Mine the current chunk in descending segments of 16 blocks.
   * @param {boolean} askEachSegment  - pause and wait for 'si'/'no' each segment
   */
  async function mineChunkDescending(askEachSegment = false, pendingConfirmation = null) {
    const chunkX = Math.floor(bot.entity.position.x / 16)
    const chunkZ = Math.floor(bot.entity.position.z / 16)
    const centerX = chunkX * 16 + 8
    const centerZ = chunkZ * 16 + 8
    const surfaceY = getSurfaceY(centerX, centerZ)
    let currentTopY = surfaceY

    flags.miningActive = true
    mining.active = true
    mining.chunkX = chunkX
    mining.chunkZ = chunkZ

    console.log(`[Mining] Descending chunk [${chunkX},${chunkZ}] from Y=${surfaceY}`)

    while (currentTopY > -58 && flags.miningActive) {
      const segmentBottomY = Math.max(currentTopY - 16, -60)

      for (let y = currentTopY; y > segmentBottomY; y -= 2) {
        if (!flags.miningActive) break
        await mineTwoLayers(chunkX, chunkZ, y - 1)
        await checkAndEat()
        if (bot.inventory.emptySlotCount() < 5) await depositInChest()
      }

      if (!flags.miningActive) break
      currentTopY = segmentBottomY
      if (currentTopY <= -60) break

      if (askEachSegment && pendingConfirmation) {
        const answer = await pendingConfirmation(`He minado hasta Y=${currentTopY}. ¿Continuar con los próximos 16 bloques?`)
        if (!answer) {
          console.log(`[Mining] Stopped at Y=${currentTopY} by user`)
          break
        }
      }
    }

    await ascendToSurface(surfaceY)
    flags.miningActive = false
    mining.active = false
    clearMiningProgress()
    console.log('[Mining] Chunk descent complete')
  }

  // ── Spiral mining (from bot_minero.js) ───────────────────────
  async function spiralMining(startY, pendingConfirmation = null) {
    let chunkX = Math.floor(bot.entity.position.x / 16)
    let chunkZ = Math.floor(bot.entity.position.z / 16)
    let step = 1, stepCount = 0, turnCount = 0, dir = 0

    flags.miningActive = true

    while (flags.miningActive) {
      if (pendingConfirmation) {
        const ok = await pendingConfirmation(`¿Minar capa Y=${startY} en chunk [${chunkX},${chunkZ}]?`)
        if (!ok) break
      }

      const centerX = chunkX * 16 + 8
      const centerZ = chunkZ * 16 + 8
      const surfaceY = getSurfaceY(centerX, centerZ)
      await safeGoto(centerX, surfaceY, centerZ, 5)
      await mineTwoLayers(chunkX, chunkZ, startY)
      await depositInChest()

      // Spiral advance
      if (stepCount < step) {
        if (dir === 0) chunkX++
        else if (dir === 1) chunkZ++
        else if (dir === 2) chunkX--
        else chunkZ--
        stepCount++
      } else {
        dir = (dir + 1) % 4
        turnCount++
        if (turnCount % 2 === 0) step++
        stepCount = 0
        if (dir === 0) chunkX++
        else if (dir === 1) chunkZ++
        else if (dir === 2) chunkX--
        else chunkZ--
        stepCount = 1
      }
    }

    flags.miningActive = false
    mining.active = false
  }

  // ── Line mining (from bot_minero.js) ─────────────────────────
  async function lineMining(startY, direction, pendingConfirmation = null) {
    let chunkX = Math.floor(bot.entity.position.x / 16)
    let chunkZ = Math.floor(bot.entity.position.z / 16)
    flags.miningActive = true

    while (flags.miningActive) {
      if (pendingConfirmation) {
        const ok = await pendingConfirmation(`¿Minar capa Y=${startY} en chunk [${chunkX},${chunkZ}]?`)
        if (!ok) break
      }

      const centerX = chunkX * 16 + 8
      const centerZ = chunkZ * 16 + 8
      const surfaceY = getSurfaceY(centerX, centerZ)
      await safeGoto(centerX, surfaceY, centerZ, 5)
      await mineTwoLayers(chunkX, chunkZ, startY)
      await depositInChest()

      if (direction === 'x+') chunkX++
      else if (direction === 'x-') chunkX--
      else if (direction === 'z+') chunkZ++
      else chunkZ--
    }

    flags.miningActive = false
    mining.active = false
  }

  // ── Forward chunk advance (from bot.js) ──────────────────────
  async function mineChunkForwardLoop(blockName) {
    const optimalY = OPTIMAL_Y[blockName] ?? -58

    if (!await ensurePickaxe(blockName)) {
      throw new Error(`Cannot get pickaxe for ${blockName}`)
    }
    await ensureTorches()

    let chunkX = Math.floor(bot.entity.position.x / 16)
    let chunkZ = Math.floor(bot.entity.position.z / 16)

    flags.miningActive = true
    mining.active = true
    mining.target = blockName

    while (flags.miningActive) {
      const centerX = chunkX * 16 + 8
      const centerZ = chunkZ * 16 + 8
      const surfaceY = getSurfaceY(centerX, centerZ)

      await safeGoto(centerX, surfaceY, centerZ, 8)
      await digStaircaseDown(optimalY)
      if (!flags.miningActive) break

      await mineTwoLayers(chunkX, chunkZ, optimalY)
      if (!flags.miningActive) break

      await ascendToSurface(surfaceY)

      // Advance chunk in +X direction
      chunkX++
      mining.chunkX = chunkX
      mining.chunkZ = chunkZ
      mining.currentY = optimalY
      saveMiningProgress()

      await checkAndEat()
      await depositInChest()
      await ensureTorches()
    }

    flags.miningActive = false
    mining.active = false
    clearMiningProgress()
  }

  return {
    safeDig,
    ensurePickaxe,
    ensurePickaxeForBlock,
    tryCraftPickaxe,
    ensureTorches,
    placeTorchIfNeeded,
    goToMineLocation,
    digStaircaseDown,
    ascendToSurface,
    mineLayerSerpentine,
    mineTwoLayers,
    mineChunkDescending,
    mineChunkForwardLoop,
    spiralMining,
    lineMining,
    getSurfaceY,
    hasLavaNearby,
    PROTECTED_BLOCKS,
    MINEABLE_BLOCKS,
    PICKAXE_REQUIRED,
    PICKAXE_TIER,
    OPTIMAL_Y,
  }
}

module.exports = { createMining }