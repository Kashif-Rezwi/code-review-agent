/**
 * Central tuning surface for every AI call in the review pipeline. Values are tuned for the
 * deepseek/deepseek-v4-flash-0731 tier (review + fast) — revisit when changing models or quota:
 * a PR review fans out to 1 planner + N concurrent workers (x attempts) + 2 synthesis calls on one quota budget.
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
}

export const AI_POLICY = {
    /** Agent-loop step caps (one step ≈ one model round-trip). */
    maxSteps: { code: 10, worker: 5 },

    /** 0.2 balances determinism with genuine analysis; retries go fully deterministic. */
    temperature: { standard: 0.2, retry: 0, chat: 0.3 },

    /** Output-token ceilings with headroom for hidden *thinking* tokens — a 4,096 worker cap truncated mid-analysis (no JSON emitted); 8,192 passed. */
    maxOutputTokens: { code: 8_192, worker: 8_192, synthesis: 8_192, chat: 4_096 },

    deadlineMs: {
        /** Whole-job ceiling enforced by ReviewProcessor. */
        total: 5 * 60_000,
        planner: 30_000,
        workerAttempt: 90_000,
        codeReview: 120_000,
        synthesisAttempt: 60_000,
    },

    worker: {
        /** Parallel cluster agents — the main RPM driver. AI_WORKER_CONCURRENCY overrides. */
        concurrency: envInt('AI_WORKER_CONCURRENCY', 3, 1, 8),
        attempts: 2,
    },

    /** Prompt-assembly budgets in characters (≈ 4 chars/token). */
    budget: {
        maxPatchChars: 8_000,
        maxClusterPromptChars: 40_000,
        maxClusterContextChars: 34_000,
    },
} as const