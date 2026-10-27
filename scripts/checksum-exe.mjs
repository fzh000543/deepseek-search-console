import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const file = resolve('release', 'DeepSeek-Search-Console.exe');
const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
const target = `${file}.sha256`;
writeFileSync(target, `${hash}  ${basename(file)}\n`, 'utf8');
console.log(`${hash}  ${basename(file)}`);