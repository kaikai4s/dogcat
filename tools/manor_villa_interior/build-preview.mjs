import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export async function writeVillaInteriorPreview(output, binary) {
  const [template, license] = await Promise.all([
    readFile(join(here, 'viewer.html'), 'utf8'),
    readFile(resolve(dirname(require.resolve('three')), '../LICENSE'), 'utf8'),
  ]);
  const runtime = await rolldown({
    cwd: resolve(here, '../..'),
    input: join(here, '../manor_villa_review/scene-runtime.mjs'),
    platform: 'browser',
    logLevel: 'warn',
  });
  try {
    const bundle = await runtime.generate({ format: 'iife', minify: true, comments: { legal: true } });
    const script = bundle.output[0].code.replace(/<\/script/gi, '<\\/script');
    // Include a snapshot of the exported GLB so a local HTML file needs no fetch or server.
    const html = template.replace('<!-- THREE LICENSE -->', () => `<!--\n${license}\n-->`)
      .replace('/* INLINE RUNTIME */', () => script)
      .replace('>INLINE_MODEL</script>', () => `>${binary.toString('base64')}</script>`);
    await writeFile(join(output, 'preview.html'), html);
  } finally {
    await runtime.close();
  }
}
