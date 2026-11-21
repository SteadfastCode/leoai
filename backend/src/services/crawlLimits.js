// Crawl limits shared by the crawl and the persistence that cleans up after it.
//
// MAX_PAGES lived as a bare `const` inside scraper.js, which was fine while it
// was only the crawl's own stopping condition. Dead-page retirement (LEO-138)
// has to know the same number from the OTHER side: a crawl that stopped because
// it hit the cap did not fail to reach the pages beyond it — it never looked —
// so retiring them would delete a third of a large site's corpus on the second
// consecutive run. Two copies of the number would mean the guard silently stops
// matching the limit it guards the moment one of them is raised.
//
// Kept deliberately free of requires so the persistence path can read the limit
// without pulling Puppeteer, pdf-parse and the Anthropic SDK in behind it.

// Hard ceiling on pages fetched per crawl. Sites with shop subdomains need the
// room — 50 was too small (see CLAUDE.md).
const MAX_PAGES = 500;

module.exports = { MAX_PAGES };
