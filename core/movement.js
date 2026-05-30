/**
 * Core Movement
 * =============
 * All pathfinding, dodge, and follow logic.
 * Best version from bot_minero.js (most defensive GoalChanged/Timeout handling)
 * with the village-aware safe movement from bot_comerciante.js.
 */

const { goals, Movements } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { flags } = require('./state')

const HOSTILE_MOBS = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'ravager', 'blaze',
  'ghast', 'piglin_brute', 'hoglin', 'wither_skeleton',
  'enderman', 'silverfish', 'phantom', 'drowned', 'husk',
  'stray', 'bogged', 'breeze'
]

const VILLAGE_BLOCKS = new Set([
  'bed', 'cartography_table', 'lectern', 'composter', 'blast_furnace',
  'smoker', 'loom', 'grindstone', 'stonecutter', 'barrel',
  'fletching_table', 'smithing_table', 'bell'
])

const DODGE_CONFIG = {
  enabled: true,
  detectionRadius: 8,
  safeDistance: 12,
  checkInterval: 500,
}

// ── Factory: returns movement functions bound to a bot ────────
function createMovement(bot) {
  let pathfindingLock = false
  let pendingGoal     = null
  let dodgeInterval   = null
  let followInterval  = null

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  /** Set sprint mode, optionally avoiding village blocks */
  function setSprintMode(enabled, forbiddenBlocks = new Set()) {
    const movements = new Movements(bot)
    movements.allowSprinting = enabled
    if (forbiddenBlocks.size > 0) {
      const mcData = bot.registry
      movements.blocksToAvoid.clear()
      for (const blockName of forbiddenBlocks) {
        const block = mcData.blocksByName?.[blockName]
        if (block !== undefined) movements.blocksToAvoid.add(block.id)
      }
    }
    bot.pathfinder.setMovements(movements)
  }

  /** Detect village blocks near destination (for safe movement) */
  function detectVillageBlocks(x, y, z, radius = 16) {
    const found = new Set()
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -5; dy <= 5; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const block = bot.blockAt(new Vec3(x + dx, y + dy, z + dz))
          if (block && VILLAGE_BLOCKS.has(block.name)) found.add(block.name)
        }
      }
    }
    return found
  }

  /**
   * The definitive safeGoto — handles GoalChanged and Timeout gracefully.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} range
   * @param {object} opts
   * @param {boolean} opts.villageMode  — never break blocks, avoid village blocks
   */
  async function safeGoto(x, y, z, range = 2, opts = {}) {
    // Wait for any active lock
    let waited = 0
    while (pathfindingLock && waited < 30) {
      await sleep(100)
      waited++
    }
    if (pathfindingLock) {
      console.log('[Movement] pathfindingLock timeout, forcing reset')
      pathfindingLock = false
      try { bot.pathfinder.setGoal(null) } catch {}
      await sleep(200)
    }

    // Clear previous goal
    try {
      if (bot.pathfinder?.goal) { bot.pathfinder.setGoal(null); await sleep(50) }
    } catch {}

    const villageBlocks = opts.villageMode ? detectVillageBlocks(x, y, z) : new Set()
    setSprintMode(false, villageBlocks)

    const attempt = async () => {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
    }

    try {
      pathfindingLock = true
      await attempt()
    } catch (err) {
      const msg = err.message ?? ''
      if (msg.includes('GoalChanged')) {
        console.log('[Movement] GoalChanged — retrying')
        await sleep(100)
        try { await attempt() } catch {}  // second attempt failure is non-fatal
      } else if (msg.includes('Timeout') || msg.includes('No path') || msg.includes('PathStopped')) {
        console.log(`[Movement] Path failed (${msg.split('\n')[0]}) → giving up, continuing task`)
        // non-fatal: caller keeps running
      } else {
        // All other errors: log but don't crash the task
        console.error(`[Movement] safeGoto error (non-fatal): ${msg}`)
      }
    } finally {
      setSprintMode(true, villageBlocks)
      pathfindingLock = false
    }
  }

  /**
   * Non-blocking goal set. Queues if lock is active.
   */
  async function safeSetGoal(goal, priority = false) {
    if (pathfindingLock) { pendingGoal = { goal, priority }; return false }
    try {
      pathfindingLock = true
      if (goal === null) bot.pathfinder.setGoal(null)
      else bot.pathfinder.setGoal(goal, priority)
      return true
    } catch (err) {
      console.error('[Movement] safeSetGoal error:', err.message)
      return false
    } finally {
      setTimeout(() => {
        pathfindingLock = false
        if (pendingGoal) {
          const { goal, priority } = pendingGoal
          pendingGoal = null
          safeSetGoal(goal, priority)
        }
      }, 200)
    }
  }

  /** Force clear all pathfinding state */
  function clearPathfinding() {
    pathfindingLock = false
    pendingGoal = null
    try { bot.pathfinder.setGoal(null) } catch {}
  }

  // ── Helpers ─────────────────────────────────────────────────

  function getNearestHostile(maxDistance) {
    return Object.values(bot.entities)
      .filter(e => e.type === 'mob' && HOSTILE_MOBS.includes(e.name) &&
        e.position.distanceTo(bot.entity.position) < maxDistance)
      .sort((a, b) =>
        a.position.distanceTo(bot.entity.position) -
        b.position.distanceTo(bot.entity.position)
      )[0] ?? null
  }

  // ── Dodge System ─────────────────────────────────────────────

  function startDodgeSystem() {
    if (dodgeInterval) clearInterval(dodgeInterval)
    dodgeInterval = setInterval(async () => {
      if (!DODGE_CONFIG.enabled || flags.isDodging) return
      const mob = getNearestHostile(DODGE_CONFIG.detectionRadius)
      if (!mob) return

      const wasExploring    = flags.explorationActive
      const wasWoodcutting  = flags.woodcuttingActive

      if (wasExploring || wasWoodcutting) {
        flags.explorationActive   = false
        flags.woodcuttingActive   = false
        clearPathfinding()
      }

      flags.isDodging = true
      try { await dodgeMob(mob) }
      catch (err) { console.error('[Dodge] Error:', err.message) }
      finally {
        flags.isDodging = false
        if (wasExploring)   flags.explorationActive  = true
        if (wasWoodcutting) flags.woodcuttingActive   = true
      }
    }, DODGE_CONFIG.checkInterval)
  }

  function stopDodgeSystem() {
    if (dodgeInterval) { clearInterval(dodgeInterval); dodgeInterval = null }
    flags.isDodging = false
  }

  async function dodgeMob(mob) {
    const pos    = bot.entity.position
    const mobPos = mob.position
    const dx = pos.x - mobPos.x
    const dz = pos.z - mobPos.z
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    await safeSetGoal(
      new goals.GoalNear(
        pos.x + (dx / len) * DODGE_CONFIG.safeDistance,
        pos.y,
        pos.z + (dz / len) * DODGE_CONFIG.safeDistance,
        2
      ),
      true
    )
    await bot.waitForTicks(20)
  }

  // ── Follow System ────────────────────────────────────────────

  function startFollowing(username) {
    if (followInterval) clearInterval(followInterval)
    flags.followingPlayer = true
    followInterval = setInterval(() => {
      if (!flags.followingPlayer) return
      if (flags.miningActive || flags.huntingActive || pathfindingLock) return
      const target = bot.players[username]?.entity
      if (target && target.position.distanceTo(bot.entity.position) > 3) {
        safeSetGoal(
          new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3),
          true
        )
      }
    }, 1000)
  }


  /**
   * Promise-based follow — resolves when flags.followingPlayer is set false.
   * Used inside a DAG node so 'basta' cleanly stops and completes the task.
   */
  function followUntilStopped(username) {
    return new Promise(resolve => {
      flags.followingPlayer = true
      const interval = setInterval(() => {
        if (!flags.followingPlayer) {
          clearInterval(interval)
          resolve()
          return
        }
        const target = bot.players[username]?.entity
        if (!target) return
        if (target.position.distanceTo(bot.entity.position) > 3) {
          safeSetGoal(
            new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3),
            true
          )
        }
      }, 800)
    })
  }

  function stopFollowing() {
    flags.followingPlayer = false
    if (followInterval) { clearInterval(followInterval); followInterval = null }
    clearPathfinding()
  }

  return {
    sleep,
    safeGoto,
    safeSetGoal,
    clearPathfinding,
    setSprintMode,
    getNearestHostile,
    startDodgeSystem,
    stopDodgeSystem,
    startFollowing,
    stopFollowing,
    followUntilStopped,
    get pathfindingLock() { return pathfindingLock },
  }
}

module.exports = { createMovement, HOSTILE_MOBS, VILLAGE_BLOCKS }