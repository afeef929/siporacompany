import { head, put } from '@vercel/blob';

const ORDERS = 'sipora/orders.json';
const PRODUCTS = 'sipora/products.json';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function readBlob(key, fallback = []) {
  try {
    const meta = await head(key);
    const r = await fetch(meta.url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Blob read failed: ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data : fallback;
  } catch (e) {
    if (e?.message?.includes('BLOB_READ_WRITE_TOKEN')) throw e;
    return fallback;
  }
}

async function writeBlob(key, value) {
  await put(key, JSON.stringify(value), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

function statusStep(status) {
  return status === 'Confirmed' ? 1 :
    status === 'Preparing' ? 2 :
    status === 'Ready for pickup' ? 3 :
    status === 'Out for delivery' ? 4 :
    status === 'Delivered' ? 5 : 0;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const apiIndex = parts.indexOf('api');
    const path = apiIndex >= 0 ? parts.slice(apiIndex + 1) : parts;
    const resource = path[0] || '';
    const id = path[1] || null;
    const isTracking = path[2] === 'tracking';
    const orderId = isTracking ? id : null;

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return json({
        error: 'SIPORA backend is not connected yet.',
        setup: 'Add the Vercel Blob environment variable BLOB_READ_WRITE_TOKEN, then redeploy.'
      }, 503);
    }

    if (resource === 'products' && req.method === 'GET') {
      return json(await readBlob(PRODUCTS));
    }

    if (resource === 'products' && req.method === 'POST') {
      const product = await req.json();
      if (!product?.id || !product?.name) return json({ error: 'Product id and name are required' }, 400);
      const products = await readBlob(PRODUCTS);
      const index = products.findIndex(x => String(x.id) === String(product.id));
      const saved = {
        ...(index >= 0 ? products[index] : {}),
        ...product,
        serverUpdatedAt: new Date().toISOString()
      };
      if (index >= 0) products[index] = saved;
      else products.unshift(saved);
      await writeBlob(PRODUCTS, products);
      return json(saved);
    }

    if (resource === 'products' && req.method === 'DELETE') {
      const productId = url.searchParams.get('id');
      if (!productId) return json({ error: 'Product id is required' }, 400);
      const products = await readBlob(PRODUCTS);
      await writeBlob(PRODUCTS, products.filter(x => String(x.id) !== String(productId)));
      return json({ ok: true, id: productId });
    }

    if (resource === 'orders' && !isTracking && req.method === 'GET') {
      return json(await readBlob(ORDERS));
    }

    if (resource === 'orders' && !isTracking && req.method === 'DELETE') {
      await writeBlob(ORDERS, []);
      return json({ ok: true, cleared: true });
    }

    if (resource === 'orders' && !isTracking && req.method === 'POST') {
      const order = await req.json();
      if (!order?.id) return json({ error: 'Order id is required' }, 400);
      const orders = await readBlob(ORDERS);
      const index = orders.findIndex(x => String(x.id) === String(order.id));
      const saved = {
        ...(index >= 0 ? orders[index] : {}),
        ...order,
        serverUpdatedAt: new Date().toISOString()
      };
      if (index >= 0) orders[index] = saved;
      else orders.unshift(saved);
      await writeBlob(ORDERS, orders);
      return json(saved);
    }

    if (resource === 'orders' && !isTracking && req.method === 'PATCH') {
      const patch = await req.json();
      const orders = await readBlob(ORDERS);
      const index = orders.findIndex(x => String(x.id) === String(id));
      if (index < 0) return json({ error: 'Order not found' }, 404);
      orders[index] = {
        ...orders[index],
        ...patch,
        serverUpdatedAt: new Date().toISOString()
      };
      if (patch.status) orders[index].statusStep = statusStep(patch.status);
      await writeBlob(ORDERS, orders);
      return json(orders[index]);
    }

    if (resource === 'orders' && isTracking && req.method === 'GET') {
      const orders = await readBlob(ORDERS);
      const order = orders.find(x => String(x.id) === String(orderId));
      if (!order) return json({ error: 'Order not found' }, 404);
      return json({
        id: order.id,
        status: order.status || 'Confirmed',
        statusStep: Number(order.statusStep || statusStep(order.status)),
        lat: order.driverLat ?? null,
        lng: order.driverLng ?? null,
        updatedAt: order.trackingUpdatedAt || order.statusUpdatedAt || order.serverUpdatedAt || null,
        currentSituation: order.currentSituation || null
      });
    }

    if (resource === 'orders' && isTracking && req.method === 'PATCH') {
      const patch = await req.json();
      const lat = Number(patch.lat);
      const lng = Number(patch.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return json({ error: 'Valid latitude and longitude are required' }, 400);
      }
      const orders = await readBlob(ORDERS);
      const index = orders.findIndex(x => String(x.id) === String(orderId));
      if (index < 0) return json({ error: 'Order not found' }, 404);
      const now = new Date().toISOString();
      orders[index] = {
        ...orders[index],
        driverLat: lat,
        driverLng: lng,
        trackingUpdatedAt: now,
        serverUpdatedAt: now
      };
      await writeBlob(ORDERS, orders);
      return json({
        id: orderId,
        lat,
        lng,
        status: orders[index].status,
        statusStep: orders[index].statusStep,
        currentSituation: orders[index].currentSituation || null,
        updatedAt: now
      });
    }

    return json({ error: 'Route not found' }, 404);
  } catch (error) {
    console.error('SIPORA Vercel API error:', error);
    return json({
      error: 'Server error',
      message: error?.message || String(error)
    }, 500);
  }
}
