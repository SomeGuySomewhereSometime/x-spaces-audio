import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Build a compatible extension for an embedding app without forking capture code. */
export async function buildExtension(output, { namespace = 'x-spaces-audio', globalName = '__xSpacesAudio', storageKey = 'xSpacesAudio', name = 'X Spaces Audio', version = '0.1.0' } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName) || !/^[A-Za-z][A-Za-z0-9]*$/.test(storageKey)) throw new Error('Invalid extension identifiers.');
  const source = new URL('../extension/', import.meta.url);
  await mkdir(output, { recursive: true });
  for (const filename of ['capture.js', 'relay.js', 'background.js']) {
    const script = await readFile(new URL(filename, source), 'utf8');
    await writeFile(resolve(output, filename), script.replaceAll('x-spaces-audio', namespace).replaceAll('__xSpacesAudio', globalName).replaceAll('xSpacesAudio', storageKey));
  }
  const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
  manifest.name = name;
  manifest.version = version;
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/build-extension.mjs OUTPUT_DIRECTORY');
  await buildExtension(resolve(process.argv[2]));
}
