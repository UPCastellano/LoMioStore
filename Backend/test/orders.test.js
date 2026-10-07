const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

let server;
const baseUrl = 'http://127.0.0.1:5017';

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/products`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test API did not start.');
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '5017',
      NODE_ENV: 'test',
      BACKEND_URL: baseUrl,
      ADMIN_USERNAME: 'orders-test-admin',
      ADMIN_PASSWORD: 'orders-test-only-password',
      POSTGRESQL_ADDON_HOST: '',
      POSTGRESQL_ADDON_DB: '',
      POSTGRESQL_ADDON_USER: '',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  if (server && !server.killed) server.kill();
});

test('order reserves stock, refuses overselling, and releases cancelled items', async () => {
  const productResponse = await fetch(`${baseUrl}/api/products`);
  const [product] = await productResponse.json();
  const beforeStock = Number(product.stock);

  const createResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Cliente Prueba', email: 'cliente@example.com', phone: '88880000', deliveryRoute: 'Barrio Centro, frente al parque' },
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: 'transfer_bac',
    }),
  });
  assert.equal(createResponse.status, 201);
  const order = await createResponse.json();
  assert.equal(order.subtotal, Number((Number(product.price) * 2).toFixed(2)));
  assert.match(order.orderNumber, /^LM-/);
  assert.equal(order.name, 'Cliente Prueba');
  assert.equal(order.email, 'cliente@example.com');
  assert.equal(order.paymentMethod, 'transfer_bac');
  assert.equal(order.deliveryRoute, 'Barrio Centro, frente al parque');

  const reservedProduct = (await (await fetch(`${baseUrl}/api/products`)).json()).find(item => Number(item.id) === Number(product.id));
  assert.equal(Number(reservedProduct.stock), beforeStock - 2);

  const oversellResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Otro Cliente', email: 'otro@example.com', phone: '88880001' },
      items: [{ productId: product.id, quantity: beforeStock }],
      paymentMethod: 'cash_pickup',
    }),
  });
  assert.equal(oversellResponse.status, 409);

  const cancelResponse = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(cancelResponse.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'orders-test-admin', password: 'orders-test-only-password' }),
  });
  const { token } = await loginResponse.json();
  const authorizedCancel = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(authorizedCancel.status, 200);

  const ordersResponse = await fetch(`${baseUrl}/api/orders`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(ordersResponse.status, 200);
  const orders = await ordersResponse.json();
  const savedOrder = orders.find(item => Number(item.id) === Number(order.id));
  assert.ok(savedOrder);
  assert.equal(savedOrder.items.length, 1);
  assert.equal(savedOrder.items[0].productName, product.name);
  assert.equal(Number(savedOrder.items[0].quantity), 2);
  assert.equal(Number(savedOrder.items[0].lineTotal), Number((Number(product.price) * 2).toFixed(2)));
  assert.equal(savedOrder.paymentMethod, 'transfer_bac');
  assert.equal(savedOrder.deliveryRoute, 'Barrio Centro, frente al parque');

  const restoredProduct = (await (await fetch(`${baseUrl}/api/products`)).json()).find(item => Number(item.id) === Number(product.id));
  assert.equal(Number(restoredProduct.stock), beforeStock);
});

test('administration confirms orders once and records sales', async () => {
  const [product] = await (await fetch(`${baseUrl}/api/products`)).json();
  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Cliente Pago', email: 'pago@example.com', phone: '88880002' },
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: 'cash_pickup',
    }),
  });
  const order = await orderResponse.json();
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'orders-test-admin', password: 'orders-test-only-password' }),
  });
  const { token } = await loginResponse.json();
  const confirmResponse = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'paid' }),
  });
  assert.equal(confirmResponse.status, 200);
  const sales = await (await fetch(`${baseUrl}/api/sales`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(sales.some(sale => sale.customer === 'Cliente Pago' && sale.method === 'Efectivo al retirar'));

  const repeatResponse = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'paid' }),
  });
  assert.equal(repeatResponse.status, 409);
});

test('reports period totals, saves one closeout, and audits stock counts', async () => {
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'orders-test-admin', password: 'orders-test-only-password' }),
  });
  const { token } = await loginResponse.json();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const sales = await (await fetch(`${baseUrl}/api/sales`, { headers })).json();
  assert.ok(sales.length > 0);
  const saleDate = sales[0].date;

  const dailyResponse = await fetch(`${baseUrl}/api/reports/period?type=daily&date=${saleDate}`, { headers });
  assert.equal(dailyResponse.status, 200);
  const daily = await dailyResponse.json();
  assert.equal(daily.salesCount, 1);
  assert.equal(daily.unitsSold, 1);

  const [product] = await (await fetch(`${baseUrl}/api/products`)).json();
  const countedStock = Number(product.stock) + 3;
  const countResponse = await fetch(`${baseUrl}/api/admin/stock-counts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'Prueba de conteo', items: [{ productId: product.id, stock: countedStock }] }),
  });
  assert.equal(countResponse.status, 201);
  const count = await countResponse.json();
  assert.equal(count.adjustments.length, 1);
  assert.equal(count.adjustments[0].previousStock, Number(product.stock));
  assert.equal(count.adjustments[0].countedStock, countedStock);

  const updatedProduct = (await (await fetch(`${baseUrl}/api/products`)).json()).find(item => Number(item.id) === Number(product.id));
  assert.equal(Number(updatedProduct.stock), countedStock);
  const history = await (await fetch(`${baseUrl}/api/admin/stock-adjustments`, { headers })).json();
  assert.ok(history.some(adjustment => adjustment.reason === 'Prueba de conteo'));

  for (const period of ['daily', 'weekly', 'monthly']) {
    const response = await fetch(`${baseUrl}/api/admin/closeouts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ periodType: period, date: saleDate }),
    });
    assert.equal(response.status, 201);
    const closeout = await response.json();
    assert.equal(closeout.periodType, period);
    assert.ok(Array.isArray(closeout.inventorySnapshot));
    const periodStartDate = new Date(`${closeout.periodStart}T12:00:00Z`);
    if (period === 'daily') {
      assert.equal(closeout.periodEnd, closeout.periodStart);
    } else if (period === 'weekly') {
      assert.equal(new Date(`${closeout.periodStart}T12:00:00Z`).getUTCDay(), 1);
      const weekEnd = new Date(`${closeout.periodStart}T12:00:00Z`);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      assert.equal(closeout.periodEnd, weekEnd.toISOString().slice(0, 10));
    } else {
      assert.equal(closeout.periodStart.slice(8), '01');
      assert.equal(Number(closeout.periodEnd.slice(8)), new Date(Date.UTC(periodStartDate.getUTCFullYear(), periodStartDate.getUTCMonth() + 1, 0)).getUTCDate());
    }

    const duplicate = await fetch(`${baseUrl}/api/admin/closeouts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ periodType: period, date: saleDate }),
    });
    assert.equal(duplicate.status, 409);
  }
});