import fs from 'fs/promises';
import path from 'path';
import frontMatter from 'front-matter';
import { marked } from 'marked';
import chokidar from 'chokidar';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CONTENT_DIR = './content';
const OUTPUT_DIR = './docs';
const TEMPLATE_PATH = './template.html';
const POST_TEMPLATE_PATH = './template-post.html';
const OUTPUT_POSTS_DIR = path.join(OUTPUT_DIR, 'posts');
const AUDIO_COVER_IMAGE = './audio-cover.jpg'; // Default cover image

const SITE_CONFIG = {
  title: 'Aubrey McCarthy - Words',
  description: 'A collection of thoughts about making, game development, and life.',
  url: 'https://words.aubrey.page',
  author: 'Aubrey McCarthy'
};

async function generateWaveformImage(audioPath, outputImagePath, coverImage) {
  try {
    console.log(`Generating waveform image for ${audioPath}...`);
    
    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputImagePath), { recursive: true });
    
    // Step 1: Get the dimensions of the source cover image
    const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${coverImage}"`;
    const { stdout: dimensions } = await execAsync(probeCmd);
    const [width, height] = dimensions.trim().split('x').map(Number);
    
    // Use source dimensions
    const targetWidth = width || 1200;
    const targetHeight = height || 630;
    
    // Step 1: Extract first 50 seconds of audio to temp file
    const tempAudio = outputImagePath.replace(/\.(jpg|png)$/, '-temp.mp3');
    const extractCmd = `ffmpeg -y -i "${audioPath}" -t 50 -q:a 0 "${tempAudio}"`;
    await execAsync(extractCmd);
    
    // Step 2: Generate waveform visualization from the extracted audio
    const tempWaveform = outputImagePath.replace(/\.(jpg|png)$/, '-waveform-temp.png');
    
    // Generate waveform 
    const waveformCmd = `ffmpeg -y -i "${tempAudio}" -filter_complex "compand=gain=3,showwavespic=s=${targetWidth}x${targetHeight}:colors=white" -frames:v 1 "${tempWaveform}"`;
    await execAsync(waveformCmd);
    
    // Step 3: Composite waveform over cover image without rescaling
    const compositeCmd = `ffmpeg -y -i "${coverImage}" -i "${tempWaveform}" -filter_complex "[1:v]colorchannelmixer=aa=0.5[wave];[0:v][wave]overlay=0:0" -q:v 2 "${outputImagePath}"`;
    await execAsync(compositeCmd);
    
    // Clean up temp files
    await fs.unlink(tempWaveform);
    await fs.unlink(tempAudio);
    
    console.log(`✓ Generated waveform image: ${outputImagePath} (${targetWidth}x${targetHeight})`);
    
    return outputImagePath;
  } catch (error) {
    console.error(`Failed to generate waveform image for ${audioPath}:`, error.message);
    return false;
  }
}

async function generateVideoFromAudio(audioPath, outputVideoPath, coverImage) {
  try {
    // Check if ffmpeg is available
    await execAsync('ffmpeg -version');
    
    // Check if output already exists and is newer than source
    try {
      const audioStat = await fs.stat(audioPath);
      const videoStat = await fs.stat(outputVideoPath);
      if (videoStat.mtime > audioStat.mtime) {
        console.log(`Video ${outputVideoPath} is up to date`);
        return;
      }
    } catch (err) {
      // File doesn't exist, need to generate
    }

    console.log(`Generating video for ${audioPath}...`);
    
    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputVideoPath), { recursive: true });
    
    // Generate video with static image and audio
    const ffmpegCmd = `ffmpeg -y -loop 1 -i "${coverImage}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -t 600 "${outputVideoPath}"`;
    
    await execAsync(ffmpegCmd);
    console.log(`✓ Generated video: ${outputVideoPath}`);
  } catch (error) {
    console.error(`Failed to generate video for ${audioPath}:`, error.message);
    if (error.message.includes('ffmpeg')) {
      console.error('ffmpeg not found. Please install ffmpeg to generate videos for Discord preview.');
    }
  }
}

async function generateSite() {
  // Ensure output directory exists
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // Read template
  const template = await fs.readFile(TEMPLATE_PATH, 'utf-8');
  const postTemplate = await fs.readFile(POST_TEMPLATE_PATH, 'utf-8');

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
        filename: file,
        musicSource: attributes['music-source'] || null,
        coverImage: attributes['cover-image'] || null
      };
    })
  );

  // Generate waveform images, videos, and social images for music posts
  for (const entry of entries) {
    if (entry.musicSource && entry.tags.includes('music')) {
      const audioPath = path.join(OUTPUT_DIR, entry.musicSource);
      const videoPath = audioPath.replace(/\.(mp3|wav|ogg|m4a)$/i, '.mp4');
      const waveformImagePath = audioPath.replace(/\.(mp3|wav|ogg|m4a)$/i, '-waveform.jpg');
      
      const coverImage = entry.coverImage 
        ? path.join(OUTPUT_DIR, entry.coverImage)
        : AUDIO_COVER_IMAGE;
      
      // Generate waveform image
      const generatedImagePath = await generateWaveformImage(audioPath, waveformImagePath, coverImage);
      
      // Use waveform image for video if it was generated successfully
      const videoSourceImage = generatedImagePath || coverImage;
      await generateVideoFromAudio(audioPath, videoPath, videoSourceImage);
      
      // Store paths for later use
      entry.videoSource = entry.musicSource.replace(/\.(mp3|wav|ogg|m4a)$/i, '.mp4');
      entry.waveformImage = generatedImagePath ? entry.musicSource.replace(/\.(mp3|wav|ogg|m4a)$/i, '-waveform.jpg') : null;
    }
  }

  // Sort entries by date
  entries.sort((a, b) => b.date - a.date);

  // Generate posts metadata JSON
  const postsMetadata = entries.map(entry => ({
    title: entry.title,
    date: entry.date.toISOString(),
    tags: entry.tags,
    slug: entry.slug,
    description: entry.description || '',
    musicSource: entry.musicSource,
    videoSource: entry.videoSource,
    waveformImage: entry.waveformImage
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

    const audioPlayer = generateAudioPlayer(entry);

	writePost(entry, postTemplate, tagsHTML);
    
    return `
      <div class="portfolio-item" data-tags="${entry.tags.join(' ')}">
        <div class="portfolio-header">
          <div class="portfolio-date">${entry.date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}</div>
          <header class="portfolio-title"><a href="/posts/${entry.slug}">${entry.title}</a></header>
          ${tagsHTML}
        </div>
        ${audioPlayer}
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

function generateOpenGraphTags(entry) {
  const postUrl = `${SITE_CONFIG.url}/posts/${entry.slug}`;
  const description = entry.description || entry.content.substring(0, 200).replace(/<[^>]*>/g, '');
  const isMusicPost = entry.tags.includes('music') && entry.musicSource;
  
  let ogTags = `
    <meta property="og:title" content="${entry.title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${postUrl}" />
    <meta property="og:site_name" content="${SITE_CONFIG.title}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${entry.title}" />
    <meta name="twitter:description" content="${description}" />
  `;

  if (isMusicPost) {
    // Add waveform image for social sharing
    if (entry.waveformImage) {
      const imageUrl = `${SITE_CONFIG.url}${entry.waveformImage}`;
      ogTags += `
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="1200" />
    <meta name="twitter:image" content="${imageUrl}" />
      `;
    }
    
    if (entry.videoSource) {
      // Use og:video for Discord compatibility
      const videoUrl = `${SITE_CONFIG.url}${entry.videoSource}`;
      const audioUrl = `${SITE_CONFIG.url}${entry.musicSource}`;
      
      ogTags += `
    <meta property="og:type" content="video.other" />
    <meta property="og:video" content="${videoUrl}" />
    <meta property="og:video:secure_url" content="${videoUrl}" />
    <meta property="og:video:type" content="video/mp4" />
    <meta property="og:audio" content="${audioUrl}" />
    <meta property="og:audio:type" content="audio/mpeg" />
    <meta property="music:musician" content="${SITE_CONFIG.author}" />
      `;
      
      // Add twitter player card for better support
      ogTags += `
    <meta name="twitter:player" content="${videoUrl}" />
      `;
    }
  } else {
    ogTags += `<meta property="og:type" content="article" />`;
  }

  return ogTags;
}

function generateAudioPlayer(entry) {
  if (!entry.musicSource) return '';
  
  return `
    <div class="audio-player">
      <audio controls preload="metadata">
        <source src="${entry.musicSource}" type="audio/mpeg">
        Your browser does not support the audio element.
      </audio>
    </div>
  `;
}

async function writePost(entry, postTemplate, tagsHTML) {
  const audioPlayer = generateAudioPlayer(entry);
  const ogTags = generateOpenGraphTags(entry);

  const post = `
      <div class="portfolio-item">
        <div class="portfolio-header">
          <div class="portfolio-date">${entry.date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}</div>
          <header class="portfolio-title">${entry.title}</header>
          ${tagsHTML}
        </div>
        ${audioPlayer}
        <div class="portfolio-content">
          ${entry.content}
        </div>
      </div>
    `
	// Insert content into template
	let outputHTML = postTemplate.replace('<!-- BLOG_ITEM -->', post);
	outputHTML = outputHTML.replace('<!-- BLOG_TITLE -->', entry.title);
  outputHTML = outputHTML.replace('<!-- OG_TAGS -->', ogTags);

	// Write output file
	await fs.writeFile(path.join(OUTPUT_POSTS_DIR, `${entry.slug}.html`), outputHTML);
}

async function generateRSSFeed(entries) {
  const rssItems = entries.slice(0, 20).map(entry => { // Latest 20 posts
    const pubDate = entry.date.toUTCString();
    const description = entry.description || entry.content.substring(0, 200).replace(/<[^>]*>/g, '') + '...';
    const postUrl = `${SITE_CONFIG.url}/posts/${entry.slug}`;
    
    // Add enclosure for music posts (for podcast players)
    const enclosure = entry.musicSource 
      ? `      <enclosure url="${SITE_CONFIG.url}${entry.musicSource}" type="audio/mpeg" />`
      : '';
    
    // Add iTunes tags for better podcast player support
    const itunesTags = entry.musicSource
      ? `      <itunes:duration></itunes:duration>
      <itunes:author>${SITE_CONFIG.author}</itunes:author>`
      : '';
    
    return `    <item>
      <title><![CDATA[${entry.title}]]></title>
      <description><![CDATA[${description}]]></description>
      <content:encoded><![CDATA[${entry.content}]]></content:encoded>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${pubDate}</pubDate>
${enclosure}
${itunesTags}
    </item>`;
  }).join('\n');

  const rssXML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${SITE_CONFIG.title}</title>
    <description>${SITE_CONFIG.description}</description>
    <link>${SITE_CONFIG.url}</link>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>Custom Static Site Generator</generator>
    <language>en-US</language>
    <itunes:author>${SITE_CONFIG.author}</itunes:author>
    <itunes:summary>${SITE_CONFIG.description}</itunes:summary>

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