const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '.env'),
  override: !process.env.NODE_ENV || process.env.NODE_ENV === 'development',
});

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Readable } = require('stream');
const { auth: googleAuth, drive: googleDrive } = require('@googleapis/drive');

const app = express();
const port = Number(process.env.PORT) || 5000;
const backendUrl = process.env.BACKEND_URL || `http://localhost:${port}`;

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
const drive = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN && driveFolderId
  ? (() => {
      const oauth = new googleAuth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      return googleDrive({ version: 'v3', auth: oauth });
    })()
  : null;
const storage = drive
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const extension = path.extname(file.originalname) || '.jpg';
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
        cb(null, uniqueName);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes'));
    }
    cb(null, true);
  }
});

// Devuelve la URL pública de la imagen subida (Google Drive o carpeta local), o null si no hay archivo.
const resolveUploadedImage = async (file) => {
  if (!file) return null;
  if (drive) {
    const extension = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
    const { data } = await drive.files.create({
      requestBody: { name, parents: [driveFolderId] },
      media: { mimeType: file.mimetype, body: Readable.from(file.buffer) },
      fields: 'id'
    });
    await drive.permissions.create({ fileId: data.id, requestBody: { role: 'reader', type: 'anyone' } });
    return `https://lh3.googleusercontent.com/d/${data.id}`;
  }
  return `${backendUrl}/uploads/${file.filename}`;
};
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(uploadsDir));

const pool = process.env.NODE_ENV !== 'test' && process.env.POSTGRESQL_ADDON_HOST && process.env.POSTGRESQL_ADDON_DB && process.env.POSTGRESQL_ADDON_USER
  ? new Pool({
      host: process.env.POSTGRESQL_ADDON_HOST,
      port: Number(process.env.POSTGRESQL_ADDON_PORT) || 5432,
      database: process.env.POSTGRESQL_ADDON_DB,
      user: process.env.POSTGRESQL_ADDON_USER,
      password: process.env.POSTGRESQL_ADDON_PASSWORD,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    })
  : null;

const defaultProducts = [
  { id: 1, name: 'Crema Hidratante', price: 25.99, category: 'Cuidado Facial', image: 'https://via.placeholder.com/150', stock: 18, barcode: 'LOMIO-1001', sold: 9 },
  { id: 2, name: 'Protector Solar SPF 50', price: 18.5, category: 'Protección Solar', image: 'https://via.placeholder.com/150', stock: 12, barcode: 'LOMIO-1002', sold: 7 },
  { id: 3, name: 'Máscara de Pestañas', price: 12, category: 'Maquillaje', image: 'https://via.placeholder.com/150', stock: 9, barcode: 'LOMIO-1003', sold: 11 },
  { id: 4, name: 'Exfoliante Corporal', price: 15.75, category: 'Cuidado Corporal', image: 'https://via.placeholder.com/150', stock: 6, barcode: 'LOMIO-1004', sold: 5 }
];

const paymentMethodLabels = {
  cash_pickup: 'Efectivo al retirar',
  transfer_bac: 'Transferencia BAC Nicaragua',
  transfer_lafise: 'Transferencia LAFISE',
  card_at_salon: 'Tarjeta al pagar en el estudio',
};

let memoryProducts = defaultProducts.map(product => ({ ...product }));
let memorySales = [];
let memoryOrders = [];
let memoryCloseouts = [];
let memoryStockAdjustments = [];
const adminSessions = new Map();

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expiresAt = adminSessions.get(token);
  if (!token || !expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  }
  next();
}

async function initDB() {
  if (!pool) {
    console.log('⚠️ No hay PostgreSQL configurado. Usando almacenamiento en memoria.');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        category VARCHAR(100),
        image TEXT,
        stock INTEGER DEFAULT 0,
        barcode VARCHAR(50),
        sold INTEGER DEFAULT 0
      );
    `);

    await pool.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS barcode VARCHAR(50),
      ADD COLUMN IF NOT EXISTS sold INTEGER DEFAULT 0;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        customer VARCHAR(255) NOT NULL DEFAULT 'Venta en salón',
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        method VARCHAR(50) NOT NULL,
        total NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_closeouts (
        id SERIAL PRIMARY KEY,
        period_type VARCHAR(10) NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly')),
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        sales_total NUMERIC(12, 2) NOT NULL,
        sales_count INTEGER NOT NULL,
        units_sold INTEGER NOT NULL,
        payment_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
        inventory_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (period_type, period_start)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_adjustments (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        previous_stock INTEGER NOT NULL,
        counted_stock INTEGER NOT NULL,
        reason VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number VARCHAR(40) UNIQUE NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(40) NOT NULL,
        customer_tax_id VARCHAR(80),
        customer_address TEXT,
        subtotal NUMERIC(10, 2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        payment_method VARCHAR(40) NOT NULL DEFAULT 'pay_on_pickup',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS delivery_route TEXT;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        unit_price NUMERIC(10, 2) NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        line_total NUMERIC(10, 2) NOT NULL
      );
    `);

    const { rows } = await pool.query('SELECT COUNT(*) FROM products');
    if (Number(rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO products (name, price, category, image, stock, barcode, sold) VALUES
        ($1, $2, $3, $4, $5, $6, $7),
        ($8, $9, $10, $11, $12, $13, $14),
        ($15, $16, $17, $18, $19, $20, $21),
        ($22, $23, $24, $25, $26, $27, $28)
      `, [
        'Crema Hidratante', 25.99, 'Cuidado Facial', 'https://via.placeholder.com/150', 18, 'LOMIO-1001', 9,
        'Protector Solar SPF 50', 18.5, 'Protección Solar', 'https://via.placeholder.com/150', 12, 'LOMIO-1002', 7,
        'Máscara de Pestañas', 12, 'Maquillaje', 'https://via.placeholder.com/150', 9, 'LOMIO-1003', 11,
        'Exfoliante Corporal', 15.75, 'Cuidado Corporal', 'https://via.placeholder.com/150', 6, 'LOMIO-1004', 5
      ]);
      console.log('✅ Datos iniciales insertados en PostgreSQL');
    }
  } catch (err) {
    console.error('❌ Error al inicializar la base de datos:', err.message);
  }
}

async function getProducts() {
  if (!pool) {
    return memoryProducts;
  }

  const { rows } = await pool.query('SELECT * FROM products ORDER BY id');
  return rows;
}

async function getProductById(id) {
  if (!pool) {
    return memoryProducts.find(product => Number(product.id) === Number(id)) || null;
  }

  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createProduct(productData) {
  if (!pool) {
    const newProduct = {
      id: Date.now(),
      ...productData,
      price: Number(productData.price)
    };
    memoryProducts = [newProduct, ...memoryProducts];
    return newProduct;
  }

  const { rows } = await pool.query(
    `INSERT INTO products (name, price, category, image, stock, barcode, sold)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      productData.name,
      Number(productData.price),
      productData.category || 'Sin categoría',
      productData.image || 'https://via.placeholder.com/150',
      Number(productData.stock || 0),
      productData.barcode || 'LOMIO-' + Date.now().toString().slice(-8),
      Number(productData.sold || 0)
    ]
  );

  return rows[0];
}

async function updateProduct(id, productData) {
  if (!pool) {
    const index = memoryProducts.findIndex(product => Number(product.id) === Number(id));
    if (index === -1) return null;

    memoryProducts[index] = {
      ...memoryProducts[index],
      ...productData,
      id: Number(id),
      price: Number(productData.price)
    };

    return memoryProducts[index];
  }

  const { rows } = await pool.query(
    `UPDATE products
     SET name = $1,
         price = $2,
         category = $3,
         image = $4,
         stock = $5,
         barcode = $6,
         sold = $7
     WHERE id = $8
     RETURNING *`,
    [
      productData.name,
      Number(productData.price),
      productData.category || 'Sin categoría',
      productData.image || 'https://via.placeholder.com/150',
      Number(productData.stock || 0),
      productData.barcode || 'LOMIO-' + Date.now().toString().slice(-8),
      Number(productData.sold || 0),
      id
    ]
  );

  return rows[0] || null;
}

async function deleteProduct(id) {
  if (!pool) {
    const before = memoryProducts.length;
    memoryProducts = memoryProducts.filter(product => Number(product.id) !== Number(id));
    return before !== memoryProducts.length;
  }

  const result = await pool.query('DELETE FROM products WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function getSales() {
  if (!pool) return memorySales;
  const { rows } = await pool.query(`
    SELECT id, product_name AS product, customer, quantity, method,
           total, TO_CHAR(created_at, 'YYYY-MM-DD') AS date
    FROM sales ORDER BY created_at DESC
  `);
  return rows;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getPeriodRange(type, requestedDate) {
  if (!['daily', 'weekly', 'monthly'].includes(type)) return null;
  const selectedDate = requestedDate || dateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return null;
  const [year, month, day] = selectedDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (dateKey(date) !== selectedDate) return null;
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day);
  if (type === 'weekly') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 6);
  } else if (type === 'monthly') {
    start.setDate(1);
    end.setMonth(end.getMonth() + 1, 0);
  }
  return { type, start: dateKey(start), end: dateKey(end) };
}

function calculatePeriodSummary(rows, range, inventory = []) {
  const salesTotal = Number(rows.reduce((total, sale) => total + Number(sale.total || 0), 0).toFixed(2));
  const paymentTotals = {};
  for (const sale of rows) {
    const method = sale.method || 'Sin especificar';
    paymentTotals[method] = Number(((paymentTotals[method] || 0) + Number(sale.total || 0)).toFixed(2));
  }
  return {
    periodType: range.type,
    periodStart: range.start,
    periodEnd: range.end,
    salesTotal,
    salesCount: rows.length,
    unitsSold: rows.reduce((total, sale) => total + Number(sale.quantity || 0), 0),
    paymentTotals,
    inventoryValue: Number(inventory.reduce((total, product) => total + Number(product.price || 0) * Number(product.stock || 0), 0).toFixed(2)),
  };
}

async function getPeriodSales(range) {
  if (!pool) {
    return memorySales.filter(sale => sale.date >= range.start && sale.date <= range.end);
  }
  const { rows } = await pool.query(`
    SELECT id, product_name AS product, customer, quantity, method, total,
      TO_CHAR(created_at, 'YYYY-MM-DD') AS date
    FROM sales
    WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
    ORDER BY created_at DESC
  `, [range.start, range.end]);
  return rows;
}

async function getCloseouts() {
  if (!pool) return memoryCloseouts;
  const { rows } = await pool.query(`
    SELECT id, period_type AS "periodType", TO_CHAR(period_start, 'YYYY-MM-DD') AS "periodStart",
      TO_CHAR(period_end, 'YYYY-MM-DD') AS "periodEnd", sales_total AS "salesTotal",
      sales_count AS "salesCount", units_sold AS "unitsSold", payment_totals AS "paymentTotals",
      inventory_snapshot AS "inventorySnapshot", TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt"
    FROM cash_closeouts ORDER BY period_start DESC, created_at DESC
  `);
  return rows;
}

async function createCloseout(range) {
  const existing = (await getCloseouts()).find(item => item.periodType === range.type && item.periodStart === range.start);
  if (existing) return { error: 'Ya existe un cierre para este periodo.', status: 409, closeout: existing };
  const [periodSales, inventory] = await Promise.all([getPeriodSales(range), getProducts()]);
  const summary = calculatePeriodSummary(periodSales, range, inventory);
  const inventorySnapshot = inventory.map(product => ({
    productId: product.id,
    productName: product.name,
    stock: Number(product.stock || 0),
    unitPrice: Number(product.price || 0),
  }));
  if (!pool) {
    const closeout = { id: Date.now(), ...summary, inventorySnapshot, createdAt: new Date().toISOString() };
    memoryCloseouts.unshift(closeout);
    return { closeout };
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO cash_closeouts
        (period_type, period_start, period_end, sales_total, sales_count, units_sold, payment_totals, inventory_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, period_type AS "periodType", TO_CHAR(period_start, 'YYYY-MM-DD') AS "periodStart",
        TO_CHAR(period_end, 'YYYY-MM-DD') AS "periodEnd", sales_total AS "salesTotal",
        sales_count AS "salesCount", units_sold AS "unitsSold", payment_totals AS "paymentTotals",
        inventory_snapshot AS "inventorySnapshot", TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt"
    `, [range.type, range.start, range.end, summary.salesTotal, summary.salesCount, summary.unitsSold, JSON.stringify(summary.paymentTotals), JSON.stringify(inventorySnapshot)]);
    return { closeout: rows[0] };
  } catch (error) {
    if (error.code === '23505') return { error: 'Ya existe un cierre para este periodo.', status: 409 };
    throw error;
  }
}

async function getStockAdjustments() {
  if (!pool) return memoryStockAdjustments;
  const { rows } = await pool.query(`
    SELECT id, product_id AS "productId", product_name AS "productName",
      previous_stock AS "previousStock", counted_stock AS "countedStock",
      reason, TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt"
    FROM stock_adjustments ORDER BY created_at DESC LIMIT 200
  `);
  return rows;
}

async function applyStockCount(items, reason) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    return { error: 'Selecciona al menos un producto para el conteo.' };
  }
  const counts = new Map();
  for (const item of items) {
    const productId = Number(item.productId);
    const stock = Number(item.stock);
    if (!Number.isInteger(productId) || !Number.isInteger(stock) || stock < 0) {
      return { error: 'Las existencias contadas deben ser números enteros iguales o mayores que cero.' };
    }
    if (counts.has(productId)) return { error: 'Un producto aparece más de una vez en el conteo.' };
    counts.set(productId, stock);
  }
  const normalizedReason = String(reason || '').trim().slice(0, 255) || 'Conteo físico de inventario';
  if (!pool) {
    const products = [...counts.keys()].map(id => memoryProducts.find(product => Number(product.id) === id));
    if (products.some(product => !product)) return { error: 'No se encontró uno de los productos del conteo.', status: 404 };
    const adjustments = [];
    products.forEach(product => {
      const countedStock = counts.get(Number(product.id));
      const previousStock = Number(product.stock || 0);
      if (previousStock === countedStock) return;
      product.stock = countedStock;
      adjustments.push({
        id: Date.now() + adjustments.length,
        productId: product.id,
        productName: product.name,
        previousStock,
        countedStock,
        reason: normalizedReason,
        createdAt: new Date().toISOString(),
      });
    });
    memoryStockAdjustments = [...adjustments, ...memoryStockAdjustments];
    return { adjustments };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adjustments = [];
    for (const [productId, countedStock] of counts) {
      const result = await client.query('SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE', [productId]);
      const product = result.rows[0];
      if (!product) {
        await client.query('ROLLBACK');
        return { error: 'No se encontró uno de los productos del conteo.', status: 404 };
      }
      const previousStock = Number(product.stock || 0);
      if (previousStock === countedStock) continue;
      await client.query('UPDATE products SET stock = $1 WHERE id = $2', [countedStock, productId]);
      const { rows } = await client.query(`
        INSERT INTO stock_adjustments (product_id, product_name, previous_stock, counted_stock, reason)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, product_id AS "productId", product_name AS "productName",
          previous_stock AS "previousStock", counted_stock AS "countedStock", reason,
          TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt"
      `, [productId, product.name, previousStock, countedStock, normalizedReason]);
      adjustments.push(rows[0]);
    }
    await client.query('COMMIT');
    return { adjustments };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/api/reports/period', requireAdmin, async (req, res) => {
  const range = getPeriodRange(req.query.type, req.query.date);
  if (!range) return res.status(400).json({ error: 'Selecciona un periodo y una fecha válidos.' });
  try {
    const [periodSales, inventory, closeouts] = await Promise.all([
      getPeriodSales(range),
      getProducts(),
      getCloseouts(),
    ]);
    res.json({ ...calculatePeriodSummary(periodSales, range, inventory), sales: periodSales, closeouts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/closeouts', requireAdmin, async (_req, res) => {
  try {
    res.json(await getCloseouts());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/closeouts', requireAdmin, async (req, res) => {
  const range = getPeriodRange(req.body?.periodType, req.body?.date);
  if (!range) return res.status(400).json({ error: 'Selecciona un periodo y una fecha válidos.' });
  try {
    const result = await createCloseout(range);
    if (result.error) return res.status(result.status).json(result);
    res.status(201).json(result.closeout);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/stock-adjustments', requireAdmin, async (_req, res) => {
  try {
    res.json(await getStockAdjustments());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/stock-counts', requireAdmin, async (req, res) => {
  try {
    const result = await applyStockCount(req.body?.items, req.body?.reason);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function registerSale({ productId, quantity, customer, method }) {
  if (!pool) {
    const product = memoryProducts.find(item => Number(item.id) === Number(productId));
    if (!product) return { error: 'Producto no encontrado', status: 404 };
    if (quantity > Number(product.stock)) return { error: 'Stock insuficiente', status: 400 };
    product.stock = Number(product.stock) - quantity;
    product.sold = Number(product.sold || 0) + quantity;
    const sale = {
      id: Date.now(), product: product.name, customer, quantity, method,
      total: Number(product.price) * quantity, date: new Date().toISOString().slice(0, 10)
    };
    memorySales.unshift(sale);
    return { sale, product };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);
    const product = result.rows[0];
    if (!product) {
      await client.query('ROLLBACK');
      return { error: 'Producto no encontrado', status: 404 };
    }
    if (quantity > Number(product.stock)) {
      await client.query('ROLLBACK');
      return { error: 'Stock insuficiente', status: 400 };
    }
    await client.query('UPDATE products SET stock = stock - $1, sold = sold + $1 WHERE id = $2', [quantity, productId]);
    const { rows } = await client.query(`
      INSERT INTO sales (product_id, product_name, customer, quantity, method, total)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, product_name AS product, customer, quantity, method,
                total, TO_CHAR(created_at, 'YYYY-MM-DD') AS date
    `, [productId, product.name, customer, quantity, method, Number(product.price) * quantity]);
    await client.query('COMMIT');
    return { sale: rows[0], product: { ...product, stock: Number(product.stock) - quantity, sold: Number(product.sold || 0) + quantity } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return { error: 'El carrito está vacío o contiene demasiados productos.' };
  }
  const quantities = new Map();
  for (const item of items) {
    const productId = Number(item.productId);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return { error: 'Revisa las cantidades del carrito.' };
    }
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return { items: [...quantities].map(([productId, quantity]) => ({ productId, quantity })) };
}

function validateCustomer(body = {}) {
  const customer = {
    name: String(body.name || '').trim().slice(0, 255),
    email: String(body.email || '').trim().slice(0, 255),
    phone: String(body.phone || '').trim().slice(0, 40),
    taxId: String(body.taxId || '').trim().slice(0, 80),
    address: String(body.address || '').trim().slice(0, 500),
    deliveryRoute: String(body.deliveryRoute || '').trim().slice(0, 500),
  };
  if (!customer.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) || !customer.phone) {
    return { error: 'Indica nombre, un correo válido y teléfono.' };
  }
  return { customer };
}

async function createOrder(items, customer, paymentMethod) {
  const orderNumber = `LM-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  if (!pool) {
    const reservedItems = [];
    for (const item of items) {
      const product = memoryProducts.find(entry => Number(entry.id) === item.productId);
      if (!product) return { error: 'Uno de los productos ya no está disponible.', status: 409 };
      if (Number(product.stock) < item.quantity) return { error: `Stock insuficiente para ${product.name}.`, status: 409 };
      reservedItems.push({ product, quantity: item.quantity });
    }
    const lines = reservedItems.map(({ product, quantity }) => ({
      productId: product.id,
      productName: product.name,
      unitPrice: Number(product.price),
      quantity,
      lineTotal: Number((Number(product.price) * quantity).toFixed(2)),
    }));
    const order = {
      id: Date.now(), orderNumber, ...customer,
      subtotal: Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2)),
      status: 'pending', paymentMethod,
      date: new Date().toISOString().slice(0, 10), items: lines,
    };
    reservedItems.forEach(({ product, quantity }) => { product.stock = Number(product.stock) - quantity; });
    memoryOrders.unshift(order);
    return { order };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lines = [];
    for (const item of items) {
      const result = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
      const product = result.rows[0];
      if (!product || Number(product.stock) < item.quantity) {
        await client.query('ROLLBACK');
        return { error: product ? `Stock insuficiente para ${product.name}.` : 'Uno de los productos ya no está disponible.', status: 409 };
      }
      lines.push({
        productId: product.id,
        productName: product.name,
        unitPrice: Number(product.price),
        quantity: item.quantity,
        lineTotal: Number((Number(product.price) * item.quantity).toFixed(2)),
      });
    }
    const subtotal = Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2));
    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_name, customer_email, customer_phone, customer_tax_id, customer_address, delivery_route, subtotal, payment_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, order_number, customer_name, customer_email,
        customer_phone, customer_tax_id, customer_address, delivery_route, subtotal, status, payment_method,
        TO_CHAR(created_at, 'YYYY-MM-DD') AS date
    `, [orderNumber, customer.name, customer.email, customer.phone, customer.taxId || null, customer.address || null, customer.deliveryRoute || null, subtotal, paymentMethod]);
    const order = orderResult.rows[0];
    for (const line of lines) {
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [line.quantity, line.productId]);
      await client.query(`
        INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [order.id, line.productId, line.productName, line.unitPrice, line.quantity, line.lineTotal]);
    }
    await client.query('COMMIT');
    return {
      order: {
        id: order.id,
        orderNumber: order.order_number,
        name: order.customer_name,
        email: order.customer_email,
        phone: order.customer_phone,
        taxId: order.customer_tax_id,
        address: order.customer_address,
        deliveryRoute: order.delivery_route,
        subtotal: order.subtotal,
        status: order.status,
        paymentMethod: order.payment_method,
        date: order.date,
        items: lines,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getOrders() {
  if (!pool) return memoryOrders;
  const { rows } = await pool.query(`
    SELECT id, order_number AS "orderNumber", customer_name AS name, customer_email AS email,
      customer_phone AS phone, customer_tax_id AS "taxId", customer_address AS address,
      delivery_route AS "deliveryRoute",
      subtotal, status, payment_method AS "paymentMethod", TO_CHAR(created_at, 'YYYY-MM-DD') AS date
    FROM orders ORDER BY created_at DESC
  `);
  for (const order of rows) {
    const result = await pool.query(`
      SELECT product_id AS "productId", product_name AS "productName", unit_price AS "unitPrice",
        quantity, line_total AS "lineTotal" FROM order_items WHERE order_id = $1 ORDER BY id
    `, [order.id]);
    order.items = result.rows;
  }
  return rows;
}

async function updateOrderStatus(id, status) {
  if (!pool) {
    const order = memoryOrders.find(entry => Number(entry.id) === Number(id));
    if (!order) return { error: 'Pedido no encontrado.', status: 404 };
    if (order.status !== 'pending') return { error: 'Este pedido ya fue procesado.', status: 409 };
    if (status === 'cancelled') {
      for (const line of order.items) {
        const product = memoryProducts.find(entry => Number(entry.id) === Number(line.productId));
        if (product) product.stock = Number(product.stock) + Number(line.quantity);
      }
    } else {
      for (const line of order.items) {
        const product = memoryProducts.find(entry => Number(entry.id) === Number(line.productId));
        if (product) product.sold = Number(product.sold || 0) + Number(line.quantity);
        memorySales.unshift({
          id: Date.now() + Number(line.productId), product: line.productName, customer: order.name,
          quantity: Number(line.quantity), method: paymentMethodLabels[order.paymentMethod] || order.paymentMethod, total: Number(line.lineTotal), date: order.date,
        });
      }
    }
    order.status = status;
    return { order };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    const order = result.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return { error: 'Pedido no encontrado.', status: 404 };
    }
    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return { error: 'Este pedido ya fue procesado.', status: 409 };
    }
    const { rows: lines } = await client.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    if (status === 'cancelled') {
      for (const line of lines) {
        if (line.product_id) await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [line.quantity, line.product_id]);
      }
    } else {
      for (const line of lines) {
        if (line.product_id) await client.query('UPDATE products SET sold = sold + $1 WHERE id = $2', [line.quantity, line.product_id]);
        await client.query(`
          INSERT INTO sales (product_id, product_name, customer, quantity, method, total)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [line.product_id, line.product_name, order.customer_name, line.quantity, paymentMethodLabels[order.payment_method] || order.payment_method, line.line_total]);
      }
    }
    await client.query('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
    await client.query('COMMIT');
    return { order: { id: Number(id), orderNumber: order.order_number, status } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.post('/api/orders', async (req, res) => {
  const itemResult = normalizeOrderItems(req.body?.items);
  if (itemResult.error) return res.status(400).json({ error: itemResult.error });
  const customerResult = validateCustomer(req.body?.customer);
  if (customerResult.error) return res.status(400).json({ error: customerResult.error });
  const allowedPaymentMethods = ['cash_pickup', 'transfer_bac', 'transfer_lafise', 'card_at_salon'];
  const paymentMethod = String(req.body?.paymentMethod || '');
  if (!allowedPaymentMethods.includes(paymentMethod)) {
    return res.status(400).json({ error: 'Selecciona una forma de pago disponible.' });
  }
  try {
    const result = await createOrder(itemResult.items, customerResult.customer, paymentMethod);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.order);
  } catch (error) {
    res.status(500).json({ error: 'No se pudo registrar el pedido.' });
  }
});

app.get('/api/orders', requireAdmin, async (_req, res) => {
  try {
    res.json(await getOrders());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  const status = req.body?.status;
  if (!['paid', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Estado no válido.' });
  try {
    const result = await updateOrderStatus(req.params.id, status);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Configura ADMIN_USERNAME y ADMIN_PASSWORD en Backend/.env.' });
  }
  if (!safeEqual(username, process.env.ADMIN_USERNAME) || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  res.json({ token, expiresIn: 8 * 60 * 60 });
});

app.get('/api/admin/session', requireAdmin, (_req, res) => res.json({ authenticated: true }));
app.get('/api/sales', requireAdmin, async (_req, res) => {
  try {
    res.json(await getSales());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sales', requireAdmin, async (req, res) => {
  const productId = Number(req.body?.productId);
  const quantity = Number(req.body?.quantity);
  const method = String(req.body?.method || 'Efectivo');
  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'Selecciona un producto y una cantidad válida.' });
  }
  if (!['Efectivo', 'Tarjeta', 'Transferencia'].includes(method)) {
    return res.status(400).json({ error: 'Método de pago no válido.' });
  }
  try {
    const result = await registerSale({
      productId,
      quantity,
      customer: String(req.body?.customer || 'Venta en salón').trim().slice(0, 255),
      method,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const products = await getProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await getProductById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'No encontrado' });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, price, category, imageUrl, stock, barcode } = req.body;

    if (!name || price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }

    const productImage = (await resolveUploadedImage(req.file))
      || imageUrl || 'https://via.placeholder.com/150';

    const product = await createProduct({
      name,
      price: Number(price),
      category: category || 'Sin categoría',
      image: productImage,
      stock: Number(stock || 0),
      barcode: barcode || 'LOMIO-' + Date.now().toString().slice(-8),
      sold: 0
    });

    res.status(201).json(product);
  } catch (err) {
    console.error('Error creando producto:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, price, category, imageUrl, stock, barcode, sold } = req.body;

    if (!name || price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }

    const productImage = (await resolveUploadedImage(req.file))
      || imageUrl || 'https://via.placeholder.com/150';

    const updated = await updateProduct(req.params.id, {
      name,
      price: Number(price),
      category: category || 'Sin categoría',
      image: productImage,
      stock: Number(stock || 0),
      barcode: barcode || 'LOMIO-' + Date.now().toString().slice(-8),
      sold: Number(sold || 0)
    });

    if (!updated) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    res.json(updated);
  } catch (err) {
    console.error('Error actualizando producto:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await deleteProduct(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    res.json({ message: 'Producto eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB();

app.listen(port, () => {
  console.log(`🚀 Servidor backend en http://localhost:${port}`);
});