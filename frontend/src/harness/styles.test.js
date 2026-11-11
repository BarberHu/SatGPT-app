import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import config from '../../tailwind.config.cjs';

test('compiled Agent theme and utility rules stay scoped to the Harness app', async () => {
  const file = path.resolve('src/harness/app.css');
  const result = await postcss([tailwind(config)]).process(fs.readFileSync(file, 'utf8'), { from: file });
  const unscoped = [];
  result.root.walkRules(rule => {
    if (rule.parent.type === 'atrule' && rule.parent.name.includes('keyframes')) return;
    if (!rule.selector.trim().startsWith('.harness-app')) unscoped.push(rule.selector);
  });
  expect(unscoped).toEqual([]);
  expect(config.corePlugins.preflight).toBe(false);
});
