import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

test('both modes ship English UI literals and an English document locale', () => {
  const failures = [];
  const visit = (node, file) => {
    if (!node || typeof node !== 'object') return;
    const text = node.type === 'StringLiteral' || node.type === 'JSXText' ? node.value
      : node.type === 'TemplateElement' ? node.value.raw : '';
    if (/\p{Script=Han}/u.test(text)) failures.push(`${file}:${node.loc.start.line}`);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, file));
      else if (value && typeof value === 'object') visit(value, file);
    }
  };
  const scan = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) scan(file);
      else if (/\.(jsx?|json)$/.test(file) && !file.includes('.test.')) {
        const source = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.json')) { if (/\p{Script=Han}/u.test(source)) failures.push(file); }
        else visit(parse(source, { sourceType: 'module', plugins: ['jsx'] }), file);
      }
    }
  };
  scan(path.resolve('src'));
  expect(failures).toEqual([]);
  const html = fs.readFileSync('index.html', 'utf8');
  expect(html).toContain('<html lang="en">');
  expect(html).toContain('SatGPT Geospatial Assistant');
});
