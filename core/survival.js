/**
 * Survival System  (core/survival.js)
 * =====================================
 * Runs a continuous 500ms heartbeat OUTSIDE the DAG.
 * Has authority to abort any running task and take immediate action.
 *
 * Threat levels:
 *   0 SAFE        health>16, no mobs, food>16
 *   1 CAUTIOUS    health 13-16, distant mobs, low food
 *   2 THREATENED  health 9-12, mobs nearby, multiple threats
 *   3 CRITICAL    health 5-8, surrounded, lava close, on fire
 *   4 PANIC       health ≤4  — drop everything, flee or die trying
 *
 * Hardcore mindset: dying = permanent. No task is worth the risk.
 */

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { flags, locations } = require('./state')

// ── Constants ─────────────────────────────────────────────────
const HOSTILE_MOBS = [
  'zombie','skeleton','creeper','spider','cave_spider','witch',
  'pillager','vindicator','ravager','blaze','ghast','piglin_brute',
  'hoglin','wither_skeleton','enderman','silverfish','phantom',
  'drowned','husk','stray','bogged','breeze',
]

const THREAT = { SAFE: 0, CAUTIOUS: 1, THREATENED: 2, CRITICAL: 3, PANIC: 4 }

const THRESHOLDS = {
  health: { cautious: 16, threatened: 12, critical: 8, panic: 4 },
  food:   { cautious: 16, threatened: 10 },
  mob:    { cautious: 14, threatened: 8, critical: 4 },
}

// Minimum gear required to start certain task types
const TASK_REQUIREMENTS = {
  mining:  { minFood: 18, minHealth: 14, needsPickaxe: true },
  combat:  { minFood: 18, minHealth: 16, needsWeapon: true, needsArmor: true },
  farming: { minFood: 14, minHealth: 12 },
  trading: { minFood: 14, minHealth: 12 },
  follow:  { minFood: 12, minHealth: 10 },
}

function createSurvival(bot, movement, inventory, getActiveDAG, sendMsg) {
  const { safeGoto, safeSetGoal, clearPathfinding, sleep } = movement
  const { eatFood, equipBestArmor, equipBestWeapon, equipShield, depositInChest } = inventory

  let survivalInterval  = null
  let currentThreat     = THREAT.SAFE
  let lastThreatLevel   = THREAT.SAFE
  let inSurvivalMode    = false
  let interruptedTask   = null   // what was the bot doing before survival kicked in
  let lastReportTime    = 0
  let consecutivePanic  = 0

  // ── Threat Assessment ─────────────────────────────────────────

  function getNearbyHostiles(radius) {
    return Object.values(bot.entities).filter(e =>
      e.type === 'mob' &&
      HOSTILE_MOBS.includes(e.name) &&
      e.position.distanceTo(bot.entity.position) < radius
    )
  }

  function hasLavaNearby(radius = 4) {
    const pos = bot.entity.position
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (let dz = -radius; dz <= radius; dz++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz))
          if (b?.name === 'lava' || b?.name === 'flowing_lava') return true
        }
    return false
  }

  function isOnFire() {
    return bot.entity.onFire === true
  }

  function isFalling() {
    return bot.entity.velocity?.y < -0.8
  }

  function isSubmerged() {
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0))
    return head?.name === 'water' || head?.name === 'flowing_water'
  }

  function hasArmorOn() {
    const slots = [5, 6, 7, 8]  // head, torso, legs, feet
    return slots.filter(s => bot.inventory.slots[s] != null).length >= 2
  }

  function hasWeaponEquipped() {
    const hand = bot.inventory.slots[36]
    return hand && (hand.name.includes('sword') || hand.name.includes('axe'))
  }

  function assessThreat() {
    const health  = bot.health
    const food    = bot.food
    const mobs    = getNearbyHostiles(16)
    const closest = mobs.length
      ? Math.min(...mobs.map(m => m.position.distanceTo(bot.entity.position)))
      : Infinity
    const lava    = hasLavaNearby()
    const onFire  = isOnFire()
    const drowning = isSubmerged() && bot.entity.velocity?.y < 0

    let level = THREAT.SAFE
    const reasons = []

    // Health
    if      (health <= THRESHOLDS.health.panic)     { level = Math.max(level, THREAT.PANIC);     reasons.push(`❤️ ${Math.round(health)}/20 CRÍTICO`) }
    else if (health <= THRESHOLDS.health.critical)  { level = Math.max(level, THREAT.CRITICAL);  reasons.push(`❤️ ${Math.round(health)}/20 muy bajo`) }
    else if (health <= THRESHOLDS.health.threatened){ level = Math.max(level, THREAT.THREATENED); reasons.push(`❤️ ${Math.round(health)}/20`) }
    else if (health <= THRESHOLDS.health.cautious)  { level = Math.max(level, THREAT.CAUTIOUS);  reasons.push(`❤️ ${Math.round(health)}/20`) }

    // Food
    if      (food <= THRESHOLDS.food.threatened)    { level = Math.max(level, THREAT.THREATENED); reasons.push(`🍗 ${Math.round(food)}/20 hambre`) }
    else if (food <= THRESHOLDS.food.cautious)      { level = Math.max(level, THREAT.CAUTIOUS);  reasons.push(`🍗 ${Math.round(food)}/20`) }

    // Mobs
    if (mobs.length > 0) {
      if      (closest <= THRESHOLDS.mob.critical)  { level = Math.max(level, THREAT.CRITICAL);  reasons.push(`⚔️ ${mobs.length} mob(s) a ${Math.round(closest)}b`) }
      else if (closest <= THRESHOLDS.mob.threatened){ level = Math.max(level, THREAT.THREATENED); reasons.push(`⚔️ ${mobs.length} mob(s) cerca`) }
      else if (closest <= THRESHOLDS.mob.cautious)  { level = Math.max(level, THREAT.CAUTIOUS);  reasons.push(`⚔️ mob(s) detectados`) }
      // Many mobs elevate threat further
      if (mobs.length >= 3 && level < THREAT.CRITICAL)  level = Math.max(level, THREAT.CRITICAL)
      if (mobs.length >= 5 && level < THREAT.PANIC)     level = Math.max(level, THREAT.PANIC)
    }

    // Environmental
    if (lava)     { level = Math.max(level, THREAT.CRITICAL);  reasons.push('🌋 Lava cercana') }
    if (onFire)   { level = Math.max(level, THREAT.CRITICAL);  reasons.push('🔥 En llamas') }
    if (drowning) { level = Math.max(level, THREAT.THREATENED); reasons.push('💧 Ahogándose') }

    return { level, reasons, health, food, mobs, closest, lava, onFire }
  }

  // ── Survival Actions ─────────────────────────────────────────

  async function doEatAll() {
    // Eat as many times as needed to fill hunger
    let attempts = 0
    while (bot.food < 20 && attempts < 5) {
      await eatFood()
      await sleep(600)
      attempts++
    }
  }

  async function fleeFromMobs(mobs) {
    if (!mobs.length) return
    // Flee away from the centroid of all mobs
    const cx = mobs.reduce((s, m) => s + m.position.x, 0) / mobs.length
    const cz = mobs.reduce((s, m) => s + m.position.z, 0) / mobs.length
    const pos = bot.entity.position
    const dx  = pos.x - cx
    const dz  = pos.z - cz
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    const flee = new Vec3(pos.x + (dx / len) * 20, pos.y, pos.z + (dz / len) * 20)

    await safeSetGoal(new goals.GoalNear(flee.x, flee.y, flee.z, 3), true)
    await sleep(1500)
  }

  async function fleeFromLava() {
    // Move up + away — try to reach a block that isn't near lava
    const pos = bot.entity.position
    for (const [dx, dz] of [[8,0],[-8,0],[0,8],[0,-8],[8,8],[-8,-8]]) {
      const target = pos.offset(dx, 2, dz)
      const block  = bot.blockAt(target)
      if (block?.name === 'air') {
        await safeSetGoal(new goals.GoalNear(target.x, target.y, target.z, 2), true)
        return
      }
    }
  }

  async function goToSafeLocation() {
    // Priority: chest location > bed location > just go up
    const safe = locations.chest || locations.bed
    if (safe) {
      await safeGoto(safe.x, safe.y, safe.z, 8)
      return
    }
    // No known safe spot: go to Y+20 from current position
    const pos = bot.entity.position
    await safeGoto(pos.x, pos.y + 15, pos.z, 5)
  }

  // ── Interrupt / Resume ────────────────────────────────────────

  function interruptCurrentTask() {
    const dag = getActiveDAG?.()
    if (dag) {
      dag.abort()
      interruptedTask = flags.lastCommand || null
    }
    flags.miningActive     = false
    flags.huntingActive    = false
    flags.explorationActive= false
    flags.woodcuttingActive= false
    flags.followingPlayer  = false
    clearPathfinding()
  }

  function reportToMaster(assessment) {
    const now = Date.now()
    if (now - lastReportTime < 4000) return  // don't spam
    lastReportTime = now
    const r = assessment.reasons.join(' | ')
    sendMsg(`⚠️ SUPERVIVENCIA [${['OK','CAUTELA','AMENAZA','CRÍTICO','PÁNICO'][assessment.level]}] ${r}`)
  }

  // ── Main tick ─────────────────────────────────────────────────

  async function tick() {
    if (flags.isEating || flags.depositActive) return  // mid-action, let it finish

    const assessment = assessThreat()
    const { level, mobs, lava, onFire } = assessment

    // Hysteresis: only ELEVATE instantly, LOWER only after 3 consecutive safe ticks
    if (level > currentThreat) {
      currentThreat = level
    } else if (level < currentThreat) {
      // Need stable lower reading before calming down
      if (level <= lastThreatLevel) currentThreat = level
    }
    lastThreatLevel = level

    if (currentThreat === THREAT.SAFE) {
      if (inSurvivalMode) {
        inSurvivalMode  = false
        consecutivePanic = 0
        sendMsg('✅ Situación segura. Listo para nuevas órdenes.')
        if (interruptedTask) {
          sendMsg(`ℹ️ Estaba haciendo: "${interruptedTask}". Decime si continúo.`)
          interruptedTask = null
        }
      }
      return
    }

    // Report to master
    reportToMaster(assessment)

    // ── CAUTIOUS ─────────────────────────────────────────────
    if (currentThreat === THREAT.CAUTIOUS) {
      if (!hasArmorOn()) await equipBestArmor().catch(() => {})
      if (bot.food < 18)  await doEatAll().catch(() => {})
      return
    }

    // ── THREATENED or worse: interrupt the task ───────────────
    if (!inSurvivalMode && currentThreat >= THREAT.THREATENED) {
      inSurvivalMode = true
      interruptCurrentTask()
      await equipBestArmor().catch(() => {})
    }

    // ── THREATENED ────────────────────────────────────────────
    if (currentThreat === THREAT.THREATENED) {
      if (bot.food < 20)       await doEatAll().catch(() => {})
      if (mobs.length)         await fleeFromMobs(mobs).catch(() => {})
      return
    }

    // ── CRITICAL ──────────────────────────────────────────────
    if (currentThreat === THREAT.CRITICAL) {
      if (onFire) {
        // Find water or just move fast
        const waterBlock = bot.findBlock({ matching: b => b?.name === 'water', maxDistance: 10 })
        if (waterBlock) {
          await safeSetGoal(new goals.GoalNear(waterBlock.position.x, waterBlock.position.y, waterBlock.position.z, 1), true)
        }
      }
      if (lava) await fleeFromLava().catch(() => {})
      await doEatAll().catch(() => {})
      if (mobs.length) await fleeFromMobs(mobs).catch(() => {})
      return
    }

    // ── PANIC ─────────────────────────────────────────────────
    if (currentThreat === THREAT.PANIC) {
      consecutivePanic++
      sendMsg(`🆘 PÁNICO (${consecutivePanic}) — vida: ${Math.round(bot.health)}/20`)

      // Emergency eat: use anything, even rotten flesh
      await doEatAll().catch(() => {})

      // If we have health pots... use them (mineflayer: activateItem while holding)
      const pot = bot.inventory.items().find(i => i.name.includes('health') || i.name.includes('healing'))
      if (pot) {
        try { await bot.equip(pot, 'hand'); await bot.consume() } catch {}
      }

      // Flee hard
      if (mobs.length)  await fleeFromMobs(mobs).catch(() => {})
      else              await goToSafeLocation().catch(() => {})

      if (consecutivePanic >= 10) {
        sendMsg('💀 No puedo escapar. Necesito ayuda o voy a morir.')
        consecutivePanic = 0  // reset so it doesn't spam forever
      }
    }
  }

  // ── Pre-task safety gate ──────────────────────────────────────
  /**
   * Call this before starting any DAG task.
   * Returns { ok: true } or { ok: false, reason: string }
   */
  function preflightCheck(taskType = 'general') {
    const reqs  = TASK_REQUIREMENTS[taskType]
    if (!reqs) return { ok: true }

    const issues = []

    if (reqs.minFood   && bot.food   < reqs.minFood)   issues.push(`🍗 Hambre: ${Math.round(bot.food)}/20 (mínimo ${reqs.minFood})`)
    if (reqs.minHealth && bot.health < reqs.minHealth)  issues.push(`❤️ Vida: ${Math.round(bot.health)}/20 (mínimo ${reqs.minHealth})`)
    if (reqs.needsWeapon && !hasWeaponEquipped())       issues.push('⚔️ Sin arma equipada')
    if (reqs.needsArmor  && !hasArmorOn())              issues.push('🛡️ Sin armadura')
    if (reqs.needsPickaxe) {
      const pick = bot.inventory.slots[36]
      if (!pick?.name.includes('pickaxe')) issues.push('⛏️ Sin pico equipado')
    }

    const environmental = assessThreat()
    if (environmental.level >= THREAT.THREATENED) {
      issues.push(`⚠️ Amenaza activa: ${environmental.reasons.join(', ')}`)
    }

    if (issues.length) return { ok: false, reason: issues.join(' | ') }
    return { ok: true }
  }

  // ── Public API ────────────────────────────────────────────────

  function start() {
    if (survivalInterval) return
    survivalInterval = setInterval(() => {
      tick().catch(err => console.error('[Survival] tick error:', err.message))
    }, 500)
    console.log('[Survival] Heartbeat started — modo hardcore activo')
  }

  function stop() {
    if (survivalInterval) { clearInterval(survivalInterval); survivalInterval = null }
  }

  function getStatus() {
    return {
      threat: currentThreat,
      label: ['SAFE','CAUTIOUS','THREATENED','CRITICAL','PANIC'][currentThreat],
      inSurvivalMode,
      health: bot.health,
      food: bot.food,
    }
  }

  return { start, stop, preflightCheck, getStatus, assessThreat, THREAT }
}

module.exports = { createSurvival }