import { join } from 'node:path';
import {
  CliSessionController,
  CLI_SESSION_UID_LENGTH,
  initializeCliSession,
} from '../../packages/cli/src/session-controller.js';
import { createNewSession, FileSessionStore } from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

async function testNamedSessionId(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const controller = new CliSessionController(store);
    const created = await controller.createNextId('Agent Memory');

    assert(/^cli:agent-memory:[A-Za-z0-9]{10}$/.test(created.id), `named id has channel:name:uid shape (${created.id})`);
    assert(created.sessionName === 'Agent Memory', 'keeps original display name');
    assert(created.uid.length === CLI_SESSION_UID_LENGTH, 'uid has fixed length');
    assert(created.channel === 'cli', 'records channel');
  });
}

async function testUnnamedSessionId(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const controller = new CliSessionController(store);
    const created = await controller.createNextId();

    assert(/^cli:[A-Za-z0-9]{10}$/.test(created.id), `unnamed id has channel:uid shape (${created.id})`);
    assert(created.sessionName === undefined, 'unnamed session has no display name');
    assert(created.uid.length === CLI_SESSION_UID_LENGTH, 'uid has fixed length');
  });
}

async function testSwitchState(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const controller = new CliSessionController(store);
    assert(controller.current() === 'cli:default', 'default active session is cli:default');
    controller.switchTo('cli:abc123');
    assert(controller.current() === 'cli:abc123', 'switchTo updates active session');
  });
}

async function testAvoidExistingIdCollision(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const controller = new CliSessionController(store);
    const first = await controller.createNextId('topic');
    await store.save(createNewSession(first.id, {
      sessionName: first.sessionName,
      uid: first.uid,
      channel: first.channel,
    }));

    const second = await controller.createNextId('topic');
    assert(second.id !== first.id, 'createNextId avoids existing session ids');
  });
}

async function testInitializeCliSessionCreatesFreshSession(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const controller = new CliSessionController(store);
    const created = await initializeCliSession(controller, store);

    assert(created !== null, 'startup creates a session by default');
    assert(created!.id !== 'cli:default', 'startup session does not use cli:default');
    assert(controller.current() === created!.id, 'startup switches active session to fresh id');
    const saved = await store.load(created!.id);
    assert(saved !== null, 'startup session is persisted immediately');
    assert(saved!.metadata.uid === created!.uid, 'startup session stores uid metadata');
    assert(saved!.metadata.channel === 'cli', 'startup session stores channel metadata');
  });
}

async function testInitializeCliSessionCanReuseDefault(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const controller = new CliSessionController(store);
    const created = await initializeCliSession(controller, store, { reuseDefault: true });

    assert(created === null, 'explicit reuse does not create a startup session');
    assert(controller.current() === 'cli:default', 'explicit reuse keeps default active session');
    assert((await store.list()).length === 0, 'explicit reuse does not write a new session');
  });
}

async function main(): Promise<void> {
  await testNamedSessionId();
  await testUnnamedSessionId();
  await testSwitchState();
  await testAvoidExistingIdCollision();
  await testInitializeCliSessionCreatesFreshSession();
  await testInitializeCliSessionCanReuseDefault();
  console.log('✓ cli session controller tests passed.');
}

void main();
