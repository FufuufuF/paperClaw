import { customAlphabet } from 'nanoid';
import { createNewSession, type SessionStore } from '@paperclaw/core';

export const CLI_SESSION_UID_LENGTH = 10;

const makeUid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', CLI_SESSION_UID_LENGTH);

export interface CreatedCliSession {
  id: string;
  sessionName?: string;
  uid: string;
  channel: string;
}

export class CliSessionController {
  private activeSessionId: string;

  constructor(
    private readonly store: SessionStore,
    private readonly channel = 'cli',
    initialSessionId = 'cli:default',
  ) {
    this.activeSessionId = initialSessionId;
  }

  current(): string {
    return this.activeSessionId;
  }

  switchTo(id: string): void {
    this.activeSessionId = id;
  }

  async createNextId(name?: string): Promise<CreatedCliSession> {
    const sessionName = normalizeSessionName(name);
    const slug = slugifySessionName(sessionName);
    for (let attempt = 0; attempt < 8; attempt++) {
      const uid = makeUid();
      const id = slug ? `${this.channel}:${slug}:${uid}` : `${this.channel}:${uid}`;
      if (!(await this.store.load(id))) {
        return {
          id,
          ...(sessionName ? { sessionName } : {}),
          uid,
          channel: this.channel,
        };
      }
    }
    throw new Error('failed to create a unique session id');
  }
}

export interface InitializeCliSessionOpts {
  reuseDefault?: boolean;
  sessionName?: string;
}

export async function initializeCliSession(
  controller: CliSessionController,
  store: SessionStore,
  opts: InitializeCliSessionOpts = {},
): Promise<CreatedCliSession | null> {
  if (opts.reuseDefault) return null;
  const next = await controller.createNextId(opts.sessionName);
  await store.save(createNewSession(next.id, {
    sessionName: next.sessionName,
    uid: next.uid,
    channel: next.channel,
  }));
  controller.switchTo(next.id);
  return next;
}

function normalizeSessionName(name?: string): string | undefined {
  const trimmed = name?.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function slugifySessionName(name?: string): string | undefined {
  if (!name) return undefined;
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || undefined;
}
