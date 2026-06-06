import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ContextBuilder,
  createNewSession,
  echoTool,
  SkillsLoader,
  ToolRegistry,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

async function testWorkspaceSkillOverridesBuiltin(): Promise<void> {
  await withTempDir(async (dir) => {
    const builtin = join(dir, 'builtin');
    const workspace = join(dir, 'workspace');
    await mkdir(join(builtin, 'same'), { recursive: true });
    await mkdir(join(workspace, 'skills', 'same'), { recursive: true });
    await mkdir(join(builtin, 'builtin-only'), { recursive: true });
    await writeFile(join(builtin, 'same', 'SKILL.md'), '---\ndescription: builtin\nalways: true\n---\n# Builtin', 'utf8');
    await writeFile(join(workspace, 'skills', 'same', 'SKILL.md'), '---\ndescription: workspace\nalways: true\n---\n# Workspace', 'utf8');
    await writeFile(join(builtin, 'builtin-only', 'SKILL.md'), '---\ndescription: only\n---\n# Only', 'utf8');

    const loader = new SkillsLoader({ workspace, builtinSkillsDir: builtin });
    const skills = loader.listSkills(false);
    assert(skills.length === 2, `workspace override keeps two skills (got ${skills.length})`);
    assert(skills.find((skill) => skill.name === 'same')?.source === 'workspace', 'workspace skill overrides builtin');
    assert(loader.loadSkillsForContext(['same']).includes('# Workspace'), 'loads workspace skill content');
  });
}

async function testDisabledAndAlwaysSkills(): Promise<void> {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'always'), { recursive: true });
    await mkdir(join(dir, 'disabled'), { recursive: true });
    await writeFile(join(dir, 'always', 'SKILL.md'), '---\ndescription: always\nalways: true\n---\n# Always', 'utf8');
    await writeFile(join(dir, 'disabled', 'SKILL.md'), '---\ndescription: disabled\nalways: true\n---\n# Disabled', 'utf8');

    const loader = new SkillsLoader({ builtinSkillsDir: dir, disabledSkills: ['disabled'] });
    assert(loader.getAlwaysSkills().join(',') === 'always', 'disabled always skill is hidden');
    assert(!loader.buildSkillsSummary().includes('disabled'), 'disabled skill omitted from summary');
  });
}

async function testSystemPromptIncludesRuntimeContextBlocksAndSkills(): Promise<void> {
  await withTempDir(async (dir) => {
    const skillsDir = join(dir, 'skills-src');
    await mkdir(join(skillsDir, 'profile'), { recursive: true });
    await writeFile(
      join(skillsDir, 'profile', 'SKILL.md'),
      '---\ndescription: profile skill\nalways: true\n---\n# Profile Skill Body',
      'utf8',
    );
    const builder = new ContextBuilder({
      workspace: dir,
      timezone: 'Asia/Shanghai',
      skillLoader: new SkillsLoader({ builtinSkillsDir: skillsDir }),
      contextBlocks: [{ title: 'Memory Context', content: 'Long-term memory: enabled' }],
    });
    const prompt = builder.buildSystemPrompt(new ToolRegistry([echoTool]), { channel: 'cli' });
    assert(prompt.includes('当前 workspace'), 'prompt includes workspace section');
    assert(prompt.includes('Memory Context'), 'prompt includes generic context block');
    assert(prompt.includes('Profile Skill Body'), 'prompt includes always skill body');
    assert(prompt.includes('echo'), 'prompt includes tool listing');
  });
}

async function testActiveSkillNames(): Promise<void> {
  await withTempDir(async (dir) => {
    const skillsDir = join(dir, 'skills-src');
    await mkdir(join(skillsDir, 'extra'), { recursive: true });
    await writeFile(
      join(skillsDir, 'extra', 'SKILL.md'),
      '---\ndescription: extra skill\n---\n# Extra Skill Body',
      'utf8',
    );
    const builder = new ContextBuilder({
      workspace: dir,
      skillLoader: new SkillsLoader({ builtinSkillsDir: skillsDir }),
    });
    const prompt = builder.buildSystemPrompt(new ToolRegistry(), { activeSkillNames: ['extra'] });
    assert(prompt.includes('Extra Skill Body'), 'activeSkillNames loads non-always skill body');
    assert(!prompt.includes('Available Skills\n\n- **extra**'), 'active skill is excluded from available summary');
  });
}

async function testBuildTurnMessagesAddsRuntimeContext(): Promise<void> {
  const builder = new ContextBuilder({ workspace: '/tmp/paperclaw', timezone: 'UTC' });
  const messages = builder.buildTurnMessages({
    history: [{ role: 'user', content: 'previous' }],
    currentMessage: 'current',
    channel: 'cli',
    senderId: 'me',
    sessionId: 'cli:default',
  });
  assert(messages.length === 1, 'consecutive user messages are merged');
  assert(messages[0]!.content.includes('previous'), 'keeps previous user content');
  assert(messages[0]!.content.includes('Runtime Context'), 'adds runtime context');
  assert(messages[0]!.content.includes('Session ID: cli:default'), 'runtime context includes session id');
}

async function testLegacyBuildMessagesStillWorks(): Promise<void> {
  const builder = new ContextBuilder();
  const session = createNewSession('cli:default');
  session.turns.push({ role: 'user', content: 'hello', timestamp: Date.now(), tokenEstimate: 1 });
  const messages = builder.buildSessionMessages(session, 1000);
  assert(messages.length === 1 && messages[0]!.content === 'hello', 'session message builder works');
}

async function main(): Promise<void> {
  await testWorkspaceSkillOverridesBuiltin();
  await testDisabledAndAlwaysSkills();
  await testSystemPromptIncludesRuntimeContextBlocksAndSkills();
  await testActiveSkillNames();
  await testBuildTurnMessagesAddsRuntimeContext();
  await testLegacyBuildMessagesStillWorks();
  console.log('✓ context and skills tests passed.');
}

void main();
