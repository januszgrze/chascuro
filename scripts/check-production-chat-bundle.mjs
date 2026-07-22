import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const files = await walk(root);
const names = files.map((file) => relative(root, file));

for (const required of [
  'mdk-product-worker',
  'mdk-chat-service',
  'marmot_web_wasi_engine',
]) {
  if (!names.some((name) => name.includes(required))) {
    throw new Error(`Production chat bundle is missing ${required}.`);
  }
}

const forbidden = [
  'FAKE-CHAT-0001',
  'npub1fakechatapplicationboundary',
  'Marisol Vega',
  'fake-chat-service',
];
for (const file of files.filter((entry) =>
  /\.(?:html|js|json)$/u.test(entry),
)) {
  const content = await readFile(file, 'utf8');
  for (const value of forbidden) {
    if (content.includes(value)) {
      throw new Error(
        `Production chat bundle contains forbidden test data: ${value}`,
      );
    }
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return nested.flat();
}
