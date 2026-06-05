import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Render a bundled markdown template under `core/src/templates/`.
 *
 * 参考 nanobot 的 `utils/prompt_templates.py`: prompt 文本住在 templates/,
 * TypeScript 代码只负责读取 + 插值, 不再把长模板堆进 .ts 文件.
 */
export function renderTemplate(path: string, vars: Record<string, string> = {}): string {
  const abs = join(SRC_ROOT, 'templates', path);
  let text = readFileSync(abs, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, value);
  }
  return text.trim();
}
