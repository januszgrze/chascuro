import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_MDK_REVISION = 'e391adc133a9b60e420da7a0446f014a180ac8d2';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repositoryRoot, 'runtime/marmot-web/Cargo.toml');
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version=1',
      '--locked',
      '--offline',
      '--manifest-path',
      manifestPath,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ),
);
const enginePackage = metadata.packages.find(
  (entry) =>
    entry.name === 'cgka-engine' &&
    entry.version === '0.9.4' &&
    typeof entry.source === 'string' &&
    entry.source.includes(EXPECTED_MDK_REVISION),
);
if (enginePackage === undefined) {
  throw new Error('The exact MDK 0.9.4 Cargo checkout is unavailable.');
}

const mdkRoot = resolve(dirname(enginePackage.manifest_path), '../..');
const actualRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: mdkRoot,
  encoding: 'utf8',
}).trim();
if (actualRevision !== EXPECTED_MDK_REVISION) {
  throw new Error(
    'The native White Noise peer revision does not match MDK 0.9.4.',
  );
}

const targetDirectory =
  process.env.MARMOT_NATIVE_TARGET_DIR ?? '/tmp/mdk-v094-cli-target';
execFileSync(
  'cargo',
  [
    'build',
    '--locked',
    '--manifest-path',
    join(mdkRoot, 'Cargo.toml'),
    '-p',
    'wn-cli',
    '--bins',
    '--target-dir',
    targetDirectory,
  ],
  { cwd: mdkRoot, stdio: 'inherit' },
);

const wn = join(targetDirectory, 'debug', 'wn');
const version = execFileSync(wn, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'wn 0.9.4') {
  throw new Error(
    `The native White Noise peer reported an unexpected version: ${version}`,
  );
}
console.log(
  JSON.stringify({ mdkRevision: actualRevision, targetDirectory, version }),
);
