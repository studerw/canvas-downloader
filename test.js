const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function event() {
  const listeners = new Set();
  return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
}

async function run() {
  const created = [];
  const removed = [];
  const requests = [];
  const updated = event();
  const closed = event();
  let failHost = false;
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: { origin: 'https://media.example.edu', href: 'https://media.example.edu/Panopto/Pages/Embed.aspx' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ Delivery: { PodcastStreams: [
        { StreamUrl: 'https://cdn.example.edu/lecture.mp4' }
      ] } }) };
    },
    chrome: {
      runtime: { onMessage: event() },
      downloads: { download: (request, callback) => { requests.push(request); callback(7); } },
      tabs: {
        onUpdated: updated, onRemoved: closed,
        create: async options => { created.push(options); return { id: created.length }; },
        get: async () => ({ status: 'complete' }),
        remove: async id => { removed.push(id); }
      },
      scripting: { executeScript: async options => {
        if (failHost && options.args[1].includes('other.example.edu')) throw new Error('Host unavailable');
        return [{ result: options.args[0].map(video => ({ ...video, streamUrl: 'https://cdn.example.edu/lecture.mp4' })) }];
      } }
    }
  });
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
  const id = '11111111-1111-1111-1111-111111111111';
  const videos = [
    { id, title: 'First', panoptoUrl: `https://media.example.edu/Panopto/Pages/Embed.aspx?id=${id}` },
    { id, title: 'Second', panoptoUrl: `https://other.example.edu/custom/Panopto/Pages/Viewer.aspx?id=${id}` }
  ];
  let result = await context.resolveStreams(videos);
  assert.equal(result.videos.length, 2);
  assert.equal(created[0].url, videos[0].panoptoUrl);
  assert.equal(created[1].url, `https://other.example.edu/custom/Panopto/Pages/Embed.aspx?id=${id}`);
  assert.deepEqual(removed, [1, 2]);
  assert.equal(updated.listeners.size, 0);
  assert.equal(closed.listeners.size, 0);

  failHost = true;
  result = await context.resolveStreams(videos);
  assert.equal(result.videos[0].streamUrl, 'https://cdn.example.edu/lecture.mp4');
  assert.equal(result.videos[1].error, 'Host unavailable');
  assert.deepEqual(removed, [1, 2, 3, 4]);

  result = await context.resolveStreams([{ ...videos[0], panoptoUrl: 'javascript:alert(1)' }]);
  assert.match(result.videos[0].error, /Invalid Panopto/);
  assert.equal(created.length, 4);

  const endpoint = 'https://media.example.edu/Panopto/Pages/Viewer/DeliveryInfo.aspx';
  result = await context.queryDeliveryInfo([{ ...videos[0], title: 'Lecture / One (12:34)' }], endpoint);
  assert.equal(requests[0].url, endpoint);
  assert.equal(new URLSearchParams(requests[0].options.body).get('deliveryId'), id);
  assert.equal(result[0].filename, 'Lecture - One.mp4');
  assert.equal(result[0].streamUrl, 'https://cdn.example.edu/lecture.mp4');

  context.fetch = async () => ({ ok: true, json: async () => ({ Delivery: {
    PodcastStreams: [{ StreamUrl: 'https://cdn.example.edu/lecture.m3u8' }]
  } }) });
  result = await context.queryDeliveryInfo(videos.slice(0, 1), endpoint);
  assert.match(result[0].error, /No downloadable/);
  context.location.origin = 'https://sso.example.edu';
  await assert.rejects(context.queryDeliveryInfo(videos, endpoint), /Sign in/);

  const listener = [...context.chrome.runtime.onMessage.listeners][0];
  let response;
  listener({ action: 'downloadFile', url: 'https://canvas.example.edu/files/2/download?verifier=example',
    folder: '../Module', filename: 'CON.pdf' }, {}, value => { response = value; });
  assert.equal(response.success, true);
  assert.equal(requests.at(-1).filename, '-Module/_CON.pdf');
  assert.equal(requests.at(-1).conflictAction, 'uniquify');
  listener({ action: 'downloadFile', url: 'file:///private/example' }, {}, value => { response = value; });
  assert.match(response.error, /Unsupported/);
  console.log('PASS: multiple Panopto hosts, partial failures, tab cleanup, endpoints, stream formats, and downloads');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
