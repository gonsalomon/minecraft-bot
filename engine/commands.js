/**
 * Command Handler  (engine/commands.js)
 * ======================================
 * Switch-style parser → dispatches to DAG or direct skill call.
 * All trade investigation commands included.
 */

const { DAGEngine } = require('./dag')
const tasks = require('./tasks')
const {
  flags, locations, mining,
  saveState, stopAll, clearMiningProgress, loadMiningProgress,
} = require('../core/state')

function createCommandHandler(bot, { movement, inventory, miningSkills, lumberjack, combat, farming, trading, sendMsg, MASTER_USERNAME }) {

  // ── DAG runner ───────────────────────────────────────────────
  let activeDAG = null
  let survival  = null

  function getActiveDAG() { return activeDAG }
  function setSurvival(s) { survival = s }

  function makeDAG() {
    return new DAGEngine(bot, {
      maxRetries: 2, retryDelay: 2000, maxConcurrency: 1,
      onStatus: (id, status, detail) => {
        if (status === 'running') sendMsg(`⚙️ ${id}…`)
        if (status === 'done')    sendMsg(`✅ ${id}`)
        if (status === 'failed')  sendMsg(`❌ ${id}: ${detail}`)
        if (status === 'skipped') sendMsg(`⏭️ ${id} (dep falló)`)
      },
    })
  }

  async function runDAG(defs, label, taskType = 'general') {
    // Dependency check — report ALL missing things before doing anything
    const depIssues = checkDeps(taskType)
    if (depIssues.length) {
      sendMsg(`🚫 No puedo iniciar "${label}" — me falta:`)
      for (const issue of depIssues) sendMsg(`  • ${issue}`)
      return
    }
    // Survival preflight check
    if (survival) {
      const check = survival.preflightCheck(taskType)
      if (!check.ok) {
        sendMsg(`🚫 No puedo iniciar "${label}": ${check.reason}`)
        return
      }
    }
    if (activeDAG) { activeDAG.abort(); activeDAG = null }
    stopAll()
    movement.clearPathfinding()
    activeDAG = makeDAG()
    flags.dagRunning = true
    flags.lastCommand = label
    sendMsg(`🔁 ${label}`)
    try {
      const res = await activeDAG.run(defs)
      const failed = [...res.values()].some(r => r.status === 'failed')
      sendMsg(failed ? `⚠️ ${label}: errores` : `🎉 ${label}: listo`)
      return res
    } catch (err) {
      sendMsg(`❌ ${label}: ${err.message}`)
    } finally {
      flags.dagRunning = false
      activeDAG = null
    }
  }


  // ── Dependency checker ────────────────────────────────────────
  // Runs before every runDAG. Returns all missing things at once.
  function checkDeps(taskType) {
    const issues = []
    const inv = bot.inventory.items()

    const count = name => inv.filter(i => i.name === name).reduce((s,i) => s+i.count, 0)
    const has   = name => inv.some(i => i.name === name)
    const hasAny = (...names) => names.some(n => inv.some(i => i.name.includes(n)))

    const hasPickaxe = hasAny('pickaxe')
    const hasAxe     = hasAny('axe')
    const hasWeapon  = hasAny('sword', 'axe')
    const hasArmor   = [5,6,7,8].filter(s => bot.inventory.slots[s] != null).length >= 2
    const hasTorches = count('torch') >= 8
    const hasCoal    = has('coal') || has('charcoal')
    const hasCobble  = count('cobblestone') >= 3
    const hasSticks  = count('stick') >= 2
    const hasFood    = inv.some(i => [
      'cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken',
      'cooked_salmon','cooked_cod','bread','golden_carrot','baked_potato',
      'carrot','apple','melon_slice'
    ].includes(i.name))
    const canCraftPick = hasCobble && hasSticks

    switch (taskType) {

      case 'mining': {
        if (!locations.mine)
          issues.push('⛏️ No sé dónde está la mina → dime con: mina X Y Z')
        if (!locations.chest)
          issues.push('📦 No tengo dónde depositar → registra un cofre: cofre X Y Z')
        if (!hasTorches) {
          if (!hasCoal && !locations.chest)
            issues.push('🕯️ No tengo antorchas ni carbón → registra un cofre con materiales: cofre X Y Z')
          else if (!hasCoal)
            issues.push('🕯️ No tengo carbón para antorchas → pon carbón en el cofre o en mi inventario')
          if (locations.craftingTable == null)
            issues.push('🔨 Necesito una mesa para craftear antorchas → registra una: mesa X Y Z')
        }
        if (!hasPickaxe) {
          if (!canCraftPick && !locations.chest)
            issues.push('⛏️ No tengo pico ni materiales → pon un pico en el cofre o registra uno: cofre X Y Z')
          else if (!canCraftPick)
            issues.push('⛏️ No tengo pico ni cobblestone + palos → pon materiales en el cofre')
          if (!locations.craftingTable)
            issues.push('🔨 Necesito una mesa para craftear el pico → registra una: mesa X Y Z')
        }
        if (bot.food < 18 && !hasFood) {
          if (!locations.chest)
            issues.push('🍗 Tengo hambre y no tengo comida → registra un cofre con comida: cofre X Y Z')
          else
            issues.push('🍗 Tengo hambre → pon comida en el cofre')
        }
        break
      }

      case 'lumberjack': {
        if (!locations.chest)
          issues.push('📦 No sé dónde depositar la madera → registra un cofre: cofre X Y Z')
        if (!hasAxe) {
          if (!hasCobble || !hasSticks)
            issues.push('🪓 No tengo hacha ni materiales → pon una hacha en el inventario o cofre')
          else if (!locations.craftingTable)
            issues.push('🔨 Tengo materiales para el hacha pero necesito una mesa → registra una: mesa X Y Z')
        }
        break
      }

      case 'farming': {
        if (!locations.farm)
          issues.push('🌾 No sé dónde está la granja → dime con: granja X Y Z')
        if (!locations.chest)
          issues.push('📦 No tengo dónde depositar la cosecha → registra un cofre: cofre X Y Z')
        break
      }

      case 'farming_bread': {
        if (!locations.farm)
          issues.push('🌾 No sé dónde está la granja → dime con: granja X Y Z')
        if (!locations.craftingTable)
          issues.push('🔨 Necesito una mesa para hacer pan → registra una: mesa X Y Z')
        if (!locations.chest)
          issues.push('📦 No tengo dónde depositar → registra un cofre: cofre X Y Z')
        break
      }

      case 'combat': {
        if (!hasWeapon)
          issues.push('⚔️ No tengo arma → pon una espada o hacha en el inventario o cofre')
        if (!hasArmor)
          issues.push('🛡️ No tengo armadura suficiente → pon al menos peto + casco en inventario o cofre')
        if (bot.food < 18 && !hasFood) {
          if (!locations.chest)
            issues.push('🍗 Tengo hambre y no tengo comida → registra un cofre con comida: cofre X Y Z')
          else
            issues.push('🍗 Tengo hambre → pon comida en el cofre')
        }
        if (!locations.chest)
          issues.push('📦 No tengo dónde depositar el botín → registra un cofre: cofre X Y Z')
        break
      }

      case 'sleep': {
        if (!locations.bed && !locations.villageBed)
          issues.push('🛏️ No sé dónde está la cama → dime con: cama X Y Z')
        break
      }

      case 'trading': {
        if (!locations.village && !locations.chest)
          issues.push('🏘️ No conozco ninguna aldea → usa: busca aldea')
        break
      }
    }

    return issues
  }

  // ── Confirmation (for interactive mining) ────────────────────
  let pendingConfirm = null

  function askConfirm(question) {
    return new Promise(resolve => {
      pendingConfirm = { resolve }
      sendMsg(`❓ ${question} (si / no)`)
      setTimeout(() => {
        if (pendingConfirm?.resolve === resolve) {
          pendingConfirm = null
          sendMsg('⏰ Sin respuesta → no')
          resolve(false)
        }
      }, 30000)
    })
  }

  // ── Main handler ─────────────────────────────────────────────
  async function handleCommand(rawMessage) {
    const raw   = rawMessage.trim()
    const lower = raw.toLowerCase()
    const parts = raw.split(/\s+/)
    const cmd   = parts[0].toLowerCase()

    // Confirmations
    if (pendingConfirm) {
      if (cmd === 'si' || cmd === 'confirmar') { pendingConfirm.resolve(true);  pendingConfirm = null; return }
      if (cmd === 'no' || cmd === 'cancelar')  { pendingConfirm.resolve(false); pendingConfirm = null; return }
    }

    switch (true) {

      // ── STOP ──────────────────────────────────────────────────
      case lower === 'basta' || lower === 'stop' || lower === 'parar': {
        if (activeDAG) activeDAG.abort()
        if (flags.miningActive) clearMiningProgress()
        stopAll()
        movement.clearPathfinding()
        sendMsg('🛑 Detenido.')
        break
      }

      // ── STATUS ───────────────────────────────────────────────
      case lower === 'salud':
        sendMsg(`❤️ ${Math.round(bot.health)}/20  🍗 ${Math.round(bot.food)}/20`)
        break

      case lower === 'pos' || lower === 'dondetas': {
        const p = bot.entity.position
        sendMsg(`📍 X:${Math.floor(p.x)} Y:${Math.floor(p.y)} Z:${Math.floor(p.z)}`)
        break
      }

      case lower === 'data': {
        const f = l => l ? `${l.x} ${l.y} ${l.z}` : 'no'
        sendMsg(`📦 Cofre:${f(locations.chest)} | 📐 Mesa:${f(locations.craftingTable)} | ⛏️ Mina:${f(locations.mine)} | 🌾 Granja:${f(locations.farm)} | 🛏️ Cama:${f(locations.bed)}`)
        break
      }

      case lower === 'supervivencia' || lower === 'estado': {
        if (!survival) { sendMsg('❌ Módulo de supervivencia no activo'); break }
        const s = survival.getStatus()
        sendMsg(`🧬 Amenaza: ${s.label} | ❤️ ${Math.round(bot.health)}/20 | 🍗 ${Math.round(bot.food)}/20 | Modo supervivencia: ${s.inSurvivalMode ? 'SÍ' : 'no'}`)
        break
      }

      case lower === 'debug':
        sendMsg(`dag:${flags.dagRunning} mine:${flags.miningActive} hunt:${flags.huntingActive} follow:${flags.followingPlayer} explore:${flags.explorationActive}`)
        break

      case lower === 'inv' || lower === 'inventario': {
        const items = bot.inventory.items().map(i => `${i.name}:${i.count}`).join(' | ')
        sendMsg(items || '📭 Vacío')
        break
      }

      // ── LOCATIONS ────────────────────────────────────────────
      case cmd === 'cofre' && parts.length === 4: {
        const [x,y,z] = parts.slice(1).map(Number)
        if ([x,y,z].some(isNaN)) { sendMsg('❌ Coords inválidas'); break }
        locations.chest = { x, y, z }; saveState()
        sendMsg(`✅ Cofre: ${x} ${y} ${z}`)
        break
      }
      case cmd === 'mesa' && parts.length === 4: {
        const [x,y,z] = parts.slice(1).map(Number)
        if ([x,y,z].some(isNaN)) { sendMsg('❌ Coords inválidas'); break }
        locations.craftingTable = { x, y, z }; saveState()
        sendMsg(`✅ Mesa: ${x} ${y} ${z}`)
        break
      }
      case cmd === 'mina' && parts.length === 4: {
        const [x,y,z] = parts.slice(1).map(Number)
        if ([x,y,z].some(isNaN)) { sendMsg('❌ Coords inválidas'); break }
        locations.mine = { x, y, z }; saveState()
        sendMsg(`✅ Mina: ${x} ${y} ${z}`)
        break
      }
      case cmd === 'granja' && parts.length === 4: {
        const [x,y,z] = parts.slice(1).map(Number)
        if ([x,y,z].some(isNaN)) { sendMsg('❌ Coords inválidas'); break }
        locations.farm = { x, y, z }; saveState()
        sendMsg(`✅ Granja: ${x} ${y} ${z}`)
        break
      }
      case cmd === 'cama' && parts.length === 4: {
        const [x,y,z] = parts.slice(1).map(Number)
        if ([x,y,z].some(isNaN)) { sendMsg('❌ Coords inválidas'); break }
        locations.bed = { x, y, z }; saveState()
        sendMsg(`✅ Cama: ${x} ${y} ${z}`)
        break
      }

      // ── MOVEMENT ─────────────────────────────────────────────
      case cmd === 'ir' && parts[1] === 'a' && parts.length === 5: {
        const [x,y,z] = parts.slice(2).map(Number)
        if ([x,y,z].some(isNaN)) { sendMsg('❌ Coords inválidas'); break }
        stopAll(); movement.clearPathfinding()
        movement.safeGoto(x, y, z, 2).then(() => sendMsg(`✅ Llegué a ${x} ${y} ${z}`))
        sendMsg(`🚶 Yendo a ${x} ${y} ${z}…`)
        break
      }
      case lower === 'seguime' || lower === 'sigue':
        movement.startFollowing(MASTER_USERNAME)
        sendMsg('🏃 Siguiéndote…')
        break

      case lower === 'quieto' || lower === 'espera':
        movement.stopFollowing()
        sendMsg('🚫 Quieto.')
        break

      // ── MINING ───────────────────────────────────────────────
      // "minar <bloque>" → chunk-forward loop
      case cmd === 'minar' && parts.length === 2 && parts[1] !== 'chunk' && parts[1] !== 'capa': {
        const block = parts[1]
        runDAG([{
          id: 'mine', label: `Minar ${block}`, deps: [],
          fn: () => miningSkills.mineChunkForwardLoop(block),
        }], `minar ${block}`, 'mining')
        break
      }
      // "minar chunk completo"
      case lower === 'minar chunk completo':
        runDAG([{ id: 'mc', label: 'Chunk completo', deps: [], fn: () => miningSkills.mineChunkDescending(false) }], 'chunk completo', 'mining')
        break

      // "minar chunk" (con confirmación por segmento)
      case lower === 'minar chunk':
        runDAG([{ id: 'mc', label: 'Chunk segmentado', deps: [], fn: () => miningSkills.mineChunkDescending(true, askConfirm) }], 'chunk segmentado', 'mining')
        break

      // "minar capa <Y>"
      case cmd === 'minar' && parts[1] === 'capa' && parts.length === 3: {
        const y = parseInt(parts[2])
        if (isNaN(y)) { sendMsg('❌ Y inválida'); break }
        runDAG([{
          id: 'ml', label: `Capa Y=${y}`, deps: [],
          fn: async () => {
            const cx = Math.floor(bot.entity.position.x / 16)
            const cz = Math.floor(bot.entity.position.z / 16)
            flags.miningActive = true
            await miningSkills.mineTwoLayers(cx, cz, y - 1)
            flags.miningActive = false
          },
        }], `capa ${y}`, 'mining')
        break
      }

      // "espiral <Y>"
      case cmd === 'espiral' && parts.length === 2: {
        const y = parseInt(parts[1])
        if (isNaN(y)) { sendMsg('❌ Y inválida'); break }
        runDAG([{ id: 'spiral', label: `Espiral Y=${y}`, deps: [], fn: () => miningSkills.spiralMining(y, askConfirm) }], `espiral ${y}`, 'mining')
        break
      }

      // "linea <Y> x+|x-|z+|z-"
      case cmd === 'linea' && parts.length === 3: {
        const y   = parseInt(parts[1])
        const dir = parts[2]
        if (isNaN(y) || !['x+','x-','z+','z-'].includes(dir)) { sendMsg('❌ Uso: linea <Y> x+|x-|z+|z-'); break }
        runDAG([{ id: 'line', label: `Línea ${dir} Y=${y}`, deps: [], fn: () => miningSkills.lineMining(y, dir, askConfirm) }], `línea ${dir}`, 'mining')
        break
      }

      case lower === 'retomar':
        if (!loadMiningProgress()) { sendMsg('❌ Sin progreso guardado'); break }
        runDAG([{ id: 'retomar', label: 'Retomar minería', deps: [], fn: () => miningSkills.mineChunkForwardLoop(mining.target) }], 'retomar', 'mining')
        break

      // ── LUMBERJACK ───────────────────────────────────────────
      case lower === 'explora' || lower === 'madera' || cmd === 'madera': {
        const n = parseInt(parts[1]) || 64
        runDAG([
          { id: 'axe',  label: 'Asegurar hacha', deps: [],      fn: () => lumberjack.ensureAxe() },
          { id: 'cut',  label: `Cortar ${n} madera`, deps: ['axe'], fn: () => lumberjack.exploreCutUntil(n) },
          { id: 'dep',  label: 'Depositar',       deps: ['cut'], fn: () => inventory.depositInChest() },
        ], `madera ×${n}`, 'lumberjack')
        break
      }

      // ── FARMING ──────────────────────────────────────────────
      case lower === 'cosecha':
        runDAG([{ id: 'harvest', label: 'Cosechar', deps: [], fn: () => farming.harvestWheat() }], 'cosecha', 'farming')
        break

      case lower === 'cocina':
        runDAG([{ id: 'bread', label: 'Hacer pan', deps: [], fn: () => farming.makeBread() }], 'pan', 'farming_bread')
        break

      case lower === 'cosecha y cocina':
        runDAG([
          { id: 'harvest', label: 'Cosechar',  deps: [],          fn: () => farming.harvestWheat() },
          { id: 'bread',   label: 'Pan',       deps: ['harvest'], fn: () => farming.makeBread() },
          { id: 'dep',     label: 'Depositar', deps: ['bread'],   fn: () => inventory.depositInChest() },
        ], 'cosecha y cocina', 'farming_bread')
        break

      // ── COMBAT ───────────────────────────────────────────────
      case lower === 'caza':
        runDAG([
          { id: 'eat',    label: 'Comer',    deps: [],                        fn: () => inventory.eatFood() },
          { id: 'weapon', label: 'Armar',    deps: [],                        fn: () => inventory.equipBestWeapon() },
          { id: 'armor',  label: 'Armadurar',deps: [],                        fn: () => inventory.equipBestArmor() },
          { id: 'shield', label: 'Escudo',   deps: ['weapon'],                fn: () => inventory.equipShield() },
          { id: 'hunt',   label: 'Cazar',    deps: ['eat','weapon','armor','shield'], fn: () => combat.huntLoop() },
          { id: 'loot',   label: 'Botín',    deps: ['hunt'],                  fn: () => inventory.pickupNearbyItems() },
          { id: 'dep',    label: 'Depositar',deps: ['loot'],                  fn: () => inventory.depositInChest() },
        ], 'caza', 'combat')
        break

      // ── TRADING / VILLAGES ───────────────────────────────────

      // "busca aldea" → scan nearby blocks for village
      case lower === 'busca aldea':
        runDAG([{ id: 'find_village', label: 'Buscar aldea', deps: [], fn: () => trading.findVillage() }], 'buscar aldea')
        break

      // "averiguar" → go to each villager, open trade window, record
      case lower === 'averiguar':
        runDAG([
          { id: 'investigate', label: 'Investigar aldeanos', deps: [], fn: () => trading.investigateAllVillagers() },
        ], 'averiguar aldeanos', 'trading')
        break

      // "ofertas" → read single nearest villager's trades
      case lower === 'ofertas' || (cmd === 'ofertas' && parts.length >= 1): {
        const profession = parts[1] || null
        runDAG([{
          id: 'read_trades', label: 'Leer ofertas', deps: [],
          fn: () => trading.readVillagerTrades(profession),
        }], 'ofertas')
        break
      }

      // "trades" → print recorded trades from state
      case lower === 'trades' || (cmd === 'trades' && parts.length >= 1): {
        const { villagerTrades } = require('../core/state')
        const uuids = Object.keys(villagerTrades)
        if (!uuids.length) { sendMsg('❌ Sin aldeanos registrados. Usa "averiguar" primero.'); break }

        if (parts.length === 1) {
          sendMsg(`📜 ${uuids.length} aldeano(s) registrado(s):`)
          uuids.forEach((uuid, i) => {
            const count = villagerTrades[uuid]?.length ?? 0
            sendMsg(`  ${i+1}. ${uuid.slice(-8)} → ${count} ofertas`)
          })
          sendMsg('Usa "trades <número>" para detalles.')
        } else {
          const num = parseInt(parts[1]) - 1
          if (isNaN(num) || num < 0 || num >= uuids.length) { sendMsg('❌ Número inválido'); break }
          const trades = villagerTrades[uuids[num]]
          sendMsg(`📜 Aldeano ${num+1} — ${trades.length} ofertas:`)
          for (let i = 0; i < trades.length; i++) {
            const t = trades[i]
            const in1 = t.inputItem1 ? `${t.inputItem1.count}x${t.inputItem1.name}` : '?'
            const in2 = t.inputItem2 ? `+${t.inputItem2.count}x${t.inputItem2.name}` : ''
            const out = t.outputItem ? `${t.outputItem.count}x${t.outputItem.name}` : '?'
            sendMsg(`  ${i+1}. ${in1}${in2} → ${out} (${t.uses}/${t.maxUses})`)
            if ((i+1) % 5 === 0) await new Promise(r => setTimeout(r, 800)) // rate limit chat
          }
        }
        break
      }

      // ── ENTIDADES ────────────────────────────────────────────
      case lower === 'entidades': {
        const counts = {}
        Object.values(bot.entities)
          .filter(e => e.position.distanceTo(bot.entity.position) < 32)
          .forEach(e => { counts[e.name] = (counts[e.name]||0)+1 })
        const summary = Object.entries(counts).map(([n,c]) => `${c}×${n}`).join(', ')
        sendMsg(`📋 ${summary || 'ninguna'}`)
        break
      }

      // ── UTILITY ──────────────────────────────────────────────
      case lower === 'come':
        await inventory.eatFood()
        sendMsg('🍽️ Comí')
        break

      case lower === 'vestite':
        await inventory.equipBestArmor()
        sendMsg('🛡️ Armadura equipada')
        break

      case lower === 'deposita':
        await inventory.depositInChest()
        sendMsg('📦 Depositado')
        break

      case lower === 'dormi':
        runDAG([{ id: 'sleep', label: 'Dormir', deps: [], fn: () => trading.sleepInBed() }], 'dormir', 'sleep')
        break

      case cmd === 'agarra' && parts.length >= 2: {
        if (!locations.chest) { sendMsg('❌ No hay cofre'); break }
        const item = parts.slice(1).join(' ')
        const got = await inventory.getItemFromChest(item, 1)
        sendMsg(got ? `✅ Saqué ${item}` : `❌ No encontré ${item}`)
        break
      }

      case lower === 'dropea todo':
        if (locations.chest) await inventory.depositInChest({ force: true })
        else for (const i of bot.inventory.items()) await bot.toss(i.type, null, i.count)
        sendMsg('🗑️ Inventario vaciado')
        break

      // ── DODGE TOGGLE ─────────────────────────────────────────
      case lower === 'esquiva':
        movement.startDodgeSystem()
        sendMsg('✅ Evasión activada')
        break
      case lower === 'no esquives':
        movement.stopDodgeSystem()
        sendMsg('⚠️ Evasión desactivada')
        break

      // ── HELP ─────────────────────────────────────────────────
      case lower === 'aiuda' || lower === 'help':
        sendMsg('📋 salud | pos | data | debug | inv')
        sendMsg('🏠 cofre/mesa/mina/granja/cama x y z')
        sendMsg('🚶 ir a x y z | seguime | quieto | basta')
        sendMsg('⛏️ minar <bloque> | minar chunk [completo] | minar capa <Y>')
        sendMsg('🌀 espiral <Y> | linea <Y> x+|x-|z+|z- | retomar')
        sendMsg('🌲 explora [n] | madera [n]')
        sendMsg('🌾 cosecha | cocina | cosecha y cocina')
        sendMsg('⚔️ caza | vestite | come | deposita | dormi')
        sendMsg('🏘️ busca aldea | averiguar | ofertas [profesion] | trades [n] | entidades')
        break


      // ── FIND & FOLLOW PLAYER (DAG) ───────────────────────────
      // "encuentra"  → locate player, go to them, follow until "basta"
      case lower === 'encuentra' || lower === 'ven' || lower === 've al jugador': {
        runDAG([
          {
            id: 'find_player',
            label: 'Localizar jugador',
            deps: [],
            fn: async () => {
              const player = bot.players[MASTER_USERNAME]?.entity
              if (!player) throw new Error(`${MASTER_USERNAME} no está en el servidor`)
              const p = player.position
              sendMsg(`📍 ${MASTER_USERNAME} en ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
            },
          },
          {
            id: 'goto_player',
            label: 'Ir al jugador',
            deps: ['find_player'],
            fn: async () => {
              const player = bot.players[MASTER_USERNAME]?.entity
              if (!player) throw new Error('Jugador desapareció')
              await movement.safeGoto(player.position.x, player.position.y, player.position.z, 3)
            },
          },
          {
            id: 'follow_loop',
            label: 'Seguir jugador (basta para parar)',
            deps: ['goto_player'],
            fn: () => movement.followUntilStopped(MASTER_USERNAME),
          },
        ], 'seguir jugador', 'follow')
        break
      }

      default:
        sendMsg(`❓ "${raw}" desconocido. Usa "aiuda".`)
    }
  }

  return { handleCommand, getActiveDAG, setSurvival }
}

module.exports = { createCommandHandler }