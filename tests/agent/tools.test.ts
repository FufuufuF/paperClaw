import {
  addTool,
  createToolContext,
  echoTool,
  ToolRegistry,
  type Tool,
} from '../../packages/core/src/index.js';
import { assert } from '../fixtures/index.js';

async function testSchemaCastAndValidate(): Promise<void> {
  const registry = new ToolRegistry([addTool]);
  const prepared = registry.prepareCall('add', '{"a":"3","b":"4"}');
  assert(prepared.error === null, 'valid numeric strings are cast');
  assert(prepared.args.a === 3 && prepared.args.b === 4, 'number args cast');

  const bad = registry.prepareCall('add', '{"a":"nope","b":4}');
  assert(bad.error !== null, 'invalid number fails validation');
  assert(bad.error!.includes('a should be number'), 'validation error names field');
}

async function testExecuteUsesCastArgs(): Promise<void> {
  const registry = new ToolRegistry([addTool]);
  const result = await registry.execute('add', '{"a":"3","b":"4"}');
  assert(result.success === true, 'execute succeeds after cast');
  assert((result.data as { result: number }).result === 7, 'execute receives cast args');
}

async function testBadJsonAndUnknownTool(): Promise<void> {
  const registry = new ToolRegistry([echoTool]);
  const badJson = await registry.execute('echo', '{bad json');
  assert(badJson.success === false, 'bad JSON returns tool result failure');
  assert(String((badJson.data as { error: string }).error).includes('JSON parse error'), 'bad JSON reports parse error');

  const unknown = await registry.execute('missing', '{}');
  assert(unknown.success === false, 'unknown tool returns failure');
  assert(String((unknown.data as { error: string }).error).includes('Available: echo'), 'unknown tool lists available tools');
}

async function testObjectSchemaDetails(): Promise<void> {
  const chooseTool: Tool = {
    name: 'choose',
    description: 'test enum and arrays',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'] },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        flags: { type: 'array', minItems: 1, items: { type: 'boolean' } },
      },
      required: ['mode', 'count', 'flags'],
    },
    async execute(args) {
      return { success: true, data: args };
    },
  };
  const registry = new ToolRegistry([chooseTool]);
  const prepared = registry.prepareCall('choose', { mode: 'fast', count: '2', flags: ['true', false] });
  assert(prepared.error === null, 'integer and boolean array values are cast');
  assert(prepared.args.count === 2, 'integer is cast');
  assert(Array.isArray(prepared.args.flags) && prepared.args.flags[0] === true, 'array item is cast');

  const bad = registry.prepareCall('choose', { mode: 'medium', count: 5, flags: [] });
  assert(bad.error !== null, 'enum/range/array validation fails');
  assert(bad.error!.includes('mode must be one of'), 'enum error present');
  assert(bad.error!.includes('count must be <='), 'range error present');
  assert(bad.error!.includes('flags must have at least'), 'array error present');
}

async function testScopeAndContext(): Promise<void> {
  const seen: Array<string | undefined> = [];
  const ctx = createToolContext({ workspace: '/tmp/workspace', outputDir: '/tmp/out', timezone: 'Asia/Shanghai' });
  const ctxTool: Tool = {
    name: 'ctx',
    description: 'reads context',
    scopes: ['subagent'],
    parameters: { type: 'object', properties: {} },
    async execute(_args, toolCtx) {
      seen.push(toolCtx?.workspace);
      return { success: true, data: { workspace: toolCtx?.workspace } };
    },
  };
  const registry = new ToolRegistry([echoTool, ctxTool], ctx);
  const sub = registry.scopeByTag('subagent');
  assert(sub.has('ctx'), 'scopeByTag keeps matching scoped tool');
  assert(!sub.has('echo'), 'scopeByTag omits core-only tool');

  const result = await sub.execute('ctx', {});
  assert(result.success === true, 'scoped tool executes');
  assert(seen[0] === '/tmp/workspace', 'tool receives context');
}

async function testStableDefinitions(): Promise<void> {
  const registry = new ToolRegistry([echoTool, addTool]);
  const defs = registry.getToolDefs();
  assert(defs.map((def) => def.name).join(',') === 'add,echo', 'tool definitions are stable sorted');
  assert(registry.concurrencySafe('echo') === true, 'read-only tool is concurrency-safe by default');
}

async function main(): Promise<void> {
  await testSchemaCastAndValidate();
  await testExecuteUsesCastArgs();
  await testBadJsonAndUnknownTool();
  await testObjectSchemaDetails();
  await testScopeAndContext();
  await testStableDefinitions();
  console.log('✓ tool system tests passed.');
}

void main();
