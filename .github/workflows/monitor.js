/**
 * monitor.js - Fixed Deduplication Watcher
 */

const fs = require('fs');
const axios = require('axios');
const dotenv = require('dotenv');
const { chromium } = require('playwright');

dotenv.config();

const CONFIG = {
  TARGET_URL: process.env.TARGET_URL || 'https://ugcleaks.short-term.workers.dev/leaks',
  POLL_INTERVAL_SECONDS: Number(process.env.POLL_INTERVAL_SECONDS || 30),
  SEEN_STORE: process.env.SEEN_STORE || 'seen.json',
  WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  ROLE_IDS: {
    upcoming: process.env.ROLE_ID_UPCOMING || '1545880166683906118',
    paid: process.env.ROLE_ID_PAID || '1545880048567984188',
    regular: process.env.ROLE_ID_REGULAR || '1545881749064646777',
    abandoned: process.env.ROLE_ID_ABANDONED || '1545880971415527504',
    active: process.env.ROLE_ID_ACTIVE || '1545881407656558612',
  },
  COLORS: {
    upcoming: 0x0099FF,
    paid: 0x0099FF,
    regular: 0x0099FF,
    abandoned: 0x0099FF,
    active: 0x0099FF,
  },
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || null,
};

if (!CONFIG.WEBHOOK_URL) {
  console.error('ERROR: DISCORD_WEBHOOK_URL not set in environment.');
  process.exit(1);
}

const GITHUB_API = axios.create({
  baseURL: 'https://api.github.com',
  timeout: 15000,
  headers: CONFIG.GITHUB_TOKEN ? { Authorization: `token ${CONFIG.GITHUB_TOKEN}`, 'User-Agent': 'ugc-watcher' } : undefined,
});

async function loadSeenGithub() {
  try {
    const url = `/repos/${CONFIG.GITHUB_REPOSITORY}/contents/${encodeURIComponent(CONFIG.SEEN_STORE)}`;
    const res = await GITHUB_API.get(url);
    const content = Buffer.from(res.data.content, 'base64').toString('utf8');
    return { store: JSON.parse(content), sha: res.data.sha };
  } catch (err) {
    return { store: { seen: [] }, sha: null };
  }
}

async function saveSeenGithub(store, previousSha) {
  try {
    const url = `/repos/${CONFIG.GITHUB_REPOSITORY}/contents/${encodeURIComponent(CONFIG.SEEN_STORE)}`;
    const contentBase64 = Buffer.from(JSON.stringify(store, null, 2), 'utf8').toString('base64');
    const payload = { message: 'Update seen.json by ugc-watcher', content: contentBase64 };
    if (previousSha) payload.sha = previousSha;
    const res = await GITHUB_API.put(url, payload);
    return res.data.content.sha;
  } catch (err) {
    console.error('GitHub save seen failed:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

function loadSeenLocal() {
  try {
    if (fs.existsSync(CONFIG.SEEN_STORE)) {
      const raw = fs.readFileSync(CONFIG.SEEN_STORE, 'utf8');
      return { store: JSON.parse(raw), sha: null };
    }
  } catch (e) {
    console.warn('Could not read local seen.json, starting fresh.');
  }
  return { store: { seen: [] }, sha: null };
}

function saveSeenLocal(store) {
  fs.writeFileSync(CONFIG.SEEN_STORE, JSON.stringify(store, null, 2));
}

async function loadSeen() {
  return (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) ? await loadSeenGithub() : loadSeenLocal();
}

async function saveSeen(store, previousSha) {
  return (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) ? await saveSeenGithub(store, previousSha) : (saveSeenLocal(store), null);
}

// STABLE ID GENERATOR (Removes relative timestamps to stop spam)
function idFromCard(card) {
  if (card.link && card.link.includes('roblox.com')) {
    return card.link.trim().toLowerCase();
  }
  // Sanitize title to use as stable key
  const cleanTitle = (card.title || 'untitled').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanMethod = (card.method || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${cleanTitle}_${cleanMethod}`;
}

function buildWebhookPayload(card) {
  const category = (card.category || 'regular').toLowerCase();
  const roleId = CONFIG.ROLE_IDS[category] || null;
  const mention = roleId ? `<@&${roleId}>` : '';
  
  const embed = {
    title: card.title || 'New UGC Leak',
    url: card.link || undefined,
    description: card.info || 'No description provided.',
    color: 0x0099FF, // Pure Blue Embed Color
    fields: [],
    timestamp: new Date().toISOString(),
  };

  if (card.timestamp) embed.fields.push({ name: 'Release / Time', value: String(card.timestamp), inline: true });
  if (card.method) embed.fields.push({ name: 'Quest / Method', value: String(card.method), inline: true });
  if (card.stock) embed.fields.push({ name: 'Stock', value: String(card.stock), inline: true });
  if (card.link) embed.fields.push({ name: 'Roblox Link', value: `[Buy / View on Roblox](${card.link})`, inline: false });
  if (card.image) embed.image = { url: card.image };

  return { content: `${mention} New leak in **${category.toUpperCase()}**!`, embeds: [embed] };
}

async function postToDiscord(payload) {
  try {
    await axios.post(CONFIG.WEBHOOK_URL, payload);
    console.log('Successfully posted:', payload.embeds?.[0]?.title);
  } catch (err) {
    console.error('Webhook post failed:', err.response?.status, err.response?.data || err.message);
  }
}

async function scrapeOnce(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(CONFIG.TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
  } catch {
    await page.waitForLoadState('domcontentloaded');
  }

  const cards = await page.evaluate(() => {
    const cardNodes = Array.from(document.querySelectorAll('.card, .leak-item, [class*="card"], [class*="item"]'));
    
    return cardNodes.map(el => {
      const title = el.querySelector('h1, h2, h3, .title, [class*="title"]')?.innerText?.trim() || '';
      const anchors = Array.from(el.querySelectorAll('a')).map(a => a.href).filter(Boolean);
      const link = anchors.find(a => a.includes('roblox.com')) || anchors[0] || '';
      const timestamp = el.querySelector('[class*="time"], [class*="date"]')?.innerText?.trim() || '';
      const stock = el.querySelector('[class*="stock"]')?.innerText?.trim() || '';
      const method = el.querySelector('[class*="quest"], [class*="method"], [class*="desc"]')?.innerText?.trim() || '';
      const info = el.innerText?.trim() || '';
      const img = el.querySelector('img');
      const image = img ? (img.src || img.getAttribute('data-src') || '') : '';
      
      let category = 'regular';
      const textLower = info.toLowerCase();
      if (textLower.includes('upcoming')) category = 'upcoming';
      else if (textLower.includes('paid')) category = 'paid';
      else if (textLower.includes('abandoned')) category = 'abandoned';
      else if (textLower.includes('active')) category = 'active';

      return { title, link, timestamp, stock, method, info, image, category };
    }).filter(c => c.title.length > 0);
  });

  await page.close();
  return cards;
}

async function runOnceFlow(browser, seenState) {
  const items = await scrapeOnce(browser);
  const newItems = [];

  for (const card of items) {
    const id = idFromCard(card);
    if (!seenState.store.seen.includes(id)) {
      newItems.push({ card, id });
    }
  }

  if (newItems.length > 0) {
    console.log(`Found ${newItems.length} new item(s). Posting...`);
    for (const { card, id } hobbies of newItems) {
      const payload = buildWebhookPayload(card);
      await postToDiscord(payload);
      seenState.store.seen.push(id); // Instantly update seen array in memory
      await new Promise(r => setTimeout(r, 1000));
    }
    // Save updated seen array to disk / GitHub
    const newSha = await saveSeen(seenState.store, seenState.sha);
    if (newSha) seenState.sha = newSha;
  } else {
    console.log('No new items detected.');
  }
}

async function runLoopMode() {
  const browser = await chromium.launch({ headless: true });
  // Load seen state ONCE at startup to preserve memory state across loops
  const seenState = await loadSeen();

  try {
    while (true) {
      try {
        console.log(`Scanning ${CONFIG.TARGET_URL} at ${new Date().toLocaleTimeString()}...`);
        await runOnceFlow(browser, seenState);
      } catch (err) {
        console.error('Loop error:', err?.message || err);
      }
      await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_SECONDS * 1000));
    }
  } finally {
    await browser.close();
  }
}

async function runOnceMode() {
  const browser = await chromium.launch({ headless: true });
  try {
    const seenState = await loadSeen();
    await runOnceFlow(browser, seenState);
  } finally {
    await browser.close();
  }
}

(async () => {
  const runOnceEnv = (process.env.RUN_ONCE || '').toLowerCase() === 'true';
  if (runOnceEnv) {
    await runOnceMode();
    process.exit(0);
  } else {
    await runLoopMode();
  }
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
    
