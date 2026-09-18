import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const builtPattern = /^(?<base>.+)-node\d+-(?<platform>[a-z]+)-(?<arch>[a-z0-9]+)(?<ext>\.exe)?$/;
const finalPattern =
  /^(?<base>.+)-(?:linux|macos|win|alpine|freebsd)-(?:x64|arm64|armv7)(?:\.exe)?$/;
const targetPattern =
  /^(?:node\d+)?-?(?<platform>alpine|linux|macos|win|freebsd)-(?<arch>x64|arm64|armv7)$/;

function singleTargetFromEnv() {
  const raw = process.env.PKG_TARGETS;
  if (raw === undefined) {
    return null;
  }
  const targets = raw
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
  if (targets.length !== 1) {
    return null;
  }
  return targetPattern.exec(targets[0])?.groups ?? null;
}

const singleTarget = singleTargetFromEnv();
let renamed = 0;
let alreadyFinal = 0;

for (const tool of readdirSync('tools')) {
  const binDir = join('tools', tool, 'bin');
  let entries;
  try {
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const built = builtPattern.exec(entry.name);
    if (built !== null) {
      const { base, platform, arch, ext } = built.groups;
      const finalName = `${base}-${platform}-${arch}${ext ?? ''}`;
      renameSync(join(binDir, entry.name), join(binDir, finalName));
      console.log(`${join(binDir, entry.name)} -> ${join(binDir, finalName)}`);
      renamed += 1;
      continue;
    }
    if (finalPattern.test(entry.name)) {
      alreadyFinal += 1;
      continue;
    }
    if (singleTarget !== null && entry.name === tool) {
      const ext = singleTarget.platform === 'win' ? '.exe' : '';
      const finalName = `${entry.name}-${singleTarget.platform}-${singleTarget.arch}${ext}`;
      renameSync(join(binDir, entry.name), join(binDir, finalName));
      console.log(`${join(binDir, entry.name)} -> ${join(binDir, finalName)}`);
      renamed += 1;
    }
  }
}

if (renamed === 0 && alreadyFinal === 0) {
  console.error('no pkg binaries found under tools/*/bin');
  process.exit(1);
}
console.log(
  `renamed ${renamed} ${renamed === 1 ? 'binary' : 'binaries'}, ${alreadyFinal} already final`,
);
