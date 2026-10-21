import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dir, '..', 'src');
const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gmu;
/** Third-party libraries an ADR justifies (docs/adr). Never Pi or pi-ui-kit. */
const allowed = /^(?:node:|\.\.?\/|typebox(?:\/|$))/u;

test('source modules import only node: built-ins, sibling modules and justified libraries', () => {
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );
  expect(files.length).toBeGreaterThan(0);
  const violations = files.flatMap((file) =>
    [...readFileSync(join(src, file), 'utf8').matchAll(specifier)]
      .map((match) => match[1] ?? '')
      .filter((name) => !allowed.test(name))
      .map((name) => `${file}: ${name}`),
  );
  expect(violations).toEqual([]);
});

test('every runtime dependency is allowed by the boundary', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
  expect(names.filter((name) => !allowed.test(name))).toEqual([]);
});

test('every export points at a source module', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as {
    exports: Record<string, string>;
  };
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    expect(subpath).toMatch(/^\.\/[a-z][a-z0-9-]*$/u);
    expect(target).toBe(`./src/${subpath.slice(2)}.ts`);
  }
});
