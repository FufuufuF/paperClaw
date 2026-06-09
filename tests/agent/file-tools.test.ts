import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createToolContext,
  ToolRegistry,
} from '../../packages/core/src/index.js';
import { KnowledgeGraphStore } from '../../packages/knowledge/src/index.js';
import { createPaperFileTools, type NoteListing } from '../../packages/reader/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

async function makeRegistry(dir: string): Promise<{ registry: ToolRegistry; outputDir: string }> {
  const outputDir = join(dir, 'output');
  await mkdir(outputDir, { recursive: true });
  const registry = new ToolRegistry(
    createPaperFileTools(),
    createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }),
  );
  return { registry, outputDir };
}

async function testCreateListReadAndSectionEdit(): Promise<void> {
  await withTempDir(async (dir) => {
    const { registry, outputDir } = await makeRegistry(dir);
    const created = await registry.execute('create_note', {
      runId: 'run-1',
      slug: 'agent-harness',
      title: 'Agent Harness',
    });
    assert(created.success === true, 'create_note succeeds');

    const edit = await registry.execute('edit_note_section', {
      slug: 'agent-harness',
      heading: 'Verdict',
      content: 'adopt: useful for harness design.',
    });
    assert(edit.success === true, 'edit_note_section succeeds');
    assert(Boolean((edit.data as { backupPath?: string }).backupPath), 'edit_note_section creates backup');

    const append = await registry.execute('append_note_section', {
      slug: 'agent-harness',
      heading: 'Verdict',
      content: 'Follow-up: compare with local traces.',
    });
    assert(append.success === true, 'append_note_section succeeds');

    const read = await registry.execute('read_note', { slug: 'agent-harness' });
    const content = (read.data as { content: string }).content;
    assert(content.includes('adopt: useful'), 'read_note sees replaced section content');
    assert(content.includes('Follow-up'), 'read_note sees appended content');

    const listed = await registry.execute('list_notes', {});
    const notes = (listed.data as { notes: NoteListing[] }).notes;
    assert(notes.length === 1, 'list_notes finds created note');
    assert(notes[0]!.path === resolve(outputDir, 'run-1/papers/agent-harness.md'), 'list_notes returns absolute path');
  });
}

async function testProfileUpdateAndRename(): Promise<void> {
  await withTempDir(async (dir) => {
    const { registry, outputDir } = await makeRegistry(dir);
    await registry.execute('create_note', {
      runId: 'run-1',
      slug: 'old-slug',
      title: 'Old Slug',
    });
    const profile = await registry.execute('update_profile_section', {
      heading: '已读索引',
      content: '- [[old-slug]] Old Slug',
    });
    assert(profile.success === true, 'update_profile_section succeeds');
    const profileText = await readFile(join(outputDir, 'profile.md'), 'utf8');
    assert(profileText.includes('[[old-slug]]'), 'profile section was written');

    const kg = new KnowledgeGraphStore({ outputDir });
    await kg.upsertNode({
      id: 'old-slug',
      title: 'Old Slug',
      note_path: join(outputDir, 'run-1/papers/old-slug.md'),
      status: 'reading',
      verdict: 'maybe',
    });

    const renamed = await registry.execute('rename_note_slug', {
      slug: 'old-slug',
      newSlug: 'new-slug',
    });
    assert(renamed.success === true, 'rename_note_slug succeeds');
    const noteText = await readFile(join(outputDir, 'run-1/papers/new-slug.md'), 'utf8');
    assert(noteText.includes('slug: new-slug'), 'rename_note_slug updates slug line');
    assert((renamed.data as { knowledgeNodeRenamed?: boolean }).knowledgeNodeRenamed === true, 'rename_note_slug reports knowledge node rename');
    const oldNode = await kg.getNode('old-slug');
    const newNode = await kg.getNode('new-slug');
    assert(oldNode === null, 'rename_note_slug removes old knowledge node id');
    assert(newNode?.note_path === join(outputDir, 'run-1/papers/new-slug.md'), 'rename_note_slug updates knowledge note_path');
  });
}

async function testGuardRejectsEscapesAndSymlinks(): Promise<void> {
  await withTempDir(async (dir) => {
    const { registry, outputDir } = await makeRegistry(dir);
    const outside = join(dir, 'outside.md');
    await writeFile(outside, '# outside', 'utf8');
    await mkdir(join(outputDir, 'run-1', 'papers'), { recursive: true });
    await symlink(outside, join(outputDir, 'run-1', 'papers', 'escape.md'));

    const badProfile = await registry.execute('update_profile_section', {
      heading: 'X',
      content: 'Y',
      path: '../outside.md',
    });
    assert(badProfile.success === true, 'profile tool ignores arbitrary path and writes only profile.md');

    const badCreate = await registry.execute('create_note', {
      runId: '../bad',
      slug: 'x',
      title: 'X',
    });
    assert(badCreate.success === true, 'create_note sanitizes runId instead of escaping');

    const symlinkRead = await registry.execute('read_note', {
      path: 'run-1/papers/escape.md',
    });
    assert(symlinkRead.success === false, 'read_note rejects symlink escape');

    const directEscape = await registry.execute('read_note', {
      path: '../outside.md',
    });
    assert(directEscape.success === false, 'read_note rejects path traversal');
  });
}

async function testReadNoteUsesNewestDuplicateSlug(): Promise<void> {
  await withTempDir(async (dir) => {
    const { registry, outputDir } = await makeRegistry(dir);
    await mkdir(join(outputDir, 'old-run', 'papers'), { recursive: true });
    await mkdir(join(outputDir, 'new-run', 'papers'), { recursive: true });
    await writeFile(join(outputDir, 'old-run', 'papers', 'same-slug.md'), '# Old\n\nold content\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(join(outputDir, 'new-run', 'papers', 'same-slug.md'), '# New\n\nnew content\n', 'utf8');

    const read = await registry.execute('read_note', { slug: 'same-slug' });
    const content = (read.data as { content: string }).content;
    assert(content.includes('new content'), 'read_note resolves duplicate slug to newest note');
  });
}

async function main(): Promise<void> {
  await testCreateListReadAndSectionEdit();
  await testProfileUpdateAndRename();
  await testGuardRejectsEscapesAndSymlinks();
  await testReadNoteUsesNewestDuplicateSlug();
  console.log('✓ file tools tests passed.');
}

void main().catch((err) => {
  console.error('✗ file tools tests failed:', err);
  process.exit(1);
});
