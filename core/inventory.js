/**
 * Core Inventory
 * ==============
 * All inventory management: eating, depositing, equipping armor/weapons/tools.
 */

const Vec3 = require('vec3')
const { flags, locations } = require('./state')

// ── Constants ────────────────────────────────────────────────
const FOOD_PRIORITY = [
  'golden_carrot', 'cooked_porkchop', 'cooked_beef', 'cooked_mutton',
  'cooked_salmon', 'cooked_chicken', 'cooked_cod', 'bread',
  'baked_potato', 'carrot', 'apple', 'melon_slice', 'cookie',
  'raw_beef', 'raw_porkchop', 'raw_mutton', 'raw_chicken',
  'raw_salmon', 'raw_cod', 'rotten_flesh'
]

const ARMOR_PRIORITY = {
  head:  ['netherite_helmet',    'diamond_helmet',    'iron_helmet',    'golden_helmet',    'chainmail_helmet',    'leather_helmet'],
  torso: ['netherite_chestplate','diamond_chestplate','iron_chestplate','golden_chestplate','chainmail_chestplate','leather_chestplate'],
  legs:  ['netherite_leggings',  'diamond_leggings',  'iron_leggings',  'golden_leggings',  'chainmail_leggings',  'leather_leggings'],
  feet:  ['netherite_boots',     'diamond_boots',     'iron_boots',     'golden_boots',     'chainmail_boots',     'leather_boots'],
}

const WEAPON_PRIORITY = [
  'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
  'netherite_axe',  'diamond_axe',  'iron_axe',  'stone_axe',  'golden_axe',  'wooden_axe',
]

const AXE_PRIORITY = [
  'netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe'
]

const PICKAXE_TIER = {
  'wooden_pickaxe': 1, 'stone_pickaxe': 2, 'golden_pickaxe': 2,
  'iron_pickaxe': 3, 'diamond_pickaxe': 4, 'netherite_pickaxe': 5
}

const ARMOR_SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8 }

// ── Factory ──────────────────────────────────────────────────
function createInventory(bot, movement) {
  const { safeGoto, sleep } = movement

  // ── Eating ─────────────────────────────────────────────────

  function findFoodInInventory() {
    for (const name of FOOD_PRIORITY) {
      const item = bot.inventory.items().find(i => i.name === name)
      if (item) return item
    }
    return null
  }

  async function getFoodFromChest() {
    if (!locations.chest) return false
    try {
      await safeGoto(locations.chest.x, locations.chest.y, locations.chest.z, 2)
      const chestBlock = bot.blockAt(new Vec3(locations.chest.x, locations.chest.y, locations.chest.z))
      if (!chestBlock?.name.includes('chest')) return false
      const chest = await bot.openChest(chestBlock)
      let found = false
      for (const name of FOOD_PRIORITY) {
        const item = chest.containerItems().find(i => i.name === name)
        if (item) {
          await chest.withdraw(item.type, null, Math.min(item.count, 16))
          found = true
          break
        }
      }
      chest.close()
      return found
    } catch { return false }
  }

  async function eatFood() {
    if (flags.isEating || bot.food >= 20) return
    flags.isEating = true
    try {
      let food = findFoodInInventory()
      if (!food) {
        await getFoodFromChest()
        food = findFoodInInventory()
      }
      if (!food) { console.log('[Inventory] No food available'); return }
      await bot.equip(food, 'hand')
      await bot.consume()
      await sleep(500)
    } catch (err) {
      console.error('[Inventory] eatFood error:', err.message)
    } finally {
      flags.isEating = false
    }
  }

  async function checkAndEat() {
    if (bot.food < 18 || bot.health < 14) await eatFood()
  }

  // ── Chest Operations ─────────────────────────────────────────

  const depositState = {
    active: false,
    lastRun: 0,
    lastHash: null,
    cooldown: 5000,
  }

  function inventoryHash() {
    const armorNames = new Set(Object.values(ARMOR_PRIORITY).flat())
    return bot.inventory.items()
      .filter(i =>
        !i.name.includes('pickaxe') &&
        !i.name.includes('sword') &&
        !i.name.includes('axe') &&
        !armorNames.has(i.name) &&
        !FOOD_PRIORITY.includes(i.name)
      )
      .map(i => `${i.name}:${i.count}`)
      .sort()
      .join('|')
  }

  async function getItemFromChest(itemName, count) {
    if (!locations.chest) return false
    try {
      await safeGoto(locations.chest.x, locations.chest.y, locations.chest.z, 2)
      const chestBlock = bot.blockAt(new Vec3(locations.chest.x, locations.chest.y, locations.chest.z))
      if (!chestBlock?.name.includes('chest')) return false
      const chest = await bot.openChest(chestBlock)
      const item = chest.containerItems().find(i => i.name === itemName)
      if (!item) { chest.close(); return false }
      await chest.withdraw(item.type, null, Math.min(item.count, count))
      chest.close()
      return true
    } catch { return false }
  }

  async function depositInChest(opts = {}) {
    if (!locations.chest) { console.log('[Inventory] No chest registered'); return }
    if (depositState.active) {
      while (depositState.active) await sleep(50)
      return
    }

    const currentHash = inventoryHash()
    if (currentHash !== '' && currentHash === depositState.lastHash && !opts.force) {
      console.log('[Inventory] Inventory unchanged, skipping deposit')
      return
    }

    const now = Date.now()
    if (now - depositState.lastRun < depositState.cooldown && !opts.force) {
      await sleep(depositState.cooldown - (now - depositState.lastRun))
    }

    depositState.active = true
    depositState.lastRun = Date.now()
    flags.depositActive = true

    try {
      await safeGoto(locations.chest.x, locations.chest.y, locations.chest.z, 2)
      const chestBlock = bot.blockAt(new Vec3(locations.chest.x, locations.chest.y, locations.chest.z))
      if (!chestBlock?.name.includes('chest')) {
        console.log('[Inventory] Chest not found at registered location')
        return
      }

      const armorNames = new Set(Object.values(ARMOR_PRIORITY).flat())
      const keepTypes  = new Set()
      for (const item of bot.inventory.items()) {
        const isTool   = item.name.includes('pickaxe') || item.name.includes('sword') || item.name.includes('axe')
        const isArmor  = armorNames.has(item.name)
        const isFood   = FOOD_PRIORITY.includes(item.name) && bot.food < 18
        if (isTool || isArmor || isFood) keepTypes.add(item.type)
      }

      const chest = await bot.openChest(chestBlock)
      let deposited = 0
      for (const item of bot.inventory.items()) {
        if (!keepTypes.has(item.type)) {
          await chest.deposit(item.type, null, item.count)
          deposited += item.count
        }
      }
      chest.close()

      if (deposited > 0) console.log(`[Inventory] Deposited ${deposited} items`)
      depositState.lastHash = inventoryHash()
    } catch (err) {
      if (!err.message?.includes('GoalChanged')) console.error('[Inventory] depositInChest error:', err.message)
    } finally {
      depositState.active = false
      flags.depositActive = false
    }
  }

  // ── Equipment ────────────────────────────────────────────────

  async function equipBestArmor() {
    let equipped = 0
    for (const [slot, priority] of Object.entries(ARMOR_PRIORITY)) {
      const slotIdx = ARMOR_SLOT_INDEX[slot]
      const current = bot.inventory.slots[slotIdx]
      const currentTier = current ? priority.indexOf(current.name) : Infinity

      let bestName = null
      let bestTier = Infinity

      for (let i = 0; i < priority.length; i++) {
        if (bot.inventory.items().some(item => item.name === priority[i])) {
          bestName = priority[i]; bestTier = i; break
        }
      }

      // Also check chest
      if (locations.chest && bestTier > currentTier) {
        for (let i = 0; i < currentTier; i++) {
          const found = await getItemFromChest(priority[i], 1)
          if (found) { bestName = priority[i]; bestTier = i; break }
        }
      }

      if (bestName && bestTier < currentTier) {
        const item = bot.inventory.items().find(i => i.name === bestName)
        if (item) { await bot.equip(item, slot); equipped++ }
      }
    }
    if (equipped > 0) console.log(`[Inventory] Equipped ${equipped} armor piece(s)`)
  }

  async function equipBestWeapon() {
    const equipped = bot.inventory.slots[36]
    if (equipped && WEAPON_PRIORITY.includes(equipped.name)) return equipped.name

    for (const name of WEAPON_PRIORITY) {
      const weapon = bot.inventory.items().find(i => i.name === name)
      if (weapon) { await bot.equip(weapon, 'hand'); return name }
    }

    if (locations.chest) {
      for (const name of WEAPON_PRIORITY) {
        if (await getItemFromChest(name, 1)) {
          const w = bot.inventory.items().find(i => i.name === name)
          if (w) { await bot.equip(w, 'hand'); return name }
        }
      }
    }
    return null
  }

  async function equipBestAxe() {
    const equipped = bot.inventory.slots[36]
    if (equipped?.name.includes('axe')) return true
    const axe = bot.inventory.items().find(i => i.name.includes('axe'))
    if (axe) { await bot.equip(axe, 'hand'); return true }
    if (locations.chest) {
      for (const name of AXE_PRIORITY) {
        if (await getItemFromChest(name, 1)) {
          const found = bot.inventory.items().find(i => i.name === name)
          if (found) { await bot.equip(found, 'hand'); return true }
        }
      }
    }
    return false
  }

  async function equipPickaxe(name) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) { await bot.equip(item, 'hand'); return true }
    if (locations.chest && await getItemFromChest(name, 1)) {
      const found = bot.inventory.items().find(i => i.name === name)
      if (found) { await bot.equip(found, 'hand'); return true }
    }
    return false
  }

  async function equipShield() {
    const offHand = bot.inventory.slots[45]
    if (offHand?.name === 'shield') return true
    const shield = bot.inventory.items().find(i => i.name === 'shield')
    if (shield) { await bot.equip(shield, 'off-hand'); return true }
    if (locations.chest && await getItemFromChest('shield', 1)) {
      const found = bot.inventory.items().find(i => i.name === 'shield')
      if (found) { await bot.equip(found, 'off-hand'); return true }
    }
    return false
  }

  async function reEquipTool() {
    if (flags.miningActive) {
      // skill layer will handle this via its own ensurePickaxe
    } else if (flags.huntingActive) {
      await equipBestWeapon()
    }
  }

  async function pickupNearbyItems() {
    if (flags.miningActive || flags.huntingActive || flags.depositActive) return
    const { goals } = require('mineflayer-pathfinder')
    const dropped = Object.values(bot.entities).filter(e =>
      e.name === 'item' && e.position.distanceTo(bot.entity.position) < 5
    )
    for (const item of dropped) {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1))
        await bot.waitForTicks(10)
      } catch {}
    }
  }

  return {
    findFoodInInventory,
    getFoodFromChest,
    eatFood,
    checkAndEat,
    getItemFromChest,
    depositInChest,
    equipBestArmor,
    equipBestWeapon,
    equipBestAxe,
    equipPickaxe,
    equipShield,
    reEquipTool,
    pickupNearbyItems,
    inventoryHash,
    PICKAXE_TIER,
    FOOD_PRIORITY,
    ARMOR_PRIORITY,
    WEAPON_PRIORITY,
  }
}

module.exports = { createInventory }