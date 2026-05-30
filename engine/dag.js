/**
 * DAG Task Engine
 * ===============
 * Executes a directed acyclic graph of tasks where each node:
 *  - has zero or more dependencies (edges that must be DONE before it runs)
 *  - runs its async fn() once all deps resolve
 *  - on success, marks itself DONE and triggers downstream nodes
 *  - on failure, marks itself FAILED, retries up to maxRetries, then
 *    propagates FAILED to all dependents
 *
 * Usage:
 *   const dag = new DAGEngine(bot)
 *   dag.run([
 *     { id: 'pickaxe',  deps: [],          fn: () => skills.ensurePickaxe('diamond_ore') },
 *     { id: 'torches',  deps: [],          fn: () => skills.ensureTorches() },
 *     { id: 'descend',  deps: ['pickaxe', 'torches'], fn: () => skills.descend(-58) },
 *     { id: 'mine',     deps: ['descend'], fn: () => skills.mineLayer(-58) },
 *     { id: 'deposit',  deps: ['mine'],    fn: () => skills.depositInChest() },
 *   ])
 */

const { EventEmitter } = require('events')

const STATUS = {
  PENDING:  'pending',
  READY:    'ready',
  RUNNING:  'running',
  DONE:     'done',
  FAILED:   'failed',
  SKIPPED:  'skipped',  // dep failed → skip this node
}

class DAGEngine extends EventEmitter {
  /**
   * @param {object} bot    - mineflayer bot instance
   * @param {object} opts
   * @param {number} opts.maxRetries      default 2
   * @param {number} opts.retryDelay      ms between retries, default 2000
   * @param {number} opts.maxConcurrency  how many nodes may run at once, default 1
   *   Set to >1 only for truly independent tasks (e.g. two bots prepping different things).
   *   Within a single bot, keep at 1 to avoid pathfinder conflicts.
   * @param {function} opts.onStatus      (nodeId, status, detail) callback for UI/logging
   */
  constructor(bot, opts = {}) {
    super()
    this.bot         = bot
    this.maxRetries  = opts.maxRetries     ?? 2
    this.retryDelay  = opts.retryDelay     ?? 2000
    this.maxConcurrency = opts.maxConcurrency ?? 1
    this.onStatus    = opts.onStatus       ?? null

    this._nodes      = new Map()   // id → node
    this._running    = new Set()   // ids currently executing
    this._aborted    = false
    this._resolve    = null        // resolves the run() promise
    this._reject     = null
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Run a list of task definitions.
   * Returns a Promise that resolves when all tasks finish (DONE or FAILED/SKIPPED).
   *
   * @param {Array<{
   *   id:         string,
   *   deps:       string[],
   *   fn:         () => Promise<any>,
   *   maxRetries: number?,     // override engine default
   *   label:      string?,     // human-readable label for messages
   * }>} taskDefs
   * @returns {Promise<Map<string, {status, result, error}>>}
   */
  run(taskDefs) {
    this._aborted = false
    this._nodes.clear()
    this._running.clear()

    // Build node map
    for (const def of taskDefs) {
      this._nodes.set(def.id, {
        id:         def.id,
        label:      def.label ?? def.id,
        deps:       def.deps ?? [],
        fn:         def.fn,
        maxRetries: def.maxRetries ?? this.maxRetries,
        retries:    0,
        status:     STATUS.PENDING,
        result:     undefined,
        error:      undefined,
      })
    }

    // Validate: every dep must exist in the graph
    for (const node of this._nodes.values()) {
      for (const dep of node.deps) {
        if (!this._nodes.has(dep)) {
          throw new Error(`DAG: node "${node.id}" depends on unknown node "${dep}"`)
        }
      }
    }

    return new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject  = reject
      this._tick()
    })
  }

  /**
   * Abort the currently running DAG.
   * Running nodes will finish naturally but no new ones will start.
   */
  abort() {
    this._aborted = true
    this.emit('abort')
  }

  /** Snapshot of current node statuses */
  getStatus() {
    const out = {}
    for (const [id, node] of this._nodes) {
      out[id] = { status: node.status, retries: node.retries, error: node.error?.message }
    }
    return out
  }

  // ── Internal ─────────────────────────────────────────────────

  _tick() {
    if (this._aborted) return this._finish()

    // Check if everything is terminal
    const allDone = [...this._nodes.values()].every(
      n => n.status === STATUS.DONE || n.status === STATUS.FAILED || n.status === STATUS.SKIPPED
    )
    if (allDone) return this._finish()

    // Find READY nodes: pending + all deps are DONE + concurrency slot available
    for (const node of this._nodes.values()) {
      if (node.status !== STATUS.PENDING) continue
      if (this._running.size >= this.maxConcurrency) break

      const depsAllDone = node.deps.every(
        d => this._nodes.get(d)?.status === STATUS.DONE
      )
      const anyDepFailed = node.deps.some(
        d => this._nodes.get(d)?.status === STATUS.FAILED ||
             this._nodes.get(d)?.status === STATUS.SKIPPED
      )

      if (anyDepFailed) {
        this._setStatus(node, STATUS.SKIPPED, `Dependency failed`)
        this._tick()
        return
      }

      if (depsAllDone) {
        this._execute(node)
      }
    }
  }

  async _execute(node) {
    this._setStatus(node, STATUS.RUNNING)
    this._running.add(node.id)

    try {
      node.result = await node.fn()
      this._setStatus(node, STATUS.DONE)
    } catch (err) {
      node.error = err
      console.error(`[DAG] Node "${node.id}" failed (attempt ${node.retries + 1}):`, err.message)

      if (node.retries < node.maxRetries && !this._aborted) {
        node.retries++
        this._setStatus(node, STATUS.PENDING, `Retrying (${node.retries}/${node.maxRetries})`)
        this._running.delete(node.id)
        await new Promise(r => setTimeout(r, this.retryDelay))
        this._tick()
        return
      }

      this._setStatus(node, STATUS.FAILED, err.message)
    } finally {
      this._running.delete(node.id)
    }

    this._tick()
  }

  _setStatus(node, status, detail = '') {
    node.status = status
    const msg = detail ? `[DAG] ${node.label}: ${status} — ${detail}` : `[DAG] ${node.label}: ${status}`
    console.log(msg)
    this.emit('status', node.id, status, detail)
    if (this.onStatus) this.onStatus(node.id, status, detail)
  }

  _finish() {
    const results = new Map()
    for (const [id, node] of this._nodes) {
      results.set(id, { status: node.status, result: node.result, error: node.error })
    }
    const anyFailed = [...results.values()].some(r => r.status === STATUS.FAILED)
    this.emit('finish', results, anyFailed)
    if (this._resolve) this._resolve(results)
  }
}

module.exports = { DAGEngine, STATUS }