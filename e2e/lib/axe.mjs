// Automated accessibility scan with axe-core (the engine behind many accessibility checkers), run inside the real page.
// It checks the WCAG 2.0 / 2.1 level A and AA rules plus axe's best-practice rules (landmarks, headings, labels, contrast...).
// It cannot find everything (it does not judge whether wording makes sense), so keyboard use is tested separately.
import { createRequire } from 'node:module';

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

// Returns the violations found on the current page as short readable lines (an empty list means none).
export async function axeViolations(page) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: axeSource });
  const result = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS);
  return result.violations.map((violation) => {
    const where = violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ');
    return `${violation.id} [${violation.impact}] ${violation.help} (${violation.nodes.length} element${violation.nodes.length === 1 ? '' : 's'}: ${where})`;
  });
}
