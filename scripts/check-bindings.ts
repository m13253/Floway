// Pre-deploy gate: refuse to build/deploy when wrangler.jsonc does not declare
// every Cloudflare binding the Worker depends on. The runtime also fails fast
// on missing bindings, but a 503 from a freshly published deploy is worse than
// a non-zero exit before publish, so we duplicate the check here.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');

interface BindingEntry {
  binding?: string;
}

interface WranglerConfig {
  d1_databases?: BindingEntry[];
  r2_buckets?: BindingEntry[];
  kv_namespaces?: BindingEntry[];
  images?: BindingEntry;
}

interface RequiredBinding {
  binding: string;
  where: string;
  locate: (config: WranglerConfig) => boolean;
}

const REQUIRED: RequiredBinding[] = [
  { binding: 'DB', where: 'd1_databases[].binding', locate: c => c.d1_databases?.some(e => e.binding === 'DB') ?? false },
  { binding: 'FILES', where: 'r2_buckets[].binding', locate: c => c.r2_buckets?.some(e => e.binding === 'FILES') ?? false },
  { binding: 'IMAGES', where: 'images.binding', locate: c => c.images?.binding === 'IMAGES' },
  { binding: 'KV', where: 'kv_namespaces[].binding', locate: c => c.kv_namespaces?.some(e => e.binding === 'KV') ?? false },
];

const text = await readFile(CONFIG_PATH, 'utf8');
const errors: ParseError[] = [];
const config = parse(text, errors) as WranglerConfig | undefined;
if (errors.length > 0 || config === undefined) {
  console.error(`Failed to parse ${CONFIG_PATH}:`);
  for (const e of errors) console.error(`  ${JSON.stringify(e)}`);
  process.exit(1);
}

const missing = REQUIRED.filter(req => !req.locate(config));
if (missing.length > 0) {
  console.error(`Missing required Cloudflare bindings in ${CONFIG_PATH}:`);
  for (const m of missing) console.error(`  - ${m.binding} (expected at ${m.where})`);
  console.error('See wrangler.example.jsonc for the full configuration.');
  process.exit(1);
}
