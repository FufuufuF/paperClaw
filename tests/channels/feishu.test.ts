import {
  FeishuChannel,
  normalizeFeishuEvent,
  toFeishuTextPayload,
} from '../../packages/core/src/index.js';
import { assert } from '../fixtures/index.js';

function feishuTextEvent(text: string, sender = 'ou_user'): Record<string, unknown> {
  return {
    token: 'secret',
    event: {
      sender: { sender_id: { open_id: sender } },
      message: {
        message_id: 'om_1',
        create_time: '1780800000000',
        content: JSON.stringify({ text }),
      },
    },
  };
}

function testNormalizeInbound(): void {
  const normalized = normalizeFeishuEvent(feishuTextEvent('帮我找 agent harness 论文'), {
    verifyToken: 'secret',
    allowedSenderIds: new Set(['ou_user']),
  });
  assert(normalized.message !== null, 'Feishu text event normalizes');
  assert(normalized.message!.senderId === 'feishu:ou_user', 'Feishu sender id is namespaced');
  assert(normalized.message!.text.includes('agent harness'), 'Feishu text content parsed');

  const blocked = normalizeFeishuEvent(feishuTextEvent('hello', 'other'), {
    verifyToken: 'secret',
    allowedSenderIds: new Set(['ou_user']),
  });
  assert(blocked.ignored === 'sender_not_allowed', 'Feishu allowlist blocks unknown sender');

  const badToken = normalizeFeishuEvent(feishuTextEvent('hello'), { verifyToken: 'expected' });
  assert(badToken.ignored === 'token_mismatch', 'Feishu token mismatch is rejected');

  const missingToken = normalizeFeishuEvent({ event: (feishuTextEvent('hello').event) }, { verifyToken: 'secret' });
  assert(missingToken.ignored === 'token_mismatch', 'Feishu missing token is rejected when verifyToken is configured');

  const challenge = normalizeFeishuEvent({ token: 'secret', challenge: 'abc' }, { verifyToken: 'secret' });
  assert(challenge.challenge === 'abc', 'Feishu URL challenge is returned');
}

async function testOutboundWebhookPayload(): Promise<void> {
  const sentBodies: unknown[] = [];
  const channel = new FeishuChannel({
    sendWebhookUrl: 'https://example.invalid/webhook',
    fetchImpl: (async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  await channel.send({ kind: 'tool_hint', text: '正在搜索 arXiv...' });
  assert(channel.getSentMessages().length === 1, 'FeishuChannel records outbound messages');
  assert((sentBodies[0] as { msg_type: string }).msg_type === 'text', 'Feishu webhook uses text message');
  assert(
    (((sentBodies[0] as { content: { text: string } }).content.text).includes('[tool]')),
    'Feishu webhook prefixes tool hints',
  );

  const payload = toFeishuTextPayload({ kind: 'error', text: '失败' }) as { content: { text: string } };
  assert(payload.content.text.startsWith('[error]'), 'error payload is prefixed');
}

async function main(): Promise<void> {
  testNormalizeInbound();
  await testOutboundWebhookPayload();
  console.log('✓ feishu channel tests passed.');
}

void main().catch((err) => {
  console.error('✗ feishu channel tests failed:', err);
  process.exit(1);
});
