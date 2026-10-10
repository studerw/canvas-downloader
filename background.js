// Canvas Lecture Downloader — Background Service Worker

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'resolveStreams') {
    resolveStreams(message.videos)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'downloadFile') {
    try {
      const url = new URL(message.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
        throw new Error('Unsupported download URL');
      }
      chrome.downloads.download({
        url: url.href,
        filename: `${safeFilename(message.folder, 'Canvas_Lectures')}/${safeFilename(message.filename, 'Download')}`,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
});

function safeFilename(value, fallback) {
  const cleaned = String(value || '').normalize('NFC')
    .replace(/[\x00-\x1f\x7f/\\:?%*|"<>]/g, '-')
    .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 150);
  const name = cleaned || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

function panoptoPages(video) {
  const url = new URL(video.panoptoUrl);
  const match = url.pathname.match(/^(.*\/Panopto\/Pages\/)(?:Embed|Viewer)\.aspx$/i);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !match ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(video.id || '')) {
    throw new Error('Invalid Panopto video URL or session ID');
  }
  return new URL(match[1], url.origin);
}

async function resolveStreams(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return { videos: [] };

  const groups = new Map();
  const results = [];
  for (const video of videos) {
    try {
      const pages = panoptoPages(video);
      if (!groups.has(pages.href)) groups.set(pages.href, { pages, videos: [] });
      groups.get(pages.href).videos.push(video);
    } catch (error) {
      results.push({ id: video.id, title: video.title, error: error.message });
    }
  }

  for (const group of groups.values()) {
    let tab;
    try {
      const embed = new URL('Embed.aspx', group.pages);
      embed.searchParams.set('id', group.videos[0].id);
      tab = await chrome.tabs.create({ url: embed.href, active: false });
      await waitForTabLoad(tab.id);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: queryDeliveryInfo,
        args: [group.videos, new URL('Viewer/DeliveryInfo.aspx', group.pages).href]
      });
      if (!Array.isArray(result?.result)) throw new Error('Panopto did not return video information');
      results.push(...result.result);
    } catch (error) {
      results.push(...group.videos.map(video => ({ id: video.id, title: video.title, error: error.message })));
    } finally {
      if (tab) {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
      }
    }
  }
  return { videos: results };
}

// Runs inside the university's authenticated Panopto tab.
async function queryDeliveryInfo(videos, deliveryInfoUrl) {
  if (location.origin !== new URL(deliveryInfoUrl).origin) {
    throw new Error('Sign in to your university\'s Panopto site, then retry');
  }
  const results = [];
  for (const video of videos) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(deliveryInfoUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ deliveryId: video.id, responseType: 'json' }).toString(),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Panopto returned HTTP ${response.status}`);
      const data = await response.json();
      const delivery = data.Delivery || {};
      const podcasts = delivery.PodcastStreams || [];
      const streams = delivery.Streams || [];
      let streamUrl = null;
      for (const stream of [...podcasts, ...streams]) {
        for (const value of [stream.StreamUrl, stream.HttpUrl]) {
          if (!value) continue;
          try {
            const url = new URL(value, location.href);
            const isPodcast = podcasts.includes(stream);
            if (/^https?:$/.test(url.protocol) && !url.username && !url.password &&
                !/\.(m3u8|mpd)$/i.test(url.pathname) &&
                (isPodcast || /\.(mp4|m4v|webm)$/i.test(url.pathname))) {
              streamUrl = url.href;
              break;
            }
          } catch (_) {}
        }
        if (streamUrl) break;
      }
      // Adaptive streaming manifests require a separate media assembly process.
      if (!streamUrl) throw new Error('No downloadable video stream is available for this recording');
      const cleanTitle = String(video.title || 'Lecture')
        .replace(/\s*\(\d+:\d+\)\s*$/, '')
        .replace(/:/g, ' -').replace(/[\x00-\x1f\x7f/\\?%*|"<>]/g, '-')
        .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 140) || 'Lecture';
      const extension = new URL(streamUrl).pathname.match(/\.(mp4|m4v|webm)$/i)?.[0] || '.mp4';
      results.push({ id: video.id, title: video.title, filename: cleanTitle + extension, streamUrl });
    } catch (error) {
      results.push({ id: video.id, title: video.title, error: error.message });
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    }
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') finish();
    }
    function removed(id) {
      if (id === tabId) finish(new Error('Panopto tab was closed before it loaded'));
    }
    const timeout = setTimeout(() => finish(new Error('Panopto tab load timed out')), 15000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    // A cached page can finish loading before the onUpdated listener is attached.
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish();
    }).catch(error => finish(error));
  });
}
