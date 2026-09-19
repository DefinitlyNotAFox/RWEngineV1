import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = {
  app: readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8'),
  preview: readFileSync(new URL('../v2/intel-v2-preview.css', import.meta.url), 'utf8'),
  share: readFileSync(new URL('../share/share.css', import.meta.url), 'utf8')
};

const expectedScale = {
  caption: 12,
  small: 13,
  body: 14,
  section: 16,
  subtitle: 20,
  title: 24,
  display: 28
};

function readScale(css) {
  return Object.fromEntries(
    [...css.matchAll(/--font-([a-z]+):\s*([0-9.]+)px/g)]
      .map(([, name, size]) => [name, Number(size)])
  );
}

test('main and public pages share one readable typography scale', () => {
  assert.deepEqual(readScale(styles.app), expectedScale);
  assert.deepEqual(readScale(styles.share), expectedScale);
  assert.ok(Math.min(...Object.values(expectedScale)) >= 12);
});

test('site styles use typography tokens instead of one-off pixel sizes', () => {
  for (const [name, css] of Object.entries(styles)) {
    assert.doesNotMatch(
      css,
      /font-size:\s*[0-9.]+px/,
      `${name} contains a one-off font size outside the shared scale`
    );

    for (const [, token] of css.matchAll(/font-size:\s*var\(--font-([a-z]+)\)/g)) {
      assert.ok(token in expectedScale, `${name} uses unknown font token: ${token}`);
    }
  }
});
