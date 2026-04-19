// wiki.js — OSRS Wiki MediaWiki API helpers

const WIKI_API = 'https://oldschool.runescape.wiki/api.php';

/**
 * Search OSRS Wiki items by name.
 * @param {string} query
 * @returns {Promise<Array<{title: string, url: string}>>}
 */
async function searchItems(query) {
  if (!query || query.trim().length < 2) return [];
  const params = new URLSearchParams({
    action: 'opensearch',
    search: query.trim(),
    limit: '12',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  if (!res.ok) throw new Error(`Wiki API error: ${res.status}`);
  const data = await res.json();
  // data = [queryString, [titles], [descriptions], [urls]]
  return data[1].map((title, i) => ({ title, url: data[3][i] }));
}

/**
 * Fetch an item's thumbnail from the OSRS Wiki and return it as a DataURL.
 * Falls back to direct URL string if CORS prevents blob fetching.
 * @param {string} title  — wiki page title (e.g. "Dragon scimitar")
 * @returns {Promise<string|null>}  DataURL, direct URL, or null
 */
async function fetchItemImageAsDataUrl(title) {
  const params = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'pageimages',
    pithumbsize: '80',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  if (!res.ok) return null;
  const data = await res.json();

  const pages = data.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  if (!page?.thumbnail?.source) return null;

  const imageUrl = page.thumbnail.source;

  // Try to fetch as blob (required for html2canvas; may fail due to CORS)
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return imageUrl; // fallback to direct URL
    const blob = await imgRes.blob();
    return await blobToDataUrl(blob);
  } catch {
    // CORS prevented blob fetch — return direct URL for <img> display.
    // html2canvas export may not render this image.
    return imageUrl;
  }
}

/**
 * Convert a Blob to a base64 DataURL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
