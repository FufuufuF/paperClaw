# Guided Reading Main-Agent Refactor Plan

Date: 2026-06-07

## Context

The current guided reader already extracts a PDF, splits it into sections, and stores the long paper text in `output/<run_id>/reader-state/<slug>.json`. However, the first implementation still used a reader sub-agent for every section. That made the main agent mostly a dispatcher and weakened the interactive reading loop.

For ordinary paper reading, the main agent should stay in the conversation: it should load the current section on demand, discuss it with the user, and write notes after the discussion. The clawbot base session and auto-compaction should manage previous conversation/section context.

## Target Architecture

- `read_paper`
  - Extract PDF text.
  - Split the paper into sections.
  - Create `output/<run_id>/reader-state/<slug>.json`.
  - Create a markdown note scaffold with a reading plan.
  - Do not summarize the whole paper.
  - Do not call a sub-agent.

- `read_paper_section`
  - Read one section from the reader-state JSON.
  - Return section text and nearby section metadata to the main agent.
  - Do not call a sub-agent.
  - Do not write notes.
  - Let the normal clawbot session contain the current section being discussed; older context is handled by base compaction.

- `record_paper_section_note`
  - Persist a section note after the main agent/user have discussed a section.
  - Update the markdown note under `## Section Notes`.
  - Mark the section as done in the reading plan and reader-state JSON.
  - Update `profile.md` only when all sections are done.

- Sub-agent usage
  - Not used for normal section-by-section reading.
  - Reserved for future synthesis tasks, such as summarizing all section notes, producing a whole-paper review, or parallel multi-paper analysis.

## Memory Boundaries

- Main clawbot session:
  - Stores user conversation, tool calls/results, current section discussion, and short note-writing actions.
  - Uses the base session compaction mechanism.

- Reader-state JSON:
  - Stores long PDF-derived section text and reading progress.
  - Acts as the paper-content index for tools.

- Markdown note:
  - Stores durable user-facing notes.
  - Accumulates section notes incrementally.

- Sub-agent:
  - Temporary, no persistent session.
  - Not part of ordinary guided reading after this refactor.

## Acceptance Criteria

- Starting guided reading still creates note scaffold and reader-state JSON.
- Reading a section returns section text to the main agent and does not call the LLM internally.
- Reading a section does not write to the note by itself.
- Recording a section note updates both note and state.
- Profile updates happen only after all sections are marked done.
- Tests cover the new separation between reading section content and recording notes.
