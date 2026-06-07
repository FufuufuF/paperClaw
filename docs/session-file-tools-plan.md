# Session Plan: WorkspaceGuard + Paper Note File Tools

> Created: 2026-06-07
> Scope: implement the next required tool layer for maintaining paper notes and profile files.
> Status: Completed in current worktree.

## Goal

Add safe, auditable file tools that let clawbot maintain the local paper notes corpus without exposing a general shell or unrestricted filesystem access.

This is now higher priority than a generic shell tool because the product depends on long-term maintenance of:

- `output/profile.md`
- `output/<run_id>/papers/*.md`
- generated notes and their section structure

## Non-goals

- No unrestricted shell execution.
- No generic file editor for arbitrary workspace files.
- No writes outside `output/`.
- No editing PDF bytes.
- No following symlinks outside the allowed roots.

## Safety Model

Implement `WorkspaceGuard` in core:

- Normalize and resolve all paths before access.
- Allow writes only under `output/`.
- Allow note writes only to `output/**/papers/*.md`.
- Allow profile writes only to `output/profile.md`.
- Allow read-only PDF access under `output/pdfs/*.pdf` if needed later.
- Reject `..` traversal, absolute paths outside output, and symlink escapes.
- Before every write, create a timestamped `.bak.<timestamp>` backup when the target exists.
- Use atomic write (`tmp` + rename) for file replacement.

## Tool Set

Initial tools:

1. `list_notes`
   - Lists markdown notes under `output/**/papers/*.md`.
   - Returns slug, path, title, run id if inferable, and modified time.

2. `read_note`
   - Reads one note by path or slug.
   - Returns content with a configurable max character limit.

3. `edit_note_section`
   - Replaces or creates a markdown section by heading.
   - Writes backup first.
   - Returns changed path, backup path, and summary.

4. `append_note_section`
   - Appends content to a markdown section, creating the section if missing.
   - Writes backup first.

5. `update_profile_section`
   - Replaces or appends a section in `output/profile.md`.
   - Writes backup first.

6. `create_note`
   - Creates `output/<run_id>/papers/<slug>.md`.
   - Fails if it exists unless `overwrite=true`.

7. `rename_note_slug`
   - Renames a note file inside the same `papers/` folder.
   - Updates the note's `slug:` line when present.
   - Does not rewrite backlinks globally in the first version.

Implemented tools:

- `list_notes`
- `read_note`
- `create_note`
- `edit_note_section`
- `append_note_section`
- `update_profile_section`
- `rename_note_slug`

## Shell Tool Position

Do not implement a generic shell tool in this session.

If a shell tool is added later, it should be read-only and whitelist-only (`rg`, `find`, `ls`, `wc`) with output limits. All write operations should continue to go through structured file tools.

## Code Locations

- `packages/core/src/security/workspace-guard.ts`
- `packages/core/src/agent/tools/file-tools.ts`
- `tests/agent/file-tools.test.ts`
- CLI registry in `packages/cli/src/main.ts`

## Acceptance Criteria

- Tools cannot read/write outside the configured `outputDir`.
- Symlink escape is rejected.
- Note tools only write `output/**/papers/*.md`.
- Profile tool only writes `output/profile.md`.
- Existing files are backed up before writes.
- Writes are atomic.
- Section edit preserves unrelated markdown content.
- `pnpm typecheck` and `pnpm test` pass.

## Implementation Evidence

- `packages/core/src/security/workspace-guard.ts`
- `packages/core/src/agent/tools/file-tools.ts`
- `tests/agent/file-tools.test.ts`
- Registered in `packages/cli/src/main.ts`
- Exported from `packages/core/src/index.ts`

Validation run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` currently exits successfully with no package build scripts configured.
