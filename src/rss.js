// Minimal RSS/Atom parser — enough for news feeds, zero dependencies.
// Returns [{ title, link, description, publishedAt }].

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  // Decode first (CDATA unwrap + entities) so entity-encoded markup like
  // &lt;b&gt; becomes strippable. Only remove things that look like real HTML
  // tags — a '<' or '</' followed by a letter — so financial prose keeps its
  // comparison operators ("EPS came in < estimates, revenue > guidance").
  return decodeEntities(s)
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function firstTag(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

function parseFeed(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const block of blocks) {
    const title = stripTags(firstTag(block, ['title']));
    // RSS: <link>url</link>. Atom: <link href="url"/> — prefer rel="alternate"
    // (the human article) over self/edit/enclosure links that may be listed
    // first and point at the feed's own API URL.
    let link = stripTags(firstTag(block, ['link']));
    if (!link) {
      const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map(m => m[1]);
      const hrefOf = attrs => (attrs.match(/href=["']([^"']+)["']/i) || [])[1];
      const relOf = attrs => (attrs.match(/rel=["']([^"']+)["']/i) || [])[1];
      const alt = links.find(a => relOf(a) === 'alternate' && hrefOf(a));
      const noRel = links.find(a => !relOf(a) && hrefOf(a));
      const any = links.find(a => hrefOf(a));
      const chosen = hrefOf(alt || noRel || any || '');
      if (chosen) link = decodeEntities(chosen);
    }
    const description = stripTags(firstTag(block, ['description', 'summary', 'content'])).slice(0, 500);
    const dateRaw = stripTags(firstTag(block, ['pubDate', 'published', 'updated', 'dc:date']));
    const parsed = Date.parse(dateRaw);
    const publishedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    if (title && link) items.push({ title, link, description, publishedAt });
  }
  return items;
}

module.exports = { parseFeed, stripTags };
