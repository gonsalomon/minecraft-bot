/**
 * Task Library
 * ============
 * Pre-built DAG graphs for common high-level goals.
 * Each exported function returns an array of task definitions
 * ready to be passed to DAGEngine.run().
 *
 * Skills are passed in so the task library has no direct bot dependency.
 */

/**
 * Mine a specific block type (e.g. 'diamond_ore').
 * Ensures pickaxe, torches, descends to optimal Y, mines a chunk layer, ascends, deposits.
 */
function mineBlock(skills, blockName) {
  return [
    {
      id: 'ensure_pickaxe',
      label: `Asegurar pico para ${blockName}`,
      deps: [],
      fn: () => skills.ensurePickaxe(blockName),
    },
    {
      id: 'ensure_torches',
      label: 'Asegurar antorchas',
      deps: [],
      fn: () => skills.ensureTorches(),
    },
    {
      id: 'goto_mine',
      label: 'Ir a la mina',
      deps: ['ensure_pickaxe'],
      fn: () => skills.goToMineLocation(),
    },
    {
      id: 'descend',
      label: 'Bajar a capa óptima',
      deps: ['goto_mine'],
      fn: () => skills.descendToOptimalY(blockName),
    },
    {
      id: 'mine_layer',
      label: `Minar capa de ${blockName}`,
      deps: ['descend'],
      fn: () => skills.mineChunkLayer(blockName),
    },
    {
      id: 'ascend',
      label: 'Subir a la superficie',
      deps: ['mine_layer'],
      fn: () => skills.ascendToSurface(),
    },
    {
      id: 'deposit',
      label: 'Depositar en cofre',
      deps: ['ascend'],
      fn: () => skills.depositInChest(),
    },
  ]
}

/**
 * Get wood: find trees, cut them, deposit logs.
 */
function getWood(skills, targetCount = 64) {
  return [
    {
      id: 'ensure_axe',
      label: 'Asegurar hacha',
      deps: [],
      fn: () => skills.ensureAxe(),
    },
    {
      id: 'find_and_cut',
      label: `Talar hasta ${targetCount} madera`,
      deps: ['ensure_axe'],
      fn: () => skills.exploreCutUntil(targetCount),
    },
    {
      id: 'deposit',
      label: 'Depositar madera',
      deps: ['find_and_cut'],
      fn: () => skills.depositInChest(),
    },
  ]
}

/**
 * Full farming cycle: harvest, make bread, deposit.
 */
function farmCycle(skills) {
  return [
    {
      id: 'harvest',
      label: 'Cosechar trigo',
      deps: [],
      fn: () => skills.harvestWheat(),
    },
    {
      id: 'make_bread',
      label: 'Hacer pan',
      deps: ['harvest'],
      fn: () => skills.makeBread(),
    },
    {
      id: 'deposit',
      label: 'Depositar cosecha',
      deps: ['make_bread'],
      fn: () => skills.depositInChest(),
    },
  ]
}

/**
 * Prepare for combat: arm, armor, eat, then hunt.
 */
function hunt(skills) {
  return [
    {
      id: 'eat',
      label: 'Comer antes de pelear',
      deps: [],
      fn: () => skills.eatFood(),
    },
    {
      id: 'equip_weapon',
      label: 'Equipar mejor arma',
      deps: [],
      fn: () => skills.equipBestWeapon(),
    },
    {
      id: 'equip_armor',
      label: 'Equipar mejor armadura',
      deps: [],
      fn: () => skills.equipBestArmor(),
    },
    {
      id: 'equip_shield',
      label: 'Equipar escudo',
      deps: ['equip_weapon'],
      fn: () => skills.equipShield(),
    },
    {
      id: 'hunt_loop',
      label: 'Cazar mobs hostiles',
      deps: ['eat', 'equip_weapon', 'equip_armor', 'equip_shield'],
      fn: () => skills.huntLoop(),
    },
    {
      id: 'collect_loot',
      label: 'Recoger botín',
      deps: ['hunt_loop'],
      fn: () => skills.pickupNearbyItems(),
    },
    {
      id: 'deposit',
      label: 'Depositar botín',
      deps: ['collect_loot'],
      fn: () => skills.depositInChest(),
    },
  ]
}

/**
 * Craft a pickaxe of a given tier.
 * Automatically acquires materials first.
 */
function craftPickaxe(skills, pickaxeType = 'stone_pickaxe') {
  return [
    {
      id: 'get_materials',
      label: `Obtener materiales para ${pickaxeType}`,
      deps: [],
      fn: () => skills.ensurePickaxeMaterials(pickaxeType),
    },
    {
      id: 'get_sticks',
      label: 'Obtener palos',
      deps: [],
      fn: () => skills.ensureSticks(2),
    },
    {
      id: 'craft',
      label: `Craftear ${pickaxeType}`,
      deps: ['get_materials', 'get_sticks'],
      fn: () => skills.craftItem(pickaxeType),
    },
    {
      id: 'equip',
      label: `Equipar ${pickaxeType}`,
      deps: ['craft'],
      fn: () => skills.equipPickaxe(pickaxeType),
    },
  ]
}

/**
 * Find a village, read all villager trades, deposit.
 */
function tradeRecon(skills) {
  return [
    {
      id: 'find_village',
      label: 'Buscar aldea',
      deps: [],
      fn: () => skills.findVillage(),
    },
    {
      id: 'investigate_villagers',
      label: 'Investigar aldeanos',
      deps: ['find_village'],
      fn: () => skills.investigateAllVillagers(),
    },
  ]
}

/**
 * Sleep through the night.
 */
function sleepNight(skills) {
  return [
    {
      id: 'goto_bed',
      label: 'Ir a dormir',
      deps: [],
      fn: () => skills.sleepInBed(),
    },
  ]
}

/**
 * Full survival loop: eat → armor → deposit → sleep
 */
function survivalPrep(skills) {
  return [
    {
      id: 'eat',
      label: 'Comer',
      deps: [],
      fn: () => skills.eatFood(),
    },
    {
      id: 'equip_armor',
      label: 'Equipar armadura',
      deps: [],
      fn: () => skills.equipBestArmor(),
    },
    {
      id: 'deposit',
      label: 'Depositar exceso',
      deps: ['eat', 'equip_armor'],
      fn: () => skills.depositInChest(),
    },
    {
      id: 'sleep',
      label: 'Dormir',
      deps: ['deposit'],
      fn: () => skills.sleepInBed(),
    },
  ]
}

module.exports = {
  mineBlock,
  getWood,
  farmCycle,
  hunt,
  craftPickaxe,
  tradeRecon,
  sleepNight,
  survivalPrep,
}