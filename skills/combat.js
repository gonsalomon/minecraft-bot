/**
 * Combat Skills
 * =============
 * All 6 combat strategies from bot.js, plus hunt loop, patrol, retreat.
 */

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { flags } = require('../core/state')

const HOSTILE_MOBS = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'ravager', 'blaze',
  'ghast', 'piglin_brute', 'hoglin', 'wither_skeleton',
  'enderman', 'silverfish', 'phantom', 'drowned', 'husk',
  'stray', 'bogged', 'breeze'
]

const SPECIAL_MOBS = {
  creeper:  { strategy: 'hit_and_run',  safeDistance: 4 },
  skeleton: { strategy: 'shield_rush',  safeDistance: 2 },
  spider:   { strategy: 'aggressive',   safeDistance: 2 },
  enderman: { strategy: 'avoid',        safeDistance: 8 },
  witch:    { strategy: 'rush',         safeDistance: 3 },
  blaze:    { strategy: 'ranged_dodge', safeDistance: 5 },
}

const HUNT_CONFIG = {
  combatRange:    3,
  safeHealth:     12,
  safeFood:       12,
  retreatHealth:  8,
  blockChance:    0.7,
  blockDuration:  20,
  attackCooldown: 12,
  fallbackDistance: 15,
  awarenessRadius: 16,
}

const CombatState = {
  IDLE: 'idle', APPROACHING: 'approaching', BLOCKING: 'blocking',
  ATTACKING: 'attacking', RETREATING: 'retreating', HEALING: 'healing',
}

function createCombat(bot, movement, inventory) {
  const { safeSetGoal, safeGoto, sleep } = movement
  const { equipBestWeapon, equipBestArmor, equipShield, eatFood, pickupNearbyItems, depositInChest } = inventory

  let currentCombatState = CombatState.IDLE
  let currentTarget      = null
  let lastShieldUse      = 0
  let combatTick         = 0

  // ── Helpers ──────────────────────────────────────────────────

  function getNearestHostile(maxDistance) {
    return Object.values(bot.entities)
      .filter(e => e.type === 'mob' && HOSTILE_MOBS.includes(e.name) &&
        e.position.distanceTo(bot.entity.position) < maxDistance)
      .sort((a, b) =>
        a.position.distanceTo(bot.entity.position) -
        b.position.distanceTo(bot.entity.position)
      )[0] ?? null
  }

  function evaluateThreat(mob) {
    const special = SPECIAL_MOBS[mob.name]
    const distance = mob.position.distanceTo(bot.entity.position)
    let threat = (special ? 30 : 0)
      + (special?.strategy === 'hit_and_run'  ? 20 : 0)
      + (special?.strategy === 'ranged_dodge' ? 25 : 0)
    threat += distance < 2 ? 40 : distance < 4 ? 20 : distance < 6 ? 10 : 0
    threat += bot.health < HUNT_CONFIG.retreatHealth ? 50 : bot.health < HUNT_CONFIG.safeHealth ? 25 : 0
    return {
      level: threat,
      shouldEngage: threat < 60 && bot.health > HUNT_CONFIG.retreatHealth,
      shouldRetreat: threat > 70 || bot.health < HUNT_CONFIG.retreatHealth,
      strategy: special?.strategy || 'normal',
    }
  }

  function analyzeSituation() {
    const mobs = Object.values(bot.entities).filter(e =>
      e.type === 'mob' && HOSTILE_MOBS.includes(e.name) &&
      e.position.distanceTo(bot.entity.position) < HUNT_CONFIG.awarenessRadius
    )
    if (!mobs.length) return { safe: true, totalThreat: 0 }

    let total = 0
    const threats = mobs.map(m => { const t = evaluateThreat(m); total += t.level; return { mob: m, ...t } })
    const priority = threats.filter(t => t.shouldEngage).sort((a, b) => b.level - a.level)[0]
    return {
      safe: total < 50,
      shouldFlee: total > 100 || priority?.shouldRetreat,
      threats,
      priorityTarget: priority?.mob,
      totalThreat: total,
    }
  }

  function hasShield() {
    const off = bot.inventory.slots[45]
    return off && off.name === 'shield'
  }

  async function useShield(duration = HUNT_CONFIG.blockDuration) {
    if (!hasShield() || Date.now() - lastShieldUse < 100) return false
    lastShieldUse = Date.now()
    try {
      bot.activateItem()
      setTimeout(() => { if (currentCombatState === CombatState.BLOCKING) bot.deactivateItem() }, duration * 50)
      return true
    } catch { return false }
  }

  function stopShield() { if (hasShield()) try { bot.deactivateItem() } catch {} }

  async function attackMob(mob) {
    if (!mob?.isValid) return false
    try {
      bot.lookAt(mob.position.offset(0, 1, 0))
      await bot.attack(mob)
      combatTick++
      return true
    } catch { return false }
  }

  // ── Retreat ───────────────────────────────────────────────────

  async function retreatShort(mob) {
    const dir = bot.entity.position.minus(mob.position).normalize()
    const flee = bot.entity.position.plus(dir.scaled(4))
    await safeSetGoal(new goals.GoalNear(flee.x, flee.y, flee.z, 2), true)
    await bot.waitForTicks(15)
  }

  async function retreatFromMob(mob) {
    currentCombatState = CombatState.RETREATING
    const dir = bot.entity.position.minus(mob.position).normalize()
    const flee = bot.entity.position.plus(dir.scaled(HUNT_CONFIG.fallbackDistance))
    if (hasShield()) await useShield(20)
    await safeSetGoal(new goals.GoalNear(flee.x, flee.y, flee.z, 3), true)
    await bot.waitForTicks(40)
    if (analyzeSituation().safe && bot.health < HUNT_CONFIG.safeHealth) await eatFood()
    currentCombatState = CombatState.IDLE
  }

  async function retreatToSafeLocation() {
    currentCombatState = CombatState.RETREATING
    const pos = bot.entity.position
    await safeSetGoal(new goals.GoalNear(pos.x + 20, pos.y, pos.z + 20, 3), true)
    await bot.waitForTicks(40)
    currentCombatState = CombatState.IDLE
  }

  // ── Combat Strategies ────────────────────────────────────────

  async function hitAndRunStrategy(mob) {
    let hits = 0
    while (mob.isValid && currentCombatState !== CombatState.RETREATING) {
      if (evaluateThreat(mob).shouldRetreat || bot.health < HUNT_CONFIG.retreatHealth) { await retreatFromMob(mob); return }
      if (mob.position.distanceTo(bot.entity.position) > HUNT_CONFIG.combatRange + 1) {
        await safeSetGoal(new goals.GoalNear(mob.position.x, mob.position.y, mob.position.z, HUNT_CONFIG.combatRange))
      } else if (hits >= 2) {
        await attackMob(mob); hits = 0; await retreatShort(mob)
      } else {
        await attackMob(mob); hits++
      }
      await bot.waitForTicks(HUNT_CONFIG.attackCooldown)
    }
  }

  async function shieldRushStrategy(mob) {
    await equipShield()
    while (mob.isValid && currentCombatState !== CombatState.RETREATING) {
      if (evaluateThreat(mob).shouldRetreat || bot.health < HUNT_CONFIG.retreatHealth) { await retreatFromMob(mob); return }
      if (mob.position.distanceTo(bot.entity.position) > HUNT_CONFIG.combatRange) {
        await useShield(10)
        await safeSetGoal(new goals.GoalNear(mob.position.x, mob.position.y, mob.position.z, HUNT_CONFIG.combatRange))
      } else {
        await attackMob(mob)
        if (Math.random() < HUNT_CONFIG.blockChance) await useShield(15)
      }
      await bot.waitForTicks(HUNT_CONFIG.attackCooldown)
    }
  }

  async function rushStrategy(mob) {
    while (mob.isValid && currentCombatState !== CombatState.RETREATING) {
      if (evaluateThreat(mob).shouldRetreat || bot.health < HUNT_CONFIG.retreatHealth) { await retreatFromMob(mob); return }
      if (mob.position.distanceTo(bot.entity.position) > HUNT_CONFIG.combatRange) {
        await safeSetGoal(new goals.GoalNear(mob.position.x, mob.position.y, mob.position.z, HUNT_CONFIG.combatRange))
      } else {
        await attackMob(mob)
      }
      await bot.waitForTicks(HUNT_CONFIG.attackCooldown)
    }
  }

  async function avoidStrategy(mob) {
    const dir = bot.entity.position.minus(mob.position).normalize()
    const flee = bot.entity.position.plus(dir.scaled(HUNT_CONFIG.fallbackDistance))
    await safeSetGoal(new goals.GoalNear(flee.x, flee.y, flee.z, 3))
    await bot.waitForTicks(40)
  }

  async function rangedDodgeStrategy(mob) {
    await equipShield()
    let strafe = 1
    while (mob.isValid && currentCombatState !== CombatState.RETREATING) {
      if (evaluateThreat(mob).shouldRetreat || bot.health < HUNT_CONFIG.retreatHealth) { await retreatFromMob(mob); return }
      const toMob = mob.position.minus(bot.entity.position).normalize()
      const move = bot.entity.position.plus(new Vec3(toMob.z * strafe, 0, -toMob.x * strafe).scaled(2))
      if (mob.position.distanceTo(bot.entity.position) > HUNT_CONFIG.combatRange) {
        await safeSetGoal(new goals.GoalNear(move.x, move.y, move.z, 2))
        strafe *= -1
      } else {
        await attackMob(mob); await useShield(10)
      }
      await bot.waitForTicks(HUNT_CONFIG.attackCooldown)
    }
  }

  async function normalCombatStrategy(mob) {
    while (mob.isValid && currentCombatState !== CombatState.RETREATING) {
      if (bot.health < HUNT_CONFIG.retreatHealth) { await retreatFromMob(mob); return }
      if (bot.food < HUNT_CONFIG.safeFood) await eatFood()
      if (evaluateThreat(mob).shouldRetreat) { await retreatFromMob(mob); return }
      if (mob.position.distanceTo(bot.entity.position) > HUNT_CONFIG.combatRange) {
        await safeSetGoal(new goals.GoalNear(mob.position.x, mob.position.y, mob.position.z, HUNT_CONFIG.combatRange))
      } else {
        if (hasShield() && Math.random() < HUNT_CONFIG.blockChance) await useShield(10)
        await attackMob(mob)
      }
      await bot.waitForTicks(HUNT_CONFIG.attackCooldown)
    }
  }

  async function fightMob(mob) {
    if (!mob?.isValid) return false
    const threat = evaluateThreat(mob)
    if (!await equipBestWeapon()) { console.log('[Combat] No weapon'); return false }

    currentTarget = mob
    currentCombatState = CombatState.APPROACHING

    switch (threat.strategy) {
      case 'hit_and_run':  await hitAndRunStrategy(mob);   break
      case 'shield_rush':  await shieldRushStrategy(mob);  break
      case 'rush':         await rushStrategy(mob);         break
      case 'avoid':        await avoidStrategy(mob);        break
      case 'ranged_dodge': await rangedDodgeStrategy(mob);  break
      default:             await normalCombatStrategy(mob)
    }

    currentCombatState = CombatState.IDLE
    currentTarget = null
    stopShield()
    return !mob.isValid
  }

  // ── Patrol ───────────────────────────────────────────────────
  async function patrol() {
    const pos = bot.entity.position
    const angle = Math.random() * Math.PI * 2
    const dist  = 8 + Math.random() * 8
    await safeSetGoal(
      new goals.GoalNear(pos.x + Math.cos(angle) * dist, pos.y, pos.z + Math.sin(angle) * dist, 3),
      true
    )
    await bot.waitForTicks(20)
  }

  // ── Hunt Loop (DAG-compatible: resolves when huntingActive = false) ──
  async function huntLoop() {
    await equipShield()
    await equipBestArmor()

    flags.huntingActive = true
    while (flags.huntingActive) {
      try {
        const sit = analyzeSituation()
        if (sit.shouldFlee) {
          if (sit.priorityTarget) await retreatFromMob(sit.priorityTarget)
          else await retreatToSafeLocation()
          await bot.waitForTicks(40)
          continue
        }
        if (bot.food < HUNT_CONFIG.safeFood)  await eatFood()
        if (bot.health < HUNT_CONFIG.safeHealth) await eatFood()

        const target = sit.priorityTarget || getNearestHostile(HUNT_CONFIG.awarenessRadius)
        if (target && evaluateThreat(target).shouldEngage) {
          if (await fightMob(target)) await pickupNearbyItems()
        } else if (!target && sit.safe) {
          await patrol()
        }
        await bot.waitForTicks(5)
      } catch (err) {
        console.error('[Combat] Hunt error:', err.message)
        await bot.waitForTicks(20)
      }
    }
    await depositInChest()
  }

  return {
    getNearestHostile,
    evaluateThreat,
    analyzeSituation,
    hasShield,
    useShield,
    stopShield,
    attackMob,
    fightMob,
    retreatFromMob,
    retreatShort,
    patrol,
    huntLoop,
    HOSTILE_MOBS,
    SPECIAL_MOBS,
    HUNT_CONFIG,
  }
}

module.exports = { createCombat }