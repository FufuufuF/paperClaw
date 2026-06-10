# core / business boundary migration plan

> Created: 2026-06-09
> Status: implemented baseline; future cleanup may continue
> Trigger: `packages/core/src` should be the clawbot base, but paperClaw business code has leaked into it.

---

## 0. Decision

`packages/core` should mean "clawbot base" only. It should not know about papers, arXiv, PDFs, paper notes, paper profiles, or paper knowledge graphs.

Business capabilities should be mounted from outside core, by a composition layer such as `packages/cli` or a future `packages/app`. The base should expose stable extension points:

- `ToolRegistry` for executable tools.
- `SkillsLoader` / skill directories for LLM-facing operating instructions.
- `CommandRouter` for slash commands.
- `AgentLoop` / `AgentRunner` for the tool-use loop.
- `Channel`, `SessionStore`, `LLMClient`, `TraceBus`, config, security, and utilities.

The current explicit registration style is good: business packages export tool factories, and the application layer registers those tools into the base. The problem is not the injection style; the problem is that some business factories and business storage models still live inside core.

---

## 1. Current Leakage

These files/directories are business-specific and should not remain in pure core:

- `packages/core/src/knowledge/*`
  - Models paper nodes, paper links, pending paper relation candidates, and a paper knowledge index.
- `packages/core/src/agent/tools/knowledge-tools.ts`
  - Exposes `kg_*` paper knowledge graph tools.
  - Uses `paper-read` scopes.
- `packages/core/src/agent/tools/file-tools.ts`
  - Exposes paper note tools such as `list_notes`, `read_note`, `create_note`, and note section editing.
  - Mentions `output/**/papers/*.md`.
- `packages/core/src/skills/paper-search/SKILL.md`
- `packages/core/src/skills/paper-read/SKILL.md`
- `packages/core/src/skills/knowledge-consolidation/SKILL.md`
- `packages/core/src/skills/profile/SKILL.md`
  - These are LLM-facing business instructions, not base instructions.
- `packages/core/src/agent/memory.ts`
  - Reads `output/profile.md` and parses a paper-specific "read index".
- Some builtin commands in `packages/core/src/command/builtin.ts`
  - `/papers` and `/profile` are paperClaw application commands, not clawbot base commands.
- `packages/core/src/index.ts`
  - Re-exports business APIs such as `createPaperFileTools`, `createKnowledgeGraphTools`, and `knowledge/*`.

---

## 2. Target Boundaries

### `packages/core`

Owns the generic base:

- agent runtime: `AgentLoop`, `AgentRunner`, `ContextBuilder`, subagent primitive.
- tool runtime: `Tool`, `ToolRegistry`, schema validation, `ToolContext`.
- prompt and skill loading mechanism, but not paper-specific built-in skills.
- session, command router, channels, bus, cron scheduler, provider abstraction, config, trace, security, utility helpers.

Core may expose generic helpers that business packages can reuse, but names and behavior should stay domain-neutral.

### `packages/search`

Owns paper search behavior:

- arXiv API access.
- search query planning and replanning.
- paper triage.
- PDF download from search results.
- `createPaperSearchTools()`.
- paper-search skill instructions.

### `packages/reader`

Owns paper reading behavior:

- PDF text extraction.
- section splitting.
- guided reading state.
- note scaffold and section note recording.
- profile updates derived from reading.
- `createReaderTools()`.
- paper-read skill instructions.

### Future `packages/knowledge` or `packages/paper-knowledge`

Recommended owner for:

- paper knowledge graph store.
- `kg_*` tools.
- knowledge-consolidation skill.

This should be separate if the knowledge graph is independently valuable. It can depend on core for tool types and filesystem guards, and reader/search can integrate with it at the application layer.

Implementation note: this migration introduced `packages/knowledge` as `@paperclaw/knowledge`.

### `packages/profile`

Owns the paperClaw reading profile reader and profile skill instructions shared by search, reader, and CLI composition.

Implementation note: this migration introduced `packages/profile` as `@paperclaw/profile` so `packages/search` does not need to depend on `packages/reader` just to parse `output/profile.md`.

### `packages/cli` or future `packages/app`

Owns composition:

- Create `LLMClient`, `TraceBus`, `SessionStore`, `ToolRegistry`, channels, commands, cron jobs.
- Register base tools and business tools.
- Choose skill directories.
- Wire search/reader/knowledge/profile behavior together.

---

## 3. Business Injection Model

Business features enter clawbot through three explicit channels:

1. **Tools**
   - Business package exports `createXTools(opts): Tool[]`.
   - App layer calls the factory and registers each tool with `ToolRegistry`.
   - `AgentRunner` sends registered tool schemas to the LLM and dispatches tool calls back through the registry.

2. **Skills**
   - Business package or workspace provides `SKILL.md` files.
   - `ContextBuilder` / `SkillsLoader` includes active skill content and skill summaries in the system prompt.
   - Skills tell the LLM when and how to use mounted tools.

3. **Commands / scheduled jobs**
   - App layer registers business slash commands and cron handlers.
   - These commands may call business tools through the registry or call business services directly.

This keeps core generic: core does not import `@paperclaw/reader` or `@paperclaw/search`; the app imports both core and business packages.

---

## 4. Migration Sequence

### Phase 1: Stop adding new leakage

- Do not add new paper-specific files under `packages/core/src`.
- New paper behavior should land under `packages/search`, `packages/reader`, or a new business package.
- New exports from `@paperclaw/core` should be checked for domain neutrality.

### Phase 2: Move skills out of core

- Move paper skills from `packages/core/src/skills` into business-owned skill directories.
- Update composition code to pass those directories to `SkillsLoader` or add a multi-root skill loader.
- Keep `SkillsLoader` itself in core.

Why first: this has low runtime risk and clarifies the mental model quickly.

### Phase 3: Move paper file/profile commands

- Move `createPaperFileTools()` out of core.
- Move paper profile parsing/updating out of core.
- Move `/papers` and `/profile` registration out of core builtin commands and into app/business command registration.

Why next: these are surface-level paper features and do not require changing the runner.

### Phase 4: Move knowledge graph

- Create `packages/knowledge` or `packages/paper-knowledge`.
- Move `knowledge/*` and `agent/tools/knowledge-tools.ts`.
- Export `createKnowledgeGraphTools()` from that package.
- Update CLI composition to import and register from the new package.

Why later: knowledge graph touches tests, file tools, reader integration, and recommendation context.

### Phase 5: Tighten core public API

- Remove business exports from `packages/core/src/index.ts`.
- Keep compatibility shims only if needed for a short transition.
- Add a dependency rule: business packages may depend on core; core must not depend on business packages.

---

## 5. Acceptance Criteria

The migration is done when:

- `packages/core/src` contains no paper/arXiv/PDF/note/knowledge-graph business implementation.
- `@paperclaw/core` can be used to build a non-paper clawbot without pulling paperClaw business semantics into prompts, tools, commands, or storage.
- `packages/cli` or app composition still builds the full paperClaw product by registering search, reader, knowledge, profile, and command modules explicitly.
- Tests cover both:
  - core without paper tools.
  - paperClaw composition with business tools mounted.
