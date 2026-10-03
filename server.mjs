import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataDirectory = resolve(root, 'data');
const port = Number(process.env.PORT) || 3000;
let writeQueue = Promise.resolve();

function sendJson(response, data, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

async function readCollection(name) {
  try {
    const contents = await readFile(resolve(dataDirectory, `${name}.json`), 'utf8');
    const data = JSON.parse(contents);
    if (!Array.isArray(data)) throw new Error(`Stored ${name} data must be an array`);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function updateCollection(name, update) {
  const operation = writeQueue.then(async () => {
    const items = await readCollection(name);
    const result = update(items);
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(resolve(dataDirectory, `${name}.json`), JSON.stringify(items, null, 2));
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Request body is too large');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function statusStep(status) {
  return status === 'Confirmed' ? 1 :
    status === 'Preparing' ? 2 :
    status === 'Ready for pickup' ? 3 :
    status === 'Out for delivery' ? 4 :
    status === 'Delivered' ? 5 : 0;
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[1];
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;
  const isTracking = parts[3] === 'tracking';

  if (resource === 'products' && request.method === 'GET') {
    return sendJson(response, await readCollection('products'));
  }

  if (resource === 'products' && request.method === 'POST') {
    const product = await readBody(request);
    if (!product.id || !String(product.name || '').trim()) {
      return sendJson(response, { error: 'Product id and name are required' }, 400);
    }
    const saved = await updateCollection('products', products => {
      const index = products.findIndex(item => String(item.id) === String(product.id));
      const value = {
        ...(index >= 0 ? products[index] : {}),
        ...product,
        serverUpdatedAt: new Date().toISOString()
      };
      if (index >= 0) products[index] = value;
      else products.unshift(value);
      return value;
    });
    return sendJson(response, saved);
  }

  if (resource === 'products' && request.method === 'DELETE') {
    const productId = url.searchParams.get('id');
    if (!productId) return sendJson(response, { error: 'Product id is required' }, 400);
    await updateCollection('products', products => {
      products.splice(0, products.length, ...products.filter(item => String(item.id) !== productId));
    });
    return sendJson(response, { ok: true, id: productId });
  }

  if (resource === 'orders' && !isTracking && request.method === 'GET') {
    return sendJson(response, await readCollection('orders'));
  }

  if (resource === 'orders' && !isTracking && request.method === 'DELETE') {
    await updateCollection('orders', orders => orders.splice(0, orders.length));
    return sendJson(response, { ok: true, cleared: true });
  }

  if (resource === 'orders' && !isTracking && request.method === 'POST') {
    const order = await readBody(request);
    if (!order.id) return sendJson(response, { error: 'Order id is required' }, 400);
    const saved = await updateCollection('orders', orders => {
      const index = orders.findIndex(item => String(item.id) === String(order.id));
      const value = {
        ...(index >= 0 ? orders[index] : {}),
        ...order,
        serverUpdatedAt: new Date().toISOString()
      };
      if (index >= 0) orders[index] = value;
      else orders.unshift(value);
      return value;
    });
    return sendJson(response, saved);
  }

  if (resource === 'orders' && !isTracking && request.method === 'PATCH') {
    const patch = await readBody(request);
    const saved = await updateCollection('orders', orders => {
      const index = orders.findIndex(item => String(item.id) === String(id));
      if (index < 0) return null;
      orders[index] = {
        ...orders[index],
        ...patch,
        ...(patch.status ? { statusStep: statusStep(patch.status) } : {}),
        serverUpdatedAt: new Date().toISOString()
      };
      return orders[index];
    });
    return saved ? sendJson(response, saved) : sendJson(response, { error: 'Order not found' }, 404);
  }

  if (resource === 'orders' && isTracking && request.method === 'GET') {
    const orders = await readCollection('orders');
    const order = orders.find(item => String(item.id) === String(id));
    if (!order) return sendJson(response, { error: 'Order not found' }, 404);
    return sendJson(response, {
      id: order.id,
      status: order.status || 'Confirmed',
      statusStep: Number(order.statusStep || statusStep(order.status)),
      lat: order.driverLat ?? null,
      lng: order.driverLng ?? null,
      updatedAt: order.trackingUpdatedAt || order.statusUpdatedAt || order.serverUpdatedAt || null,
      currentSituation: order.currentSituation || null
    });
  }

  if (resource === 'orders' && isTracking && request.method === 'PATCH') {
    const patch = await readBody(request);
    const lat = Number(patch.lat);
    const lng = Number(patch.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return sendJson(response, { error: 'Valid latitude and longitude are required' }, 400);
    }
    const updatedAt = new Date().toISOString();
    const saved = await updateCollection('orders', orders => {
      const index = orders.findIndex(item => String(item.id) === String(id));
      if (index < 0) return null;
      orders[index] = {
        ...orders[index],
        driverLat: lat,
        driverLng: lng,
        trackingUpdatedAt: updatedAt,
        serverUpdatedAt: updatedAt
      };
      return orders[index];
    });
    if (!saved) return sendJson(response, { error: 'Order not found' }, 404);
    return sendJson(response, {
      id,
      lat,
      lng,
      status: saved.status,
      statusStep: saved.statusStep,
      currentSituation: saved.currentSituation || null,
      updatedAt
    });
  }

  return sendJson(response, { error: 'Route not found' }, 404);
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(response, { error: 'Method not allowed' }, 405);
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    return sendJson(response, { error: 'Invalid path' }, 400);
  }
  const filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return sendJson(response, { error: 'Forbidden' }, 403);
  }
  try {
    const contents = await readFile(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    sendJson(response, { error: error.code === 'ENOENT' ? 'Not found' : 'Could not read file' }, error.code === 'ENOENT' ? 404 : 500);
  }
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const origin = request.headers.origin || '';
    const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (url.pathname.startsWith('/api/') && localOrigin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.setHeader('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    console.error('SIPORA local server error:', error);
    sendJson(response, { error: error.message || 'Server error' }, 500);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`SIPORA local server running at http://127.0.0.1:${port}`);
});