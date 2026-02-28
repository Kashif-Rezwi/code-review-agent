# AI Code Review SaaS — Master Implementation Plan
> **Single source of truth** for learning, building, and shipping.  
> Built by Kashif Rezwi | Guided by Claude

---

## Table of Contents

1. [The Vision](#the-vision)
2. [Why This Project](#why-this-project)
3. [Final Product Overview](#final-product-overview)
4. [Tech Stack](#tech-stack)
5. [Week-by-Week Roadmap](#week-by-week-roadmap)
   - [Week 1 — LLM APIs + Streaming](#week-1--llm-apis--streaming)
   - [Week 2 — Structured Outputs + Prompt Engineering](#week-2--structured-outputs--prompt-engineering)
   - [Week 3 — Tool Calling](#week-3--tool-calling)
   - [Week 4 — RAG](#week-4--rag)
   - [Week 5 — Multi-step Agents + Memory](#week-5--multi-step-agents--memory)
   - [Week 6 — Auth, Payments & Database](#week-6--auth-payments--database)
   - [Week 7 — Production Hardening](#week-7--production-hardening)
   - [Week 8 — Launch](#week-8--launch)
6. [Architecture Overview](#architecture-overview)
7. [NestJS Backend — Module Breakdown](#nestjs-backend--module-breakdown)
8. [Folder Structure](#folder-structure)
9. [Environment Variables](#environment-variables)
10. [Deployment & CI/CD](#deployment--cicd)
11. [How to Use This Document](#how-to-use-this-document)
12. [Interview Cheat Sheet](#interview-cheat-sheet)

---

## The Vision

**ReviewAI** is an AI-powered code review SaaS where developers paste a code snippet or GitHub PR link and receive an instant, structured review from an AI agent — covering bugs, security vulnerabilities, performance issues, and style violations, all benchmarked against the team's own coding standards.

Think of it as a senior engineer who is always available, never tired, and already knows your team's conventions.

---

## Why This Project

| Signal | Why it matters |
|--------|----------------|
| Solves a real daily pain for developers | You are your own user — no guessing about what to build |
| Interviewer = your target user | When you demo this, they immediately get the value |
| Every feature IS an AI skill | Each week you learn a concept by shipping it |
| Production-grade from day one | Auth, payments, DB — not a toy |
| Differentiated portfolio piece | Most devs build chatbots. You built a product. |

---

## Final Product Overview

### Core Features (what users will experience)

- **Instant Code Review** — paste code, get a structured review with severity levels, line references, explanations, and suggested fixes
- **GitHub PR Integration** — paste a PR URL, the agent fetches diffs automatically
- **Custom Coding Standards** — upload your team's style guide (PDF/text), reviews are personalized to your rules
- **Multi-file Agent Review** — agent autonomously reviews all changed files in a PR, cross-references issues
- **Review History** — all past reviews stored, searchable, with trend tracking
- **Usage-based Plans** — free tier (10 reviews/month), Pro tier (unlimited via Stripe)

### What it looks like at the end of Week 8

```
Landing page → Sign up → Paste code or PR URL → 
Streaming review appears → Structured issue cards → 
Ask follow-up questions → View history → Upgrade to Pro
```

---

## Tech Stack

### Why these choices

Every tool here was chosen because it is (a) what the market is actually hiring for right now, and (b) the best tool for its job in an AI-first product.

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | Next.js 14 (App Router) + TypeScript | Industry standard for AI SaaS frontends; UI only — no business logic |
| Styling | Tailwind CSS + shadcn/ui | Fast, professional UI without custom CSS overhead |
| **Backend** | NestJS + TypeScript | Production-grade, modular API server — your existing strength |
| AI Orchestration | Vercel AI SDK (used inside NestJS) | Best-in-class streaming, tool calling, and provider abstraction |
| LLM Provider | OpenAI GPT-4o (primary) + Groq (fallback) | GPT-4o for quality, Groq for speed/cost |
| Vector Database | Supabase pgvector | RAG without adding another service |
| Database | PostgreSQL via Supabase | Single platform for DB + vectors |
| ORM | Prisma (inside NestJS) | Type-safe DB queries, great DX |
| Auth | NextAuth.js v5 (frontend) + JWT guards (NestJS) | GitHub OAuth on the frontend; JWT validates every NestJS request |
| Payments | Stripe | Industry standard, well-documented |
| Frontend Deploy | Vercel | Zero-config Next.js deployment |
| Backend Deploy | Railway | Simple NestJS deployment, free tier available |
| Observability | Helicone | LLM call logging, cost tracking, debugging |

---

## Week-by-Week Roadmap

### Legend
- 📖 **Concept** — what you need to understand before building
- 🔨 **Build** — what you actually ship this week
- ✅ **Done when** — clear definition of done
- 💬 **Come back to Claude when** — specific triggers to ask for help
- 🧠 **Explain it back** — you should be able to say this out loud by end of week

---

### Week 1 — LLM APIs + Streaming

#### 📖 Concept

Before writing code, understand these things deeply:

**How LLMs work at the API level**
- A model takes a list of messages (system + user + assistant turns) and predicts the next tokens
- Every API call is stateless — the model has no memory, you send the full conversation history each time
- Tokens are not words — "Kashif" might be 2 tokens, `useCallback` might be 3
- Context window = the maximum tokens the model can "see" at once (GPT-4o = 128k tokens)
- Temperature controls randomness: 0 = deterministic, 1 = creative. For code review, use 0.2

**Why streaming matters**
- Without streaming: user waits 8-15 seconds staring at a spinner, then everything appears at once
- With streaming: text appears token by token, feels instant, perceived performance is dramatically better
- Technically: the API sends Server-Sent Events (SSE), your frontend reads them as they arrive
- Vercel AI SDK abstracts all of this into `useChat` and `streamText`

**System prompts**
- The system prompt is your contract with the model — it defines its persona, rules, and output format
- It is the single most important thing you control as an AI engineer
- Bad system prompt = unreliable, inconsistent output. Good system prompt = predictable, useful output

#### 🔨 Build — Week 1

**Day 1-2: Project setup — monorepo**
```bash
# 1. Create the monorepo structure
mkdir code-review-agent && cd code-review-agent
git init
pnpm init

# 2. Create workspace config
cat > pnpm-workspace.yaml << EOF
packages:
  - 'apps/*'
  - 'packages/*'
EOF

# 3. Scaffold the apps and packages directories
mkdir -p apps packages/types/src packages/ai/src/prompts packages/ai/src/tools packages/ai/src/schemas

# Next.js client
cd apps && npx create-next-app@latest client --typescript --tailwind --app
# NestJS server
nest new server --package-manager pnpm
cd ..

# 4. Set up packages/types (Contract Layer)
cd packages/types && pnpm init
# Edit package.json: set name to "@cra/types", add "main": "src/index.ts"
pnpm add zod
cd ../..

# 5. Set up packages/ai (Domain Layer)
cd packages/ai && pnpm init
# Edit package.json: set name to "@cra/ai", add "main": "src/index.ts"
pnpm add ai openai zod
cd ../..

# 6. Wire up workspace dependencies
# apps/client/package.json  → add: "@cra/types": "workspace:*"
# apps/server/package.json  → add: "@cra/types": "workspace:*", "@cra/ai": "workspace:*"
# packages/ai/package.json  → add: "@cra/types": "workspace:*"

# 7. Install everything from root
pnpm install

# 8. Set up shadcn/ui in apps/client
cd apps/client && npx shadcn-ui@latest init && cd ../..

# 9. Configure platforms (Root Directory settings are critical)
# Vercel  → Root Directory: apps/client
# Railway → Root Directory: apps/server

# 10. Confirm dev works
pnpm dev   # starts Next.js on :3000 and NestJS on :4000 simultaneously
```

**Day 3-4: Core streaming endpoint in NestJS**
```
- Create ReviewModule, ReviewController, ReviewService
- Build POST /review/stream endpoint using streamText from Vercel AI SDK
- NestJS streaming response: use res.setHeader + res.write to pipe SSE
- Write your first system prompt (code reviewer persona) in a prompts.ts file
- Test with curl: confirm tokens stream back one by one
```

**Day 5-6: Connect frontend to NestJS + Code input UX**
```
- Build the frontend chat UI — useChat hook pointing to NestJS URL
  (NEXT_PUBLIC_API_URL=http://localhost:3000)
- Add a code editor input (Monaco Editor or CodeMirror)
- Support syntax highlighting for common languages
- Add language auto-detection
- Display a character/token count estimate
```

**Day 7: Polish + reflection**
```
- Clean up UI, add loading states, error states
- Write in your dev journal: what did you learn this week?
- Push both repos to GitHub with proper READMEs
```

#### ✅ Done when
- [ ] NestJS server runs locally and returns streaming SSE response
- [ ] Next.js frontend connects to NestJS and displays streaming text
- [ ] User can paste code into an editor
- [ ] Clicking "Review" sends it to NestJS and streams back token by token
- [ ] Page looks clean and professional on both mobile and desktop
- [ ] Both repos pushed to GitHub; frontend deployed to Vercel

#### 💬 Come back to Claude when
- The streaming isn't working (common issue: not setting the right headers)
- You're unsure how to write the system prompt
- You want a code review of what you've built

#### 🧠 Explain it back
> "LLMs are stateless — every API call gets the full conversation history. Streaming works via Server-Sent Events, where the server pushes tokens as they're generated instead of waiting for the full response. I control model behavior through the system prompt, which acts as a contract defining the model's persona and rules. Temperature near 0 makes output deterministic, which is what you want for technical tasks like code review."

---

### Week 2 — Structured Outputs + Prompt Engineering

#### 📖 Concept

**The problem with free-form text**
- Week 1's review comes back as a wall of text — hard to parse, inconsistent, can't build UI around it
- You need the model to return structured data (JSON) so you can render review cards, filter by severity, etc.
- But LLMs are probabilistic — they might return slightly different JSON shapes each time

**Structured outputs (two approaches)**

*Approach 1: JSON mode*  
Tell the model "respond only in valid JSON" in the system prompt. Works ~90% of the time. Cheap.

*Approach 2: Tool calling for structure*  
Define a schema and tell the model to call a "tool" with that schema as its only option. Works ~99% of the time. The right approach for production.

**Prompt engineering fundamentals**
- **Be specific about format**: don't say "review the code" — say "identify up to 10 issues, each with a type, severity, lineStart, lineEnd, explanation, and suggestedFix"
- **Use examples (few-shot)**: showing the model 1-2 examples of perfect output dramatically improves consistency
- **Chain of thought**: asking the model to "think step by step" before answering improves accuracy on complex reasoning tasks
- **Negative constraints**: tell the model what NOT to do ("do not make up line numbers", "do not suggest rewrites of working code")

#### 🔨 Build — Week 2

**Day 1-2: Define the review schema**
```typescript
// This is the shape of every code review issue
interface ReviewIssue {
  id: string
  type: 'bug' | 'security' | 'performance' | 'style' | 'suggestion'
  severity: 'critical' | 'warning' | 'info'
  lineStart: number
  lineEnd: number
  title: string
  explanation: string
  suggestedFix: string
  codeExample?: string
}

interface CodeReview {
  summary: string
  overallScore: number // 1-10
  issues: ReviewIssue[]
  positives: string[] // what the code does well
}
```

**Day 3-4: Implement structured output in NestJS**
```
- Add POST /review/analyze endpoint in ReviewController
- Use Vercel AI SDK's generateObject with Zod schema inside ReviewService
- Rewrite system prompt to enforce the schema
- Add few-shot examples of good reviews in the system prompt
- Test with 10 different code snippets, verify consistent output
```

**Day 5-6: Build the review UI**
```
- Replace the chat text display with structured issue cards
- Color-coded by severity (red = critical, yellow = warning, blue = info)
- Show line number badges
- Expandable cards with full explanation and suggested fix
- Overall score display with a simple visual (ring chart or score badge)
- "Positives" section at the top
```

**Day 7: Prompt iteration**
```
- Test with edge cases: empty functions, minified code, very long files
- Identify where the model gives bad output and fix the prompt
- Document your system prompt with comments explaining each decision
```

#### ✅ Done when
- [ ] Every review returns valid, consistent JSON matching the schema
- [ ] UI renders structured issue cards (not raw text)
- [ ] Issues are filterable by type and severity
- [ ] Overall score displays correctly
- [ ] Edge cases (empty input, non-code input) are handled gracefully

#### 💬 Come back to Claude when
- The model keeps returning invalid JSON
- You're not sure how to write the Zod schema
- The structured output looks right but the UI isn't rendering it correctly

#### 🧠 Explain it back
> "Structured outputs solve the problem of LLMs returning inconsistent text by forcing them to return data matching a predefined schema. I use Zod to define the schema and Vercel AI SDK's generateObject to enforce it. The key to reliable structured output is a combination of explicit schema definition and few-shot examples in the system prompt that show the model exactly what good output looks like."

---

### Week 3 — Tool Calling

#### 📖 Concept

**What tool calling actually is**
- Tool calling (also called function calling) is how you give an LLM the ability to take actions, not just generate text
- You define a set of tools (functions with name, description, and parameters schema)
- The model decides WHEN to call a tool and WITH WHAT arguments — you don't tell it when
- Your code executes the tool and returns the result back to the model
- The model then continues its response with that information

**The agent loop**
```
User sends message
  → Model decides: do I need a tool?
    → YES: model outputs a tool call (name + args)
      → Your code runs the tool
        → Result sent back to model
          → Model continues (may call another tool, or respond)
    → NO: model generates final response
```

**This is the core of agentic AI.** Everything from "browse the web" to "write and run code" follows this exact loop.

**Tools you'll build this week**
- `fetchGithubPR` — given a PR URL, returns the diff
- `fetchFileContent` — given a repo + file path, returns the file content
- `runLinter` — runs ESLint on the code, returns lint results

#### 🔨 Build — Week 3

**Day 1-2: GitHub integration in NestJS**
```
- Create GithubModule, GithubService
- Set up GitHub OAuth App (needed for private repos later)
- Build fetchGithubPR tool: parse PR URL → call GitHub API → return structured diff
- Test with public repos first
- Handle pagination for large PRs
```

**Day 3-4: Implement tool calling in NestJS review flow**
```
- Define tools in lib/tools.ts using Vercel AI SDK's tool() function
- Update ReviewService to use streamText with tools
- The model now automatically fetches the PR when given a URL
- SSE stream now emits tool call events — handle them on the frontend
- Show "Analyzing PR..." state while tool calls happen
- Show which files were reviewed in the response
```

**Day 5-6: Linter tool as a NestJS service**
```
- Create LinterService inside a LinterModule
- Build a sandboxed linter using @typescript-eslint/parser
- Expose it as a tool the AI agent can call
- Pass lint results to the model as additional context
- The review now combines AI analysis + actual linter output
```

**Day 7: Multi-tool orchestration**
```
- Test a full flow: user pastes PR URL → agent fetches PR → 
  agent runs linter → agent generates structured review
- Ensure the UI communicates each step clearly
- Handle errors gracefully (private repo, invalid URL, etc.)
```

#### ✅ Done when
- [ ] User can paste a GitHub PR URL instead of manual code
- [ ] Agent automatically fetches and reviews all changed files
- [ ] Linter results are incorporated into the review
- [ ] UI shows progress through each step of the agent loop
- [ ] Private repos work (with GitHub auth)

#### 💬 Come back to Claude when
- The GitHub API is returning unexpected data shapes
- The model isn't calling tools when it should (usually a description problem)
- The agent loop is getting stuck or producing repeated tool calls

#### 🧠 Explain it back
> "Tool calling gives LLMs the ability to take actions beyond generating text. You define tools with a name, description, and parameter schema. The model decides when to call them and with what arguments — you don't control that directly. Your code executes the tool and returns the result. This creates an agent loop where the model can chain multiple tool calls to complete a complex task, like fetching a PR, running a linter, and then generating a review."

---

### Week 4 — RAG (Retrieval Augmented Generation)

#### 📖 Concept

**The core problem RAG solves**
- LLMs only know what they were trained on — they don't know your team's coding standards
- You can't just dump a 50-page style guide into every prompt — that's expensive and hits context limits
- RAG solves this: store the knowledge in a vector database, retrieve only the relevant parts at query time

**How RAG works (step by step)**
1. **Ingestion**: take your documents (PDFs, text files), split them into chunks
2. **Embedding**: convert each chunk into a vector (list of ~1500 numbers) using an embedding model
3. **Storage**: store the vectors in a vector database (Supabase pgvector)
4. **Retrieval**: when a user submits code, embed their query, find the most similar vectors (semantic search)
5. **Augmentation**: inject the retrieved chunks into the model's context as additional knowledge
6. **Generation**: the model reviews the code with awareness of the team's specific standards

**Embeddings explained simply**
- An embedding is a mathematical representation of meaning in high-dimensional space
- Similar meanings → similar vectors → close together in vector space
- "Don't use var" and "prefer const over var" would have very similar embeddings
- This lets you find semantically relevant rules even if the exact words don't match

#### 🔨 Build — Week 4

**Day 1-2: Set up Supabase + pgvector**
```sql
-- Run this in Supabase SQL editor
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE coding_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX ON coding_standards 
USING ivfflat (embedding vector_cosine_ops);
```

**Day 3-4: Document ingestion pipeline in NestJS**
```
- Create RagModule, RagService, RagController
- Build POST /rag/upload endpoint that accepts PDF or text files (use Multer)
- Split document into chunks (500 tokens each, 50 token overlap)
- Generate embeddings using OpenAI text-embedding-3-small in RagService
- Store chunks + embeddings in Supabase via Prisma
- Add an "Upload Coding Standards" UI in the Next.js dashboard
```

**Day 5-6: Retrieval + augmentation in ReviewService**
```
- When code is submitted for review, ReviewService calls RagService.retrieve()
- RagService embeds the code snippet and queries pgvector for top 5 chunks
- Retrieved chunks are injected into system prompt as "Your team's coding standards:"
- Review is now personalized to the team's actual rules
- Test: upload a standards doc that says "never use any" in TypeScript
  → verify the review catches `any` usage
```

**Day 7: UI for standards management**
```
- Show uploaded standards documents in the dashboard
- Allow deletion of documents
- Show which standards were applied to each review (retrieved chunks)
- Add visual indicator: "Reviewed against your team's standards"
```

#### ✅ Done when
- [ ] Users can upload a PDF or text file of coding standards
- [ ] Reviews are noticeably different when standards are uploaded
- [ ] The relevant standards that were applied are shown in the review
- [ ] Multiple documents can be uploaded and managed
- [ ] Embeddings are stored correctly (verify in Supabase dashboard)

#### 💬 Come back to Claude when
- The pgvector similarity search isn't returning relevant results
- You're unsure how to chunk documents effectively
- The embedding costs are higher than expected (there's a fix for this)

#### 🧠 Explain it back
> "RAG lets you ground LLM responses in external knowledge without fine-tuning. You convert documents into vector embeddings — mathematical representations of meaning — and store them in a vector database. At query time, you embed the user's input and do a semantic similarity search to find the most relevant document chunks. Those chunks get injected into the model's context, so it can reason about your specific knowledge without seeing the entire document every time."

---

### Week 5 — Multi-step Agents + Memory

#### 📖 Concept

**What makes something an "agent" vs a regular LLM call**
- A regular LLM call: input → output. One shot.
- An agent: has a goal, plans steps to achieve it, executes those steps (using tools), observes results, adjusts
- Agents can loop — they keep acting until the goal is achieved or they hit a stop condition

**Types of memory in AI agents**
- **In-context memory**: everything in the current conversation. Temporary, expensive at scale.
- **External memory (semantic)**: past reviews stored in a DB, retrieved via embedding similarity — "find reviews similar to this code pattern"
- **External memory (episodic)**: structured storage of what happened — "user submitted X, agent found Y issues, user fixed Z"
- **Procedural memory**: the system prompt itself — the agent's persistent "how to behave" knowledge

**The planning problem**
- Simple agents just react. Better agents plan.
- ReAct pattern: **Re**ason → **Act** → **Observe** → Reason again
- You implement this by giving the model a "think" step before it acts

#### 🔨 Build — Week 5

**Day 1-2: Persistent review storage**
```
- Set up Prisma schema for reviews, issues, conversations
- Store every review with its issues, code snapshot, and PR reference
- Build a "Review History" page showing all past reviews
- Link issues across reviews: "You've had 5 null pointer issues this month"
```

**Day 3-4: Multi-file autonomous agent**
```
- Build an agent that receives a PR URL and autonomously:
  1. Fetches the PR metadata (title, description, author)
  2. Lists all changed files
  3. Reviews each file independently
  4. Cross-references issues found across files
  5. Produces a consolidated PR-level summary
- This is a loop — the agent decides how many files to review
  and when it's done
```

**Day 5-6: Follow-up conversation memory**
```
- After a review, users can ask follow-up questions:
  "Can you show me how to fix the null check on line 45?"
  "Which of these issues is most critical to fix first?"
- The agent has access to the full review context
- Store conversation history per review session
```

**Day 7: Trend analysis**
```
- Build a simple analytics view: "Your most common issues"
- Aggregate issue types across all reviews for a user
- Show week-over-week improvement (or regression)
- This is the "memory" that makes the product genuinely useful over time
```

#### ✅ Done when
- [ ] All reviews are persisted and viewable in history
- [ ] Multi-file PR reviews work end to end autonomously
- [ ] Follow-up questions work with full review context
- [ ] Issue trends are tracked and displayed
- [ ] Agent handles edge cases: empty PRs, binary files, very large files

#### 💬 Come back to Claude when
- The agent is getting stuck in loops (this happens — there's a fix)
- Managing the growing conversation context is causing issues
- The multi-file review is producing inconsistent results

#### 🧠 Explain it back
> "An agent differs from a regular LLM call by having a goal it pursues across multiple steps. It plans, acts using tools, observes results, and adjusts — potentially looping many times before completing. Memory is what makes agents useful over time: in-context memory for the current session, and external memory (stored in a database and retrieved semantically) for long-term knowledge. The ReAct pattern — reason, act, observe — is the core loop most production agents follow."

---

### Week 6 — Auth, Payments & Database

#### 📖 Concept

This week is less about AI and more about turning your tool into a real product. Don't underestimate it — this is where most "AI projects" die because the builder didn't finish.

**Auth considerations for a dev tool**
- GitHub OAuth is the perfect auth method here — your users ARE GitHub users
- You get their GitHub access token as part of auth, which you'll reuse for private repo access
- NextAuth.js v5 handles all of this cleanly with Next.js App Router

**Usage-based pricing model**
- Free: 10 reviews/month
- Pro ($12/month): unlimited reviews + private repo access + custom standards upload
- Stripe Checkout handles the payment flow
- Stripe webhooks update the user's plan in your database

#### 🔨 Build — Week 6

**Day 1-2: Auth — NextAuth on frontend, JWT guard on NestJS**
```
Frontend:
- Set up NextAuth.js v5 with GitHub provider
- On successful sign-in, NextAuth calls POST /auth/session on NestJS
  to create/update the user and receive a signed JWT back
- Store JWT in an httpOnly cookie
- All subsequent frontend → NestJS requests send the JWT in Authorization header

NestJS:
- Create AuthModule with JwtStrategy (passport-jwt)
- POST /auth/session — receives GitHub profile, upserts user in DB, returns JWT
- @UseGuards(JwtAuthGuard) on all protected controllers
- Store user in Prisma (id, name, email, githubToken, plan, reviewCount)
- Test: sign in via GitHub, verify JWT is issued and guards work
```

**Day 3: Usage limits in NestJS**
```
- Add reviewCount and reviewResetDate to Prisma user schema
- UsageGuard: a custom NestJS guard that checks usage before ReviewController runs
- Return 403 with { message: 'limit_reached', upgradeUrl: '...' } when limit hit
- Show usage counter in Next.js UI: "7 of 10 reviews used this month"
- Vercel cron (or Railway cron job) hits POST /admin/reset-usage monthly
```

**Day 4-5: Stripe integration in NestJS**
```
- Create StripeModule, StripeService, StripeController
- POST /stripe/checkout — creates Stripe Checkout session, returns URL
- POST /stripe/webhook — receives Stripe events, updates user plan in DB
  (use raw body middleware for Stripe signature verification)
- Add "Upgrade to Pro" button in Next.js that calls /stripe/checkout
- Test with Stripe CLI: stripe listen --forward-to localhost:3000/stripe/webhook
```

**Day 6-7: Dashboard and account page**
```
- Build a proper dashboard: review history, usage stats, plan status
- Account page: current plan, billing portal link (Stripe customer portal)
- Billing portal lets users cancel or upgrade without you building that UI
```

#### ✅ Done when
- [ ] GitHub sign in works end to end
- [ ] Free users are blocked after 10 reviews with a clear upgrade prompt
- [ ] Stripe payment flow works in test mode (complete payment → plan updates)
- [ ] Users can access Stripe billing portal to manage subscription
- [ ] All pages that require auth are properly protected

#### 💬 Come back to Claude when
- NextAuth session isn't available in API routes (common gotcha)
- Stripe webhooks aren't being received locally (use Stripe CLI)
- The usage reset logic isn't working correctly

#### 🧠 Explain it back
> "GitHub OAuth is ideal for a dev tool because our users are already GitHub users, and the OAuth token we receive doubles as their GitHub API access for private repos. NextAuth handles the session management. Stripe Checkout offloads the entire payment UI to Stripe, and webhooks notify us of payment events so we can update the user's plan in our database. We never touch card details."

---

### Week 7 — Production Hardening

#### 📖 Concept

**Why this week matters more than people think**
- An AI product has unique failure modes: the LLM call fails, times out, returns garbage, or costs $50 accidentally
- Production hardening for AI = rate limiting + cost controls + observability + graceful degradation
- Helicone sits between your code and OpenAI — it logs every call, tracks cost, lets you replay and debug

**Key concerns for AI products in production**
- **Cost**: GPT-4o is ~$0.005 per 1k input tokens. A long PR review might use 10k tokens = $0.05. At scale, this adds up fast.
- **Latency**: LLM calls are slow (3-15 seconds). You need good loading UX, timeouts, and streaming everywhere.
- **Reliability**: LLMs occasionally return malformed output. You need retry logic and fallbacks.
- **Rate limits**: OpenAI has rate limits per tier. At scale, you need a queue.

#### 🔨 Build — Week 7

**Day 1-2: Helicone integration**
```
- Sign up for Helicone (free tier is generous)
- Route all OpenAI calls through Helicone (one-line config change)
- Verify: every LLM call appears in Helicone dashboard with cost + latency
- Set up cost alerts: email if daily spend exceeds $5
```

**Day 3: Rate limiting with NestJS Throttler**
```
- Install @nestjs/throttler
- Configure ThrottlerModule globally: 10 req/min per user, 100 req/min globally
- Add @Throttle() decorator to ReviewController
- Return proper 429 errors — NestJS handles this automatically
- Show user-friendly "slow down" message in Next.js UI
```

**Day 4: Error handling + retry logic in NestJS**
```
- Create a global NestJS ExceptionFilter that maps errors to friendly responses
- Wrap all LLM calls in try/catch with typed error handling
- Retry on OpenAI rate limit errors (exponential backoff with a helper util)
- Provider fallback: if OpenAI throws, ReviewService switches to Groq
  (Vercel AI SDK makes switching providers a one-line change)
- Never expose raw LLM errors to the frontend
```

**Day 5: Token budgeting**
```
- Estimate token count before sending (use tiktoken)
- Cap input at 8000 tokens, return a clear error if exceeded
- Track tokens used per review in the database
- Show users their token usage in account page
```

**Day 6-7: Load testing + final QA**
```
- Use k6 or Artillery to simulate 50 concurrent users
- Fix any performance bottlenecks revealed
- Test every error state manually
- Accessibility check (axe DevTools)
- Full mobile UX review
```

#### ✅ Done when
- [ ] Every LLM call is logged in Helicone with cost and latency
- [ ] Cost alerts are configured
- [ ] Rate limiting works (test it by hammering the API)
- [ ] Fallback to Groq works when OpenAI fails
- [ ] All errors show user-friendly messages
- [ ] Load test passes without crashes

#### 💬 Come back to Claude when
- Helicone integration is breaking your existing auth headers
- The retry logic is causing double charges or duplicate reviews
- Load testing reveals a specific bottleneck you don't know how to fix

#### 🧠 Explain it back
> "AI products have unique production concerns — cost unpredictability, LLM-specific failure modes, and latency. Helicone gives me full observability into every LLM call: cost, latency, inputs, outputs, and errors. Rate limiting protects against abuse and runaway costs. Provider fallback means if OpenAI goes down, I automatically switch to Groq. Token budgeting prevents accidentally expensive requests."

---

### Week 8 — Launch

#### 📖 Concept

Launching is a skill. Most developers build things and then quietly deploy them and wonder why nobody shows up. A proper launch is a repeatable, intentional process.

**The launch checklist mindset**
- You're not launching a product, you're launching a story: "I built an AI tool that does X for Y people because Z was a real pain"
- Developers trust other developers. First-person, authentic posts outperform polished marketing.
- Timing matters: Tuesday–Thursday mornings get the most engagement

#### 🔨 Build — Week 8

**Day 1-2: Landing page**
```
- Build a proper landing page (separate from the app)
- Hero: clear one-sentence value prop + demo video/GIF
- Features section: 3-4 key features with screenshots
- Pricing: Free vs Pro, clear comparison
- Social proof: if anyone used it during testing, get a quote
- CTA: "Start reviewing code for free — no credit card"
```

**Day 3: Production deployment**
```
- Final environment variables audit
- Set up custom domain
- Configure Vercel production environment
- Run full E2E test on production
- Set up error monitoring (Sentry — free tier)
- Verify Stripe webhooks are pointing to production URL
```

**Day 4: Write the launch posts**

For Product Hunt:
```
Title: "ReviewAI — AI code review agent that knows your team's standards"
Tagline: "Paste code or a GitHub PR, get a structured review in seconds"
First comment: Tell the story. Why you built it. What problem it solves.
  Show the before/after. Be personal.
```

For X/Twitter (thread):
```
Tweet 1: "I spent 8 weeks building an AI code review tool. Here's what I learned:"
Tweet 2-8: One insight per tweet about AI integration, what surprised you, etc.
Last tweet: "The product is live. Try it free: [link]"
```

For LinkedIn:
```
Personal story format. "I was unemployed and used the time to build something real..."
More professional tone than Twitter but still personal
```

**Day 5: Launch day**
```
- Submit to Product Hunt (midnight PST for full day)
- Post Twitter thread
- Post on LinkedIn
- Share in relevant Discord servers (t3.gg, Reactiflux, etc.)
- Post on relevant subreddits (r/webdev, r/ChatGPTPromptEngineering, r/SideProject)
- Respond to every single comment, all day
```

**Day 6-7: Capture the learnings**
```
- Write a case study / blog post: "How I built ReviewAI: 8 weeks, every AI concept I used"
- This becomes a second portfolio piece
- Update your resume with ReviewAI
- Update your LinkedIn featured section
- You now have a genuine answer to "tell me about a project you're proud of"
```

#### ✅ Done when
- [ ] Landing page is live with a clear value prop
- [ ] Product is deployed to production and stable
- [ ] Product Hunt submission is live
- [ ] At least 3 social posts published on launch day
- [ ] You have at least 1 real user who isn't you or a friend
- [ ] Case study / blog post is published

---

## Architecture Overview

```
                    ┌─────────────────────────┐
                    │     User's Browser      │
                    └────────────┬────────────┘
                                 │ HTTPS
                    ┌────────────▼────────────┐
                    │   Next.js Frontend       │
                    │   (Vercel)               │
                    │                          │
                    │  - UI only               │
                    │  - NextAuth session      │
                    │  - Calls NestJS via JWT  │
                    └────────────┬────────────┘
                                 │ REST + SSE (JWT in header)
                    ┌────────────▼────────────┐
                    │   NestJS Backend API     │
                    │   (Railway)              │
                    │                          │
                    │  - All business logic    │
                    │  - All AI calls          │
                    │  - Auth guards           │
                    │  - Stripe webhooks       │
                    └──┬──────────────────┬───┘
                       │                  │
          ┌────────────▼───┐    ┌─────────▼──────────┐
          │ Supabase        │    │  External APIs      │
          │ PostgreSQL +    │    │  - OpenAI / Groq    │
          │ pgvector        │    │  - GitHub API       │
          └─────────────────┘    │  - Stripe           │
                                 │  - Helicone         │
                                 └─────────────────────┘
```

**Key architectural rule:** Next.js has zero business logic. It renders UI and proxies user actions to NestJS. All AI, all database access, all auth validation happens in NestJS.

---

## NestJS Backend — Module Breakdown

This is the complete NestJS module structure. Each module owns one domain.

```
src/
├── app.module.ts                  ← root module, imports everything
├── main.ts                        ← bootstrap, CORS, global pipes/filters
│
├── auth/                          ← AuthModule
│   ├── auth.module.ts
│   ├── auth.controller.ts         ← POST /auth/session
│   ├── auth.service.ts            ← upsert user, issue JWT
│   ├── jwt.strategy.ts            ← passport-jwt strategy
│   ├── jwt-auth.guard.ts          ← @UseGuards(JwtAuthGuard)
│   └── dto/
│       └── create-session.dto.ts
│
├── review/                        ← ReviewModule (core of the product)
│   ├── review.module.ts
│   ├── review.controller.ts       ← POST /review/stream, POST /review/analyze
│   ├── review.service.ts          ← orchestrates: RAG → tools → LLM → DB
│   ├── review.prompts.ts          ← all system prompts live here
│   ├── review.tools.ts            ← Vercel AI SDK tool() definitions
│   ├── review.schemas.ts          ← Zod schemas for structured output
│   └── dto/
│       ├── create-review.dto.ts
│       └── review-response.dto.ts
│
├── rag/                           ← RagModule
│   ├── rag.module.ts
│   ├── rag.controller.ts          ← POST /rag/upload, GET /rag/documents
│   ├── rag.service.ts             ← chunk → embed → store → retrieve
│   └── dto/
│       └── upload-document.dto.ts
│
├── github/                        ← GithubModule
│   ├── github.module.ts
│   ├── github.service.ts          ← fetchPR, fetchFileContent, listChangedFiles
│   └── github.types.ts
│
├── linter/                        ← LinterModule
│   ├── linter.module.ts
│   └── linter.service.ts          ← run ESLint programmatically, return typed results
│
├── stripe/                        ← StripeModule
│   ├── stripe.module.ts
│   ├── stripe.controller.ts       ← POST /stripe/checkout, POST /stripe/webhook
│   └── stripe.service.ts          ← createCheckoutSession, handleWebhook
│
├── users/                         ← UsersModule
│   ├── users.module.ts
│   ├── users.service.ts           ← findById, updatePlan, incrementReviewCount
│   └── guards/
│       └── usage.guard.ts         ← blocks review if limit reached
│
├── common/                        ← shared utilities
│   ├── filters/
│   │   └── http-exception.filter.ts   ← global error handler
│   ├── interceptors/
│   │   └── logging.interceptor.ts
│   └── utils/
│       ├── retry.ts               ← exponential backoff helper
│       └── tokens.ts              ← token counting with tiktoken
│
└── prisma/                        ← PrismaModule
    ├── prisma.module.ts
    └── prisma.service.ts          ← PrismaClient singleton
```

### Prisma Schema

```prisma
model User {
  id              String    @id @default(cuid())
  email           String    @unique
  name            String?
  githubId        String    @unique
  githubToken     String
  plan            Plan      @default(FREE)
  reviewCount     Int       @default(0)
  reviewResetDate DateTime  @default(now())
  createdAt       DateTime  @default(now())

  reviews         Review[]
  documents       Document[]
  conversations   Conversation[]
}

model Review {
  id           String        @id @default(cuid())
  userId       String
  user         User          @relation(fields: [userId], references: [id])
  code         String
  language     String?
  prUrl        String?
  summary      String
  overallScore Int
  tokensUsed   Int
  issues       Issue[]
  createdAt    DateTime      @default(now())

  conversation Conversation?
}

model Issue {
  id           String   @id @default(cuid())
  reviewId     String
  review       Review   @relation(fields: [reviewId], references: [id])
  type         IssueType
  severity     Severity
  lineStart    Int
  lineEnd      Int
  title        String
  explanation  String
  suggestedFix String
  codeExample  String?
}

model Document {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  name      String
  chunks    DocumentChunk[]
  createdAt DateTime @default(now())
}

model DocumentChunk {
  id         String   @id @default(cuid())
  documentId String
  document   Document @relation(fields: [documentId], references: [id])
  content    String
  embedding  Unsupported("vector(1536)")
  metadata   Json?
}

model Conversation {
  id        String    @id @default(cuid())
  reviewId  String    @unique
  review    Review    @relation(fields: [reviewId], references: [id])
  messages  Json      // store message history as JSON array
  updatedAt DateTime  @updatedAt
}

enum Plan {
  FREE
  PRO
}

enum IssueType {
  BUG
  SECURITY
  PERFORMANCE
  STYLE
  SUGGESTION
}

enum Severity {
  CRITICAL
  WARNING
  INFO
}
```

---

## Folder Structure

One repository, two apps, two shared packages. This is a **pnpm workspace monorepo** — no Nx, no Turborepo, just pnpm's built-in workspace feature.

### Four-layer architecture

| Layer | Location | Responsibility |
|-------|----------|---------------|
| **Contract** | `packages/types` | TypeScript types — what things look like |
| **Domain** | `packages/ai` | Prompts, tools, schemas, AI logic — how the AI thinks |
| **API** | `apps/server` | NestJS — how requests are handled, auth, payments, DB |
| **UI** | `apps/client` | Next.js — what users see, zero business logic |

The key insight: AI logic is a **domain layer**, not infrastructure. It lives in `packages/ai` so it's explicit, testable, and reusable — not buried inside NestJS.

### Root structure

```
code-review-agent/                     ← one git repo
├── apps/
│   ├── client/                        ← Next.js frontend (UI Layer)
│   └── server/                        ← NestJS backend (API Layer)
├── packages/
│   ├── types/                         ← Contract Layer
│   │   ├── src/
│   │   │   ├── review.types.ts        ← ReviewIssue, CodeReview, etc.
│   │   │   ├── user.types.ts
│   │   │   └── index.ts
│   │   ├── package.json               ← name: "@cra/types"
│   │   └── tsconfig.json
│   └── ai/                            ← Domain Layer
│       ├── src/
│       │   ├── prompts/
│       │   │   ├── review.prompt.ts   ← all system prompts
│       │   │   └── agent.prompt.ts
│       │   ├── tools/
│       │   │   ├── github.tool.ts     ← tool definitions (Vercel AI SDK)
│       │   │   └── linter.tool.ts
│       │   ├── schemas/
│       │   │   └── review.schema.ts   ← Zod schemas for structured output
│       │   ├── embeddings.ts          ← chunking + embedding logic
│       │   └── index.ts               ← re-exports everything
│       ├── package.json               ← name: "@cra/ai"
│       └── tsconfig.json
├── .github/
│   └── workflows/
│       └── deploy.yml                 ← CI/CD pipeline (see Deployment section)
├── pnpm-workspace.yaml
├── package.json                       ← root scripts
├── .gitignore
└── README.md
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### Root `package.json`

```json
{
  "name": "code-review-agent",
  "private": true,
  "scripts": {
    "dev": "concurrently \"pnpm --filter client dev\" \"pnpm --filter server dev\"",
    "build": "pnpm --filter types build && pnpm --filter ai build && pnpm --filter client build && pnpm --filter server build",
    "lint": "pnpm -r lint",
    "type-check": "pnpm -r type-check"
  },
  "devDependencies": {
    "concurrently": "^8.0.0"
  }
}
```

Running `pnpm dev` from the root starts both Next.js (port 3000) and NestJS (port 4000) simultaneously.

### `apps/client/` — Next.js frontend

```
apps/client/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── layout.tsx
│   ├── (dashboard)/
│   │   ├── dashboard/page.tsx
│   │   ├── review/
│   │   │   ├── [id]/page.tsx
│   │   │   └── new/page.tsx
│   │   ├── history/page.tsx
│   │   ├── settings/page.tsx
│   │   └── layout.tsx
│   ├── api/
│   │   └── auth/[...nextauth]/route.ts   ← ONLY Next.js API route
│   ├── layout.tsx
│   └── page.tsx                          ← landing page
├── components/
│   ├── ui/                               ← shadcn components
│   ├── review/
│   │   ├── CodeEditor.tsx
│   │   ├── ReviewStream.tsx              ← handles SSE from NestJS
│   │   ├── IssueCard.tsx
│   │   ├── ReviewCard.tsx
│   │   └── SeverityBadge.tsx
│   ├── dashboard/
│   │   ├── ReviewHistory.tsx
│   │   ├── UsageStats.tsx
│   │   └── TrendChart.tsx
│   └── shared/
│       ├── Header.tsx
│       └── Sidebar.tsx
├── lib/
│   ├── api.ts                            ← typed fetch wrapper → NestJS
│   └── auth.ts                           ← NextAuth config
├── .env.local
├── .env.example
├── package.json                          ← depends on "@cra/types"
└── next.config.ts
```

### `apps/server/` — NestJS backend

```
apps/server/
├── src/                                  ← (see NestJS Module Breakdown above)
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── test/
│   └── review.e2e-spec.ts
├── .env
├── .env.example
├── nest-cli.json
├── package.json                          ← depends on "@cra/types"
└── tsconfig.json
```

### `packages/types/` — Contract Layer

Types only. No logic, no dependencies beyond Zod. Both apps depend on this.

```typescript
// packages/types/src/review.types.ts
import { z } from 'zod'

export const ReviewIssueSchema = z.object({
  id: z.string(),
  type: z.enum(['bug', 'security', 'performance', 'style', 'suggestion']),
  severity: z.enum(['critical', 'warning', 'info']),
  lineStart: z.number(),
  lineEnd: z.number(),
  title: z.string(),
  explanation: z.string(),
  suggestedFix: z.string(),
  codeExample: z.string().optional(),
})

export const CodeReviewSchema = z.object({
  summary: z.string(),
  overallScore: z.number().min(1).max(10),
  issues: z.array(ReviewIssueSchema),
  positives: z.array(z.string()),
})

// Types inferred from schemas — zero duplication
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>
export type CodeReview = z.infer<typeof CodeReviewSchema>
```

### `packages/ai/` — Domain Layer

All AI logic. Depends on `@cra/types`. Used by `apps/server` only (not the frontend).

```typescript
// packages/ai/src/prompts/review.prompt.ts
export const REVIEW_SYSTEM_PROMPT = `
You are an expert code reviewer with deep knowledge of software engineering best practices.
Your job is to analyze code and identify bugs, security vulnerabilities, performance issues,
and style violations. Be specific, actionable, and constructive.
...
`

// packages/ai/src/schemas/review.schema.ts
import { CodeReviewSchema } from '@cra/types'
export { CodeReviewSchema }  // re-export — schema lives in types, AI package uses it

// packages/ai/src/tools/github.tool.ts
import { tool } from 'ai'
import { z } from 'zod'

export const fetchGithubPRTool = tool({
  description: 'Fetch the diff of a GitHub pull request given its URL',
  parameters: z.object({ prUrl: z.string().url() }),
  execute: async ({ prUrl }) => {
    // GitHub API call logic here
  },
})

// packages/ai/src/index.ts — clean public API
export { REVIEW_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT } from './prompts'
export { fetchGithubPRTool, runLinterTool } from './tools'
export { CodeReviewSchema } from './schemas'
export { generateEmbedding, chunkDocument } from './embeddings'
```

```typescript
// In NestJS ReviewService — imports are clean and intentional
import { REVIEW_SYSTEM_PROMPT, fetchGithubPRTool, CodeReviewSchema } from '@cra/ai'
import { CodeReview } from '@cra/types'

// In Next.js ReviewCard — only needs the type, not AI logic
import { CodeReview } from '@cra/types'
const ReviewCard = ({ review }: { review: CodeReview }) => { ... }
```

This separation means your AI logic is independently testable — you can unit test a prompt or a tool without booting up NestJS.

---

## Environment Variables

Each app manages its own `.env` file. Never put secrets in the root.

### `apps/client/.env.example`

```bash
# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# NestJS backend URL — change to Railway URL in production
NEXT_PUBLIC_API_URL=http://localhost:4000

# Stripe (publishable key only — secret key lives in NestJS)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

### `apps/server/.env.example`

```bash
# Server
PORT=4000

# Database (Supabase)
DATABASE_URL=
DIRECT_URL=

# JWT
JWT_SECRET=
JWT_EXPIRES_IN=7d

# AI Providers
OPENAI_API_KEY=
GROQ_API_KEY=

# Observability
HELICONE_API_KEY=

# GitHub (server-side, for fetching PRs)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRO_PRICE_ID=

# Frontend URL (for CORS + Stripe redirect)
FRONTEND_URL=http://localhost:3000
```

### `.gitignore` at repo root

```
# env files — never commit these
apps/client/.env.local
apps/client/.env
apps/server/.env

# dependencies
node_modules/
apps/*/node_modules/
packages/*/node_modules/

# build outputs
apps/client/.next/
apps/server/dist/
packages/types/dist/
```

---

## Deployment & CI/CD

### How it works

One GitHub repo, two independent deployments. GitHub Actions detects which app changed and deploys only that service. Vercel watches `apps/client`, Railway watches `apps/server`. If you change a shared type in `packages/types`, both deploy.

```
push to main
     │
     ├── GitHub Actions checks changed paths
     │
     ├── apps/server/** or packages/ai/** changed?   ──→  deploy-api job  ──→  Railway
     ├── apps/client/** or packages/types/** changed? ──→  deploy-web job  ──→  Vercel
     └── packages/types/** changed? → both jobs run
```

### GitHub Actions — `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  # Detect which apps changed
  changes:
    runs-on: ubuntu-latest
    outputs:
      api: ${{ steps.filter.outputs.api }}
      web: ${{ steps.filter.outputs.web }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v2
        id: filter
        with:
          filters: |
            api:
              - 'apps/server/**'
              - 'packages/ai/**'
              - 'packages/types/**'
            web:
              - 'apps/client/**'
              - 'packages/types/**'

  # Deploy NestJS to Railway (only if api or types changed)
  deploy-api:
    needs: changes
    if: ${{ needs.changes.outputs.api == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared types
        run: pnpm --filter types build

      - name: Build AI package
        run: pnpm --filter ai build

      - name: Build API
        run: pnpm --filter server build

      - name: Deploy to Railway
        uses: bervProject/railway-deploy@main
        with:
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          service: api

  # Deploy Next.js to Vercel (only if web or types changed)
  deploy-web:
    needs: changes
    if: ${{ needs.changes.outputs.web == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: apps/client
          vercel-args: '--prod'
```

### GitHub Secrets to configure

Go to your repo → Settings → Secrets and variables → Actions, and add:

| Secret | Where to get it |
|--------|----------------|
| `RAILWAY_TOKEN` | Railway dashboard → Account → Tokens |
| `VERCEL_TOKEN` | Vercel dashboard → Settings → Tokens |
| `VERCEL_ORG_ID` | Vercel dashboard → Settings → General |
| `VERCEL_PROJECT_ID` | Vercel project → Settings → General |

### Vercel setup for monorepo

```
1. Go to vercel.com → Add New Project → import your GitHub repo
2. In "Configure Project":
   - Framework Preset: Next.js
   - Root Directory: apps/client        ← critical setting
3. Add environment variables (production values from apps/client/.env.example)
4. Deploy
```

Vercel will now only trigger builds when files inside `apps/client/` change, and it builds from that subdirectory.

### Railway setup for monorepo

```
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select your repo
3. In service settings:
   - Root Directory: apps/server        ← critical setting
   - Build Command: pnpm build
   - Start Command: node dist/main
4. Add environment variables (production values from apps/server/.env.example)
5. Deploy
```

Railway gives you a public URL like `https://code-review-agent.up.railway.app`. Copy this into Vercel's `NEXT_PUBLIC_API_URL` environment variable.

### CORS in `apps/server/src/main.ts`

```typescript
app.enableCors({
  origin: process.env.FRONTEND_URL, // your Vercel URL in production
  credentials: true,
});
```

### Stripe webhooks in production

```
After deploying to Railway:
1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. Endpoint URL: https://your-api.up.railway.app/stripe/webhook
3. Select events: checkout.session.completed, customer.subscription.deleted
4. Copy the webhook signing secret → add to Railway env as STRIPE_WEBHOOK_SECRET
```

### Local development

```bash
# Clone the repo
git clone https://github.com/kashifrezwi/code-review-agent
cd code-review-agent

# Install all dependencies across all apps + packages
pnpm install

# Copy env files
cp apps/client/.env.example apps/client/.env.local
cp apps/server/.env.example apps/server/.env

# Fill in your API keys in both .env files, then:
pnpm dev   # starts Next.js on :3000 and NestJS on :4000 simultaneously
```

---

## How to Use This Document

**At the start of each week:**
1. Read the 📖 Concept section fully — before opening VS Code
2. Copy the 🔨 Build checklist into a Notion page or physical notebook
3. Set a daily goal from the build tasks

**During the week:**
- Check off tasks as you complete them
- When stuck for more than 30 minutes, come back to Claude with specific context: what you tried, what error you got, what you expected

**At the end of each week:**
- Do the 🧠 Explain it back exercise out loud — literally say it to yourself or record a voice note
- If you can't explain it, you don't understand it yet. That's fine — figure out what's missing and fix it before moving on
- Push everything to GitHub with a meaningful commit message

**The rule on copy-pasting code:**
- Getting code from Claude or any source is fine — but you must read every line before using it
- If there's a line you don't understand, ask about it before moving on
- The interview will ask you to explain your own code. Make sure you can.

---

## Interview Cheat Sheet

When you finish this project, you'll be able to answer all of these:

**"Tell me about a project you're proud of."**  
> Talk about ReviewAI. Explain the problem, the AI agent architecture, the RAG pipeline. Use the ✅ done-when criteria as proof points.

**"What's your experience with AI integration?"**  
> Streaming LLM responses, structured outputs with Zod schemas, tool calling for agent loops, RAG with pgvector, multi-step agent orchestration, production cost and latency management.

**"How does RAG work?"**  
> Use the 🧠 Explain it back from Week 4.

**"What's tool calling and when would you use it?"**  
> Use the 🧠 Explain it back from Week 3.

**"How do you handle AI reliability in production?"**  
> Provider fallback (OpenAI → Groq), retry with exponential backoff, token budgeting, Helicone for observability, rate limiting per user.

**"Why this tech stack?"**  
> You made deliberate choices — Next.js as a pure UI layer with zero business logic, NestJS as a production-grade modular API you already know from real production work. Supabase for pgvector + DB in one platform, Vercel AI SDK for provider abstraction so switching from OpenAI to Groq is one line. You can justify each one.

**"Why a separate NestJS backend instead of Next.js API routes?"**  
> Separation of concerns and architectural maturity. Next.js API routes are convenient for side projects but don't scale well. With NestJS I get dependency injection, guards, interceptors, proper module boundaries — the same structure a real engineering team would use. It also means the API is reusable: a CLI or mobile client could consume it without changing anything.

**"How did you manage the monorepo — did you use Nx or Turborepo?"**  
> I used pnpm workspaces without Nx or Turborepo — deliberate choice. Those tools add real configuration overhead that isn't justified for two apps. I structured the monorepo in four layers: `packages/types` as the contract layer (shared Zod schemas and TypeScript types), `packages/ai` as the domain layer (all prompts, tools, and AI logic — independently testable without booting NestJS), `apps/server` as the API layer, and `apps/client` as the UI layer. For CI/CD I used GitHub Actions with `dorny/paths-filter` to detect which packages changed and deploy only the affected services — Next.js to Vercel, NestJS to Railway, independently.

---

*Last updated: Week 0 (before start)*  
*Update this document as you make architectural decisions that differ from the plan.*