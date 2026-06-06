#!/usr/bin/env node
// CDP-driven CPU profile capture against `wrangler dev --inspect`.
//
// Usage:
//   node profile.mjs <runner> <target>
// Example:
//   node profile.mjs userspace-direct local-upload-5mb
//
// Outputs a v8 .cpuprofile file (loadable in Chrome DevTools' Performance tab,
// or https://www.speedscope.app/) plus a text summary of the heaviest functions.

import CDP from 'chrome-remote-interface'
import { writeFileSync } from 'node:fs'

const [, , runner, target] = process.argv
if (!runner || !target) {
  console.error('usage: node profile.mjs <runner> <target>')
  process.exit(2)
}

const ITERS = parseInt(process.env.ITERS ?? '5', 10)
const WORKER_URL = process.env.WORKER_URL ?? 'http://127.0.0.1:8810'

// Connect to the inspector directly via the known ws path
const wsUrl = `ws://127.0.0.1:9229/ws`
const client = await CDP({ target: wsUrl, local: true })
const { Profiler, Runtime } = client

await Runtime.enable()
await Profiler.enable()
// 1µs = 1 sample per microsecond. workerd default is 1ms which is too coarse
// for sub-50ms requests; use 100µs to get reasonable resolution.
await Profiler.setSamplingInterval({ interval: 100 })
await Profiler.start()

console.error(`profiler started, hitting ${runner}/${target} ${ITERS}× ...`)

const fetchHttp = async (path) => {
  const r = await fetch(`${WORKER_URL}${path}`)
  return await r.text()
}

// warmup once (handshake/wasm-init isn't representative)
await fetchHttp(`/bench/${runner}/${target}`)
const start = performance.now()
for (let i = 0; i < ITERS; i++) {
  await fetchHttp(`/bench/${runner}/${target}`)
}
const wallSeconds = (performance.now() - start) / 1000
console.error(`${ITERS} requests in ${wallSeconds.toFixed(2)}s`)

const { profile } = await Profiler.stop()
await client.close()

const outPath = `profile-${runner}-${target}.cpuprofile`
writeFileSync(outPath, JSON.stringify(profile))
console.error(`wrote ${outPath}`)

// Summary: aggregate self time per function name
const nodes = profile.nodes
const samples = profile.samples
const tdeltas = profile.timeDeltas
const selfTimeByFn = new Map()
const callCountByFn = new Map()

for (let i = 0; i < samples.length; i++) {
  const node = nodes.find((n) => n.id === samples[i])
  if (!node) continue
  const name = formatFn(node)
  selfTimeByFn.set(name, (selfTimeByFn.get(name) ?? 0) + tdeltas[i])
  callCountByFn.set(name, (callCountByFn.get(name) ?? 0) + 1)
}

function formatFn(node) {
  const f = node.callFrame
  let url = f.url ?? '?'
  // Trim long URLs to last segments
  url = url.replace(/^.*node_modules\//, '…/').replace(/^.*src\//, 'src/')
  return `${f.functionName || '<anon>'} (${url}:${f.lineNumber})`
}

// Sort by self time, output top 30
const sorted = [...selfTimeByFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
const totalUs = [...selfTimeByFn.values()].reduce((a, b) => a + b, 0)
console.log(`\nTotal sampled CPU: ${(totalUs / 1000).toFixed(1)} ms across ${samples.length} samples`)
console.log(`Top 30 functions by self time:`)
console.log(`${'self ms'.padStart(8)}  ${'pct'.padStart(5)}  fn`)
for (const [name, us] of sorted) {
  console.log(`${(us / 1000).toFixed(2).padStart(8)}  ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${name}`)
}
