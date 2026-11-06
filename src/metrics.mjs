/**
 * 极简 Prometheus 指标：counter / summary / gauge，渲染为 text exposition format。
 * 不引依赖；label 值按规范转义。
 */

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

function renderLabels(labels) {
  const entries = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return ''
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`
}

function seriesKey(labels) {
  return JSON.stringify(Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b)))
}

export class Metrics {
  #counters = new Map()
  #summaries = new Map()
  #gauges = new Map()

  #series(store, name, labels) {
    let rows = store.get(name)
    if (!rows) {
      rows = new Map()
      store.set(name, rows)
    }
    const key = seriesKey(labels)
    let row = rows.get(key)
    if (!row) {
      row = { labels: labels ?? {}, value: 0, sum: 0, count: 0 }
      rows.set(key, row)
    }
    return row
  }

  /** 计数器 +1。 */
  inc(name, labels) {
    this.#series(this.#counters, name, labels).value += 1
  }

  /** 计数器加任意值（token 数等）。 */
  add(name, labels, value) {
    if (!Number.isFinite(value) || value === 0) return
    this.#series(this.#counters, name, labels).value += value
  }

  /** 观测一个毫秒值，渲染为 `_sum` / `_count`。 */
  observeMilliseconds(name, labels, value) {
    const row = this.#series(this.#summaries, name, labels)
    row.sum += value
    row.count += 1
  }

  setGauge(name, labels, value) {
    this.#series(this.#gauges, name, labels).value = value
  }

  render() {
    const lines = []
    const describe = (name, type, help) => {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} ${type}`)
    }

    for (const name of [...this.#counters.keys()].sort()) {
      describe(name, 'counter', `${name} total.`)
      for (const row of this.#counters.get(name).values()) {
        lines.push(`${name}${renderLabels(row.labels)} ${row.value}`)
      }
    }
    for (const name of [...this.#summaries.keys()].sort()) {
      describe(`${name}_milliseconds`, 'summary', `${name} latency in milliseconds.`)
      for (const row of this.#summaries.get(name).values()) {
        lines.push(`${name}_milliseconds_sum${renderLabels(row.labels)} ${row.sum}`)
        lines.push(`${name}_milliseconds_count${renderLabels(row.labels)} ${row.count}`)
      }
    }
    for (const name of [...this.#gauges.keys()].sort()) {
      describe(name, 'gauge', `${name} current value.`)
      for (const row of this.#gauges.get(name).values()) {
        lines.push(`${name}${renderLabels(row.labels)} ${row.value}`)
      }
    }
    return `${lines.join('\n')}\n`
  }
}
