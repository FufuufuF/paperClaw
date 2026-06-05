import type { Tool } from './types.js';

/**
 * Demo tools — 用于验证基座 AC1~AC6. 这些不属于产品功能, 单纯是
 * "把 ToolRegistry / runToolLoop / context compaction 跑起来" 的最小依赖.
 *
 * 按 nanobot 风格, tool demo 住在 agent/tools 下, 不挂在具体 channel 包里.
 */

/** AC2: 简单 echo, 验证 single tool 调用链通畅 */
export const echoTool: Tool = {
  name: 'echo',
  description: '回显用户给的字符串. 仅用于测试.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要回显的内容' },
    },
    required: ['text'],
  },
  async execute(args) {
    const text = String(args.text ?? '');
    return {
      success: true,
      data: { text },
      summary: `echo: ${text.slice(0, 60)}`,
    };
  },
};

/** AC3: add — 验证多轮 tool 调用 */
export const addTool: Tool = {
  name: 'add',
  description: '两个数相加, 返回 a+b.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
  },
  async execute(args) {
    const a = Number(args.a);
    const b = Number(args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { success: false, data: { error: 'a/b 必须是数字' }, summary: 'add 参数错误' };
    }
    return { success: true, data: { result: a + b }, summary: `${a}+${b}=${a + b}` };
  },
};

/** AC3: multiply — 配合 add 验证两步 tool chain */
export const multiplyTool: Tool = {
  name: 'multiply',
  description: '两个数相乘, 返回 a*b.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
  },
  async execute(args) {
    const a = Number(args.a);
    const b = Number(args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { success: false, data: { error: 'a/b 必须是数字' }, summary: 'multiply 参数错误' };
    }
    return { success: true, data: { result: a * b }, summary: `${a}*${b}=${a * b}` };
  },
};

/**
 * AC6: big_tool — 返回大量文本以验证 context compaction.
 * `tag` 让多次调用能在 transcript 里区分 (compaction 后只剩 summary).
 */
export const bigTool: Tool = {
  name: 'big_tool',
  description: '返回一段超过 2000 字符的占位文本, 用于测试 context compaction.',
  parameters: {
    type: 'object',
    properties: {
      tag: { type: 'string', description: '本次调用的标记, 帮助区分多次调用' },
    },
    required: ['tag'],
  },
  async execute(args) {
    const tag = String(args.tag ?? 'untagged');
    const block = '这是一段用来撑满 context 的测试文本. '.repeat(80);
    const text = `[big_tool tag=${tag}] ${block}`;
    return {
      success: true,
      data: { tag, text, length: text.length },
      summary: `big_tool tag=${tag} 返回 ${text.length} chars`,
    };
  },
};

export const allDemoTools: Tool[] = [echoTool, addTool, multiplyTool, bigTool];
