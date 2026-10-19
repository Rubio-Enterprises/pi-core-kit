import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const projectRoot = join(import.meta.dir, '..');
const reportPath = join(projectRoot, 'reports', 'unit', 'junit.xml');

mkdirSync(dirname(reportPath), { recursive: true });
rmSync(reportPath, { force: true });

const result = Bun.spawnSync({
  cmd: ['bun', 'test', 'tests', '--reporter=junit', '--reporter-outfile', reportPath],
  cwd: projectRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}

const report = readFileSync(reportPath, 'utf8');
const testCount = report.match(/<testcase\b/g)?.length ?? 0;
if (testCount === 0) {
  throw new Error('Bun completed without executing any tests');
}

const countOutput = process.env.RUBIO_TEST_GATE_COUNT_OUTPUT;
if (countOutput) {
  mkdirSync(dirname(countOutput), { recursive: true });
  writeFileSync(countOutput, `${testCount}\n`, 'utf8');
}
