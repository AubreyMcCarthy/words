import fs from 'fs/promises';
import path from 'path';
import frontMatter from 'front-matter';
import { marked } from 'marked';
import chokidar from 'chokidar';

const CONTENT_DIR = './content';
const OUTPUT_DIR = './docs';
const TEMPLATE_PATH = './template.html';

const SITE_CONFIG = {
  title: 'Aubrey - Words',
  description: 'Words, thoughts, musings...',
  url: 'https://words.aubrey.page',
  author: 'Aubrey McCarthy'
};

async function generateSite() {
  // Ensure output directory exists
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // Read template
  const template = await fs.readFile(TEMPLATE_PATH, 'utf-8');

  // Read all markdown files
  const files = await fs.readdir(CONTENT_DIR);
  const markdownFiles = files.filter(file => file.endsWith('.md'));

  // Parse markdown files and extract front matter
  const entries = await Promise.all(
    markdownFiles.map(async file => {
      const content = await fs.readFile(path.join(CONTENT_DIR, file), 'utf-8');
      const { attributes, body } = frontMatter(content);
      const slug = path.basename(file, '.md');
      
      return {
        ...attributes,
        content: marked(body),
        date: new Date(attributes.date),
        tags: attributes.tags || [],
        slug,
        filename: file
      };
    })
  );

  // Sort entries by date
  entries.sort((a, b) => b.date - a.date);

  // Generate posts metadata JSON
  const postsMetadata = entries.map(entry => ({
    title: entry.title,
    date: entry.date.toISOString(),
    tags: entry.tags,
    slug: entry.slug,
    description: entry.description || ''
  }));

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'posts.json'), 
    JSON.stringify(postsMetadata, null, 2)
  );

  // Collect all unique tags
  const allTags = [...new Set(entries.flatMap(entry => entry.tags))].sort();

  // Generate portfolio items HTML with tags
  const portfolioItems = entries.map(entry => {
    const tagsHTML = entry.tags.length > 0 
      ? `<div class="portfolio-tags">
           ${entry.tags.map(tag => `<span class="tag" data-tag="${tag}">${tag}</span>`).join(' ')}
         </div>`
      : '';
    
    return `
      <div class="portfolio-item" data-tags="${entry.tags.join(' ')}">
        <div class="portfolio-header">
          <div class="portfolio-date">${entry.date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}</div>
          <h2 class="portfolio-title">${entry.title}</h2>
          ${tagsHTML}
        </div>
        <div class="portfolio-content">
          ${entry.content}
        </div>
      </div>
    `;
  }).join('\n');

  // Generate tag filter buttons
  const tagFilterHTML = allTags.length > 0 
    ? `<div class="tag-filters">
         <button class="tag-filter active" data-filter="all">All</button>
         ${allTags.map(tag => `<button class="tag-filter" data-filter="${tag}">${tag}</button>`).join(' ')}
       </div>`
    : '';

  // Insert content into template
  let outputHTML = template.replace('<!-- PORTFOLIO_ITEMS -->', portfolioItems);
  outputHTML = outputHTML.replace('<!-- TAG_FILTERS -->', tagFilterHTML);

  // Write output file
  await fs.writeFile(path.join(OUTPUT_DIR, 'index.html'), outputHTML);

  // Generate RSS feed
  await generateRSSFeed(entries);

  console.log('Site generated successfully!');
  console.log(`Generated ${entries.length} posts with tags: ${allTags.join(', ')}`);
}

async function generateRSSFeed(entries) {
  const rssItems = entries.slice(0, 20).map(entry => { // Latest 20 posts
    const pubDate = entry.date.toUTCString();
    const description = entry.description || entry.content.substring(0, 200).replace(/<[^>]*>/g, '') + '...';
    const postUrl = `${SITE_CONFIG.url}/posts/${entry.slug}.html`;
    
    return `    <item>
      <title><![CDATA[${entry.title}]]></title>
      <description><![CDATA[${description}]]></description>
      <content:encoded><![CDATA[${entry.content}]]></content:encoded>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;
  }).join('\n');

  const rssXML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${SITE_CONFIG.title}</title>
    <description>${SITE_CONFIG.description}</description>
    <link>${SITE_CONFIG.url}</link>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>Custom Static Site Generator</generator>
    <language>en-US</language>

${rssItems}
  </channel>
</rss>`;

  await fs.writeFile(path.join(OUTPUT_DIR, 'rss.xml'), rssXML);
}

// Watch mode
if (process.argv.includes('--watch')) {
  console.log('Watching for changes...');
  chokidar.watch([CONTENT_DIR, TEMPLATE_PATH]).on('all', (event, path) => {
    console.log(`Change detected (${event}): ${path}`);
    generateSite();
  });
} else {
  generateSite();
}