// Quick test: run Puppeteer variant sweep on a single product URL
// Usage: node test-variant.js
const puppeteer = require('puppeteer');

const URL = 'https://shop.harvestlanefarmmarket.com/product/meadow-view-raw-milk/2615';

const PRICE_RE       = /[$€£¥]\s*\d[\d.,]*/;
const PRICE_RANGE_RE = /[$€£¥]\s*\d[\d.,]*\s*[-–—]\s*[$€£¥]?\s*\d[\d.,]*/;

async function sweepVariantPrices(page) {
  const lines = [];
  const selects = await page.$$('select');
  console.log(`Found ${selects.length} <select> element(s)`);

  for (const select of selects) {
    const options = await page.evaluate((sel) =>
      [...sel.options].map(o => ({ value: o.value, label: o.text.trim() })).filter(o => o.value),
      select
    );
    if (!options.length) { console.log('  No options, skipping'); continue; }
    console.log(`  Options (${options.length}):`, options.map(o => o.label));

    for (const { value, label } of options) {
      await page.evaluate((sel, val) => {
        sel.value = val;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('input',  { bubbles: true }));
      }, select, value);

      let price = null;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 100));
        price = await page.evaluate((sel) => {
          const RE = /[$€£¥]\s*\d[\d.,]*/;
          function search(el, depth) {
            if (depth > 8 || !el?.parentElement) return null;
            for (const sib of el.parentElement.children) {
              if (sib === el) continue;
              const txt = sib.textContent?.trim();
              if (txt && RE.test(txt) && txt.length < 40) return txt;
              for (const child of sib.children) {
                const ct = child.textContent?.trim();
                if (ct && RE.test(ct) && ct.length < 40) return ct;
              }
            }
            return search(el.parentElement, depth + 1);
          }
          const r = search(sel, 0);
          return r ? r.replace(/\s+/g, ' ') : null;
        }, select);
        if (price) break;
      }

      console.log(`    ${label}: ${price ?? '(no price found)'}`);
      if (price) lines.push(`${label}: ${price}`);
    }
  }
  return lines;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Loading:', URL);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  const { text } = await page.evaluate(() => {
    ['script', 'style', 'noscript'].forEach(tag =>
      document.querySelectorAll(tag).forEach(el => el.remove())
    );
    const text = (document.body?.innerText || '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text };
  });

  console.log('\n--- Extracted text (first 400 chars) ---');
  console.log(text.slice(0, 400));
  console.log('\nHas price range:', PRICE_RANGE_RE.test(text));
  console.log('Has any price:', PRICE_RE.test(text));

  console.log('\n--- Running variant sweep ---');
  const lines = await sweepVariantPrices(page);

  console.log('\n--- Result ---');
  console.log(lines.length ? 'Captured:\n' + lines.join('\n') : 'No variant prices captured.');

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
