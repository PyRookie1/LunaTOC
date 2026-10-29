/** Fail CI when initial-release source accidentally revives earlier product identifiers. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const roots = ['src', 'test', 'docs', 'README.md', 'CHANGELOG.md', 'PRIVACY.md',
  'manifest.json', 'package.json'];
const patterns = [
  [/LunaTOC-SC|luna-toc-sc/gi, 'obsolete project name'],
  [/chatToc|lumaToc|lunaToc:|luna:chatgpt:runtimeConfig/g, 'non-LunaTOC storage namespace'],
  [/LEGACY_CHATGPT_RUNTIME_CONFIG_STORAGE_KEY|chatGptRuntimeConfig|LEGACY_PINNED_STORAGE_PREFIX|getLegacyPageKey|chatTocSidebarPinned|chatTocToggleButtonPosition/g, 'previous-release migration'],
  [/旧版本|旧数据|旧记录：未绑定账号|未绑定（旧数据）/g, 'previous-release product copy'],
  [/\bB0(?:01|33|34)\b/g, 'historical bug number'],
];
const files = [];
function walk(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) walk(join(path, name));
  } else if (['.ts', '.tsx', '.mjs', '.js', '.json', '.md', '.css', '.html'].includes(extname(path))) {
    files.push(path);
  }
}
for (const root of roots) walk(root);
const violations = [];
for (const path of files) {
  const content = readFileSync(path, 'utf8');
  for (const [re, label] of patterns) {
    re.lastIndex = 0;
    if (re.test(content)) violations.push(path + ': ' + label);
  }
}
if (violations.length) {
  console.error('LunaTOC initial-release hygiene check failed:\n' + violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('LunaTOC initial-release hygiene: ' + files.length + ' source and documentation files verified');
}
