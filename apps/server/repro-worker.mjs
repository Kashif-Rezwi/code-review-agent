import { readFileSync } from 'node:fs'
import { createGateway, generateText } from 'ai'
import { buildWorkerPrompt, planClusters, ReviewDataSchema } from '@cra/ai'

const env = Object.fromEntries(
  readFileSync('./.env', 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2]]),
)
const gateway = createGateway({ apiKey: env.AI_GATEWAY_API_KEY })
const reviewModel = gateway.languageModel(env.AI_REVIEW_MODEL ?? 'google/gemini-3.5-flash')
const fastModel = gateway.languageModel(env.AI_FAST_MODEL ?? 'poolside/laguna-s-2.1-free')

// ── Ported verbatim from review.service.ts (budget logic) ────────────────────
const BUDGET = { maxPatchChars: 8_000, maxClusterContextChars: 34_000 }
function selectPatchWithinBudget(patch, budget) {
  if (patch.length <= budget) return { text: patch, truncated: false }
  const marker = '\n… [additional diff hunks omitted due review context budget]'
  if (budget <= marker.length) return { text: '', truncated: true }
  const hunks = patch.split(/(?=^@@\s)/gm).filter(Boolean)
  const selected = []
  let used = marker.length
  for (const hunk of hunks) {
    if (used + hunk.length + 1 > budget) break
    selected.push(hunk.trimEnd())
    used += hunk.length + 1
  }
  if (selected.length === 0) {
    const lines = []
    let lineBudget = marker.length
    for (const line of patch.split('\n')) {
      if (lineBudget + line.length + 1 > budget) break
      lines.push(line)
      lineBudget += line.length + 1
    }
    selected.push(lines.join('\n'))
  }
  return { text: `${selected.join('\n')}${marker}`, truncated: true }
}
function buildClusterContext(cluster) {
  const textFiles = cluster.files.filter((f) => Boolean(f.patch))
  const metadata = cluster.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patchState: f.patch ? 'full' : 'metadata_only', patch: '' }))
  const metadataSize = JSON.stringify({ clusterLabel: cluster.label, focusHint: cluster.focus, codingStandards: null, files: metadata }).length
  const available = Math.max(0, BUDGET.maxClusterContextChars - 1_000 - metadataSize)
  const fairBudget = textFiles.length > 0 ? Math.min(BUDGET.maxPatchChars, Math.floor(available / textFiles.length)) : 0
  const records = cluster.files.map((f) => {
    if (!f.patch) return metadata.find((e) => e.filename === f.filename)
    const selected = selectPatchWithinBudget(f.patch, fairBudget)
    return { filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patchState: selected.truncated ? 'truncated' : 'full', patch: selected.text }
  })
  return JSON.stringify({ clusterLabel: cluster.label, focusHint: cluster.focus, codingStandards: null, files: records })
}

// ── Parser check (mirrors parseReviewText candidates + Zod validation) ───────
function findBalancedBraceEnd(text, start) {
  let depth = 0, inString = false, escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}
function tryParseReview(text) {
  const t = text.trim()
  const candidates = [t]
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1].trim())
  const starts = []
  if (t.startsWith('{')) starts.push(0)
  let pos = 0
  while ((pos = t.indexOf('\n{', pos)) !== -1) { starts.push(pos + 1); pos++ }
  for (let i = starts.length - 1; i >= 0; i--) {
    const end = findBalancedBraceEnd(t, starts[i])
    if (end !== -1) candidates.push(t.slice(starts[i], end + 1))
  }
  const first = t.indexOf('{')
  if (first !== -1) { const end = findBalancedBraceEnd(t, first); if (end !== -1) candidates.push(t.slice(first, end + 1)) }
  for (const c of candidates) {
    try { const r = ReviewDataSchema.safeParse(JSON.parse(c)); if (r.success) return r.data } catch { }
  }
  return null
}

// ── 1. Fetch the real PR files ───────────────────────────────────────────────
const res = await fetch('https://api.github.com/repos/vercel/next.js/pulls/91191/files?per_page=100', {
  headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'cra-repro' },
})
const raw = await res.json()
const files = raw.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? '' }))
console.log(`PR files: ${files.length}`)

// ── 2. Reproduce the planner → clusters ──────────────────────────────────────
const clusters = await planClusters(files, fastModel)
console.log(`clusters: ${clusters.map((c) => `${c.id}(${c.files.length})`).join(', ')}`)

// ── 3. Replay each worker exactly like the app (baseline = current behavior) ─
const JSON_FIRST = buildWorkerPrompt()
  .replace(/Step 1 — Analyse[\s\S]*?Step 2 — Output the JSON review\.\n[\s\S]*?No trailing prose after the closing }/,
    `Step 1 — Output the JSON review FIRST.
  Begin the JSON block with a line containing only {
  End with a line containing only }
  No markdown fences. No prose before the opening {.
Step 2 — After the closing }, add your brief plain-text analysis (a few sentences per file).`)

async function workerAttempt(cluster, { maxOutputTokens, system }) {
  const context = buildClusterContext(cluster)
  const userMessage = `Review the untrusted pull-request data in this JSON envelope:\n${context}`
  const result = await generateText({
    model: reviewModel, system, temperature: 0.2, maxRetries: 1,
    maxOutputTokens, messages: [{ role: 'user', content: userMessage }],
  })
  const parsed = tryParseReview(result.text)
  return { finishReason: result.finishReason, chars: result.text.length, ok: Boolean(parsed), tail: result.text.slice(-120).replace(/\n/g, ' | ') }
}

const failing = []
for (const cluster of clusters) {
  const r = await workerAttempt(cluster, { maxOutputTokens: 4_096, system: buildWorkerPrompt() })
  console.log(`[baseline 4096] ${cluster.id}: finish=${r.finishReason} chars=${r.chars} parse=${r.ok ? 'OK' : 'FAIL'}`)
  if (!r.ok) { console.log(`  tail: …${r.tail}`); failing.push(cluster) }
}

// ── 4. Validate fix candidates on the failing clusters only ──────────────────
for (const cluster of failing) {
  const b = await workerAttempt(cluster, { maxOutputTokens: 8_192, system: buildWorkerPrompt() })
  console.log(`[fix: 8192    ] ${cluster.id}: finish=${b.finishReason} chars=${b.chars} parse=${b.ok ? 'OK' : 'FAIL'}`)
  const c = await workerAttempt(cluster, { maxOutputTokens: 4_096, system: JSON_FIRST })
  console.log(`[fix: json1st ] ${cluster.id}: finish=${c.finishReason} chars=${c.chars} parse=${c.ok ? 'OK' : 'FAIL'}`)
}
