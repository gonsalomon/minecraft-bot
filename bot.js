require('dotenv').config()
const mineflayer    = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

const state = require('./core/state')
const { flags, saveState, loadState, loadMiningProgress } = state

const { createMovement }           = require('./core/movement')
const { createInventory }          = require('./core/inventory')
const { createMining }             = require('./skills/mining')
const { createLumberjack }         = require('./skills/lumberjack')
const { createCombat }             = require('./skills/combat')
const { createFarming, createTrading } = require('./skills/farming_trading')
const { createCommandHandler }     = require('./engine/commands')
const { createSurvival }          = require('./core/survival')

const BOT_USERNAME    = process.env.BOT_USERNAME    || 'Carlos'
const SERVER_HOST     = process.env.SERVER_HOST     || 'localhost'
const SERVER_PORT     = parseInt(process.env.SERVER_PORT || '25565')
const MASTER_USERNAME = process.env.MASTER_USERNAME || 'gonsalomon'

// ── Reconnect loop ────────────────────────────────────────────
let reconnectDelay = 5000
let shuttingDown   = false

function createAndConnectBot() {
  if (shuttingDown) return

  console.log(`[Bot] Connecting to ${SERVER_HOST}:${SERVER_PORT} as "${BOT_USERNAME}"`)

  const bot = mineflayer.createBot({
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_USERNAME,
    version: '1.21.11',
    hideErrors: false,
  })
  bot.loadPlugin(pathfinder)

  function sendMsg(msg) {
    try {
      if (bot.players?.[MASTER_USERNAME]) bot.chat(`/tell ${MASTER_USERNAME} ${msg}`)
      else console.log(`[Bot→${MASTER_USERNAME}] ${msg}`)
    } catch {}
  }

  // ── Spawn ────────────────────────────────────────────────────
  bot.once('spawn', () => {
    console.log(`[Bot] Spawned as ${bot.username}`)
    reconnectDelay = 5000  // reset backoff on successful connect

    loadState()
    loadMiningProgress()

    const movement     = createMovement(bot)
    const inventory    = createInventory(bot, movement)
    const miningSkills = createMining(bot, movement, inventory)
    const lumberjack   = createLumberjack(bot, movement, inventory)
    const combat       = createCombat(bot, movement, inventory)
    const farming      = createFarming(bot, movement, inventory)
    const trading      = createTrading(bot, movement, state)

    const commandHandler = createCommandHandler(bot, {
      movement, inventory, miningSkills,
      lumberjack, combat, farming, trading,
      sendMsg, MASTER_USERNAME,
    })

    // Survival needs a reference to the active DAG in commands
    const survival = createSurvival(bot, movement, inventory, () => commandHandler.getActiveDAG(), sendMsg)
    commandHandler.setSurvival(survival)
    survival.start()

    movement.startDodgeSystem()
    sendMsg(`✅ ${BOT_USERNAME} listo. Usa "aiuda".`)

    // Auto-resume mining if interrupted mid-task
    if (state.mining.active && state.mining.target) {
      console.log(`[Bot] Resuming mining: ${state.mining.target}`)
      setTimeout(() => {
        sendMsg(`▶️ Retomando minería de ${state.mining.target}…`)
        commandHandler.handleCommand('retomar').catch(() => {})
      }, 3000)
    }

    bot.on('health', () => {
      if (bot.food <= 14 && !flags.isEating) inventory.eatFood().catch(() => {})
    })

    // Chat + whisper → same handler
    function onMessage(username, message) {
      if (username === bot.username) return
      if (username !== MASTER_USERNAME) return
      console.log(`[${username}] ${message}`)
      commandHandler.handleCommand(message).catch(err =>
        console.error('[Command]', err.message)
      )
    }
    bot.on('chat',    onMessage)
    bot.on('whisper', onMessage)
  })

  // ── Errors — swallow non-fatal ones ──────────────────────────
  bot.on('error', err => {
    const msg = err.message ?? ''
    if (
      msg.includes('GoalChanged') ||
      msg.includes('No path found') ||
      msg.includes('PathStopped') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT')
    ) return
    console.error('[Bot] Error:', msg)
  })

  // ── Disconnect → reconnect ────────────────────────────────────
  bot.on('end', reason => {
    if (shuttingDown) return
    saveState()
    console.log(`[Bot] Disconnected (${reason}). Reconnecting in ${reconnectDelay/1000}s…`)
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60000)  // exponential backoff, max 60s
      createAndConnectBot()
    }, reconnectDelay)
  })

  bot.on('kicked', reason => {
    console.log(`[Bot] Kicked: ${reason}`)
  })

  setInterval(() => saveState(), 30000)
}

// ── Process signals ───────────────────────────────────────────
process.on('SIGINT', () => {
  shuttingDown = true
  saveState()
  console.log('\n[Bot] Shutting down.')
  process.exit(0)
})

process.on('uncaughtException', err => {
  const msg = err.message ?? ''
  if (msg.includes('GoalChanged') || msg.includes('No path found')) return
  console.error('[Uncaught]', msg)
})

process.on('unhandledRejection', reason => {
  const msg = reason?.message ?? String(reason)
  if (msg.includes('GoalChanged') || msg.includes('No path found') || msg.includes('PathStopped')) return
  console.error('[UnhandledRejection]', msg)
})

createAndConnectBot()