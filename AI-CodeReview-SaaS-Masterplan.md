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
6. [Folder Structure](#folder-structure)
7. [Environment Variables](#environment-variables)
8. [How to Use This Document](#how-to-use-this-document)
9. [Interview Cheat Sheet](#interview-cheat-sheet)

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
| Frontend | Next.js 14 (App Router) + TypeScript | Industry standard for AI SaaS frontends |
| Styling | Tailwind CSS + shadcn/ui | Fast, professional UI without custom CSS overhead |
| AI Orchestration | Vercel AI SDK | Best-in-class streaming, tool calling, and provider abstraction |
| LLM Provider | OpenAI GPT-4o (primary) + Groq (fallback) | GPT-4o for quality, Groq for speed/cost |
| Vector Database | Supabase pgvector | RAG without adding another service |
| Database | PostgreSQL via Supabase | Auth + DB + vectors in one platform |
| ORM | Prisma | Type-safe DB queries, great DX |
| Auth | NextAuth.js v5 | GitHub OAuth (fits the dev audience perfectly) |
| Payments | Stripe | Industry standard, well-documented |
| Deployment | Vercel | Zero-config Next.js deployment |
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

**Day 1-2: Project setup**
```
- Initialize Next.js 14 with TypeScript and App Router
- Set up Tailwind CSS + shadcn/ui
- Configure environment variables
- Set up Vercel project and connect GitHub repo
- Install Vercel AI SDK: npm install ai openai
```

**Day 3-4: Core streaming chat**
```
- Build the /api/chat route using streamText from Vercel AI SDK
- Write your first system prompt (code reviewer persona)
- Build the frontend chat UI with useChat hook
- Implement streaming text display with a blinking cursor
```

**Day 5-6: Code input UX**
```
- Add a code editor input (use Monaco Editor or CodeMirror)
- Support syntax highlighting for common languages
- Add language auto-detection
- Display a character/token count estimate
```

**Day 7: Polish + reflection**
```
- Clean up UI, add loading states, error states
- Write in your dev journal: what did you learn this week?
- Push to GitHub with a proper README
```

#### ✅ Done when
- [ ] User can paste code into an editor
- [ ] Clicking "Review" sends it to the API
- [ ] Response streams back token by token (no spinner-then-dump)
- [ ] Page looks clean and professional on both mobile and desktop
- [ ] Deployed to Vercel and accessible via a URL

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

**Day 3-4: Implement structured output**
```
- Use Vercel AI SDK's generateObject with Zod schema
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

**Day 1-2: GitHub integration**
```
- Set up GitHub OAuth App (needed for private repos later)
- Build fetchGithubPR tool: parse PR URL → call GitHub API → return structured diff
- Test with public repos first
- Handle pagination for large PRs
```

**Day 3-4: Implement tool calling in the review flow**
```
- Define tools using Vercel AI SDK's tool() function
- Update the API route to use streamText with tools
- The model now automatically fetches the PR when given a URL
- Add UI: "Analyzing PR..." state while tool calls happen
- Show which files were reviewed
```

**Day 5-6: Linter tool**
```
- Build a sandboxed linter tool using @typescript-eslint/parser
- Run it on submitted code before the LLM review
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

**Day 3-4: Document ingestion pipeline**
```
- Build /api/upload endpoint that accepts PDF or text files
- Split document into chunks (500 tokens each, 50 token overlap)
- Generate embeddings using OpenAI text-embedding-3-small
- Store chunks + embeddings in Supabase
- Add an "Upload Coding Standards" UI in the dashboard
```

**Day 5-6: Retrieval + augmentation**
```
- When code is submitted for review:
  1. Generate embedding of the code snippet
  2. Query pgvector for top 5 most relevant standard chunks
  3. Inject retrieved chunks into system prompt as "Your team's coding standards:"
  4. Review is now personalized to the team's actual rules
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

**Day 1-2: Auth with NextAuth + GitHub OAuth**
```
- Set up NextAuth.js v5 with GitHub provider
- Store user in Prisma (id, name, email, githubToken, plan)
- Protect all API routes with session check
- Add sign in / sign out to the UI
- Test: sign in, verify user is created in DB
```

**Day 3: Usage limits**
```
- Add reviewCount and reviewResetDate to user schema
- Middleware that checks usage before processing a review
- Show usage counter in the UI: "7 of 10 reviews used this month"
- Cron job (Vercel cron) to reset counts monthly
```

**Day 4-5: Stripe integration**
```
- Set up Stripe products and prices
- Build /api/stripe/checkout — creates a Stripe Checkout session
- Build /api/stripe/webhook — handles payment events, updates user plan
- Add "Upgrade to Pro" button that redirects to Stripe Checkout
- Test with Stripe test mode: complete a payment, verify plan updates
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

**Day 3: Rate limiting**
```
- Install @upstash/ratelimit + Vercel KV (or Redis)
- Limit: 10 requests/minute per user on the review API
- Limit: 100 requests/minute globally
- Return proper 429 errors with retry-after headers
- Show user-friendly "slow down" message in UI
```

**Day 4: Error handling + retry logic**
```
- Wrap all LLM calls in try/catch with specific error types
- Retry on rate limit errors (exponential backoff)
- Fallback to Groq if OpenAI fails (Vercel AI SDK makes this easy)
- Never show raw errors to users — map them to friendly messages
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

## Folder Structure

This is what the final project folder looks like. Follow this from day one — don't reorganize later.

```
reviewai/
├── app/
│   ├── (auth)/
│   │   ├── login/
│   │   │   └── page.tsx
│   │   └── layout.tsx
│   ├── (dashboard)/
│   │   ├── dashboard/
│   │   │   └── page.tsx
│   │   ├── review/
│   │   │   ├── [id]/
│   │   │   │   └── page.tsx
│   │   │   └── new/
│   │   │       └── page.tsx
│   │   ├── history/
│   │   │   └── page.tsx
│   │   ├── settings/
│   │   │   └── page.tsx
│   │   └── layout.tsx
│   ├── api/
│   │   ├── chat/
│   │   │   └── route.ts          ← streaming review endpoint
│   │   ├── review/
│   │   │   └── route.ts          ← structured review endpoint
│   │   ├── upload/
│   │   │   └── route.ts          ← coding standards upload
│   │   ├── stripe/
│   │   │   ├── checkout/
│   │   │   │   └── route.ts
│   │   │   └── webhook/
│   │   │       └── route.ts
│   │   └── auth/
│   │       └── [...nextauth]/
│   │           └── route.ts
│   ├── layout.tsx
│   └── page.tsx                  ← landing page
├── components/
│   ├── ui/                       ← shadcn components (auto-generated)
│   ├── review/
│   │   ├── CodeEditor.tsx
│   │   ├── ReviewCard.tsx
│   │   ├── IssueCard.tsx
│   │   ├── ReviewStream.tsx
│   │   └── SeverityBadge.tsx
│   ├── dashboard/
│   │   ├── ReviewHistory.tsx
│   │   ├── UsageStats.tsx
│   │   └── TrendChart.tsx
│   └── shared/
│       ├── Header.tsx
│       └── Sidebar.tsx
├── lib/
│   ├── ai/
│   │   ├── prompts.ts            ← all system prompts live here
│   │   ├── tools.ts              ← tool definitions
│   │   ├── schemas.ts            ← Zod schemas for structured output
│   │   └── embeddings.ts        ← embedding + RAG logic
│   ├── db/
│   │   └── prisma.ts            ← Prisma client singleton
│   ├── github/
│   │   └── api.ts               ← GitHub API helpers
│   ├── stripe/
│   │   └── index.ts             ← Stripe helpers
│   └── utils.ts
├── prisma/
│   └── schema.prisma
├── types/
│   └── index.ts                 ← shared TypeScript types
├── .env.local
├── .env.example
└── README.md
```

---

## Environment Variables

Copy this to `.env.example` and commit it. Never commit `.env.local`.

```bash
# AI Providers
OPENAI_API_KEY=
GROQ_API_KEY=

# Observability
HELICONE_API_KEY=

# Database (Supabase)
DATABASE_URL=
DIRECT_URL=

# Auth (NextAuth)
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=

# GitHub OAuth (create at github.com/settings/developers)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRO_PRICE_ID=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
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
> You made deliberate choices — Next.js for the AI SDK integration, Supabase for pgvector + auth + DB in one, Vercel AI SDK for provider abstraction. You can justify each one.

---

*Last updated: Week 0 (before start)*  
*Update this document as you make architectural decisions that differ from the plan.*
