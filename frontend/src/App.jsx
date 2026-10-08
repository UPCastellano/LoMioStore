import { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import logoImage from './assets/lomio-logo.png';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const HERO_IMAGE = 'https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&w=900&q=85';
const IMAGE_FALLBACK = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 480'><rect width='400' height='480' fill='#e9eee7'/><g fill='none' stroke='#9aa896' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'><rect x='140' y='170' width='120' height='120' rx='12'/><circle cx='200' cy='230' r='14'/><path d='M140 275l40-40 30 30 20-20 30 30'/></g><text x='200' y='340' font-family='sans-serif' font-size='20' fill='#777d73' text-anchor='middle'>Sin imagen</text></svg>")}`;
const emptyForm = () => ({ name: '', category: '', price: '', stock: '0', barcode: `LM-${Date.now().toString().slice(-8)}`, imageUrl: '' });
const currency = (value) => new Intl.NumberFormat('es-NI', { style: 'currency', currency: import.meta.env.VITE_CURRENCY || 'NIO' }).format(Number(value) || 0);
const paymentMethodLabels = {
  cash_pickup: 'Efectivo al retirar',
  transfer_bac: 'Transferencia BAC Nicaragua',
  transfer_lafise: 'Transferencia LAFISE',
  card_at_salon: 'Tarjeta al pagar en el estudio',
};
const normalizeOrder = (order) => ({
  ...order,
  orderNumber: order.orderNumber ?? order.order_number ?? '',
  name: order.name ?? order.customer_name ?? '',
  email: order.email ?? order.customer_email ?? '',
  phone: order.phone ?? order.customer_phone ?? '',
  taxId: order.taxId ?? order.tax_id ?? order.customer_tax_id ?? '',
  deliveryRoute: order.deliveryRoute ?? order.delivery_route ?? '',
  paymentMethod: order.paymentMethod ?? order.payment_method ?? 'cash_pickup',
  date: order.date ?? order.created_at ?? '',
  items: Array.isArray(order.items) ? order.items.map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unitPrice ?? item.unit_price ?? 0);
    return {
      productId: item.productId ?? item.product_id ?? item.id,
      productName: item.productName ?? item.product_name ?? item.name ?? 'Producto',
      unitPrice,
      quantity,
      lineTotal: Number(item.lineTotal ?? item.line_total ?? unitPrice * quantity),
    };
  }) : [],
});
const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const periodRange = (period, dateValue) => {
  const [year, month, day] = dateValue.split('-').map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day);
  if (period === 'weekly') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 6);
  } else if (period === 'monthly') {
    start.setDate(1);
    end.setMonth(end.getMonth() + 1, 0);
  }
  return { start: localDateKey(start), end: localDateKey(end) };
};
const previousPeriodRange = (period, range) => {
  const start = new Date(`${range.start}T12:00:00`);
  const end = new Date(`${range.end}T12:00:00`);
  if (period === 'daily') {
    start.setDate(start.getDate() - 1);
    end.setTime(start.getTime());
  } else if (period === 'weekly') {
    start.setDate(start.getDate() - 7);
    end.setDate(end.getDate() - 7);
  } else {
    start.setMonth(start.getMonth() - 1, 1);
    end.setTime(start.getTime());
    end.setMonth(end.getMonth() + 1, 0);
  }
  return { start: localDateKey(start), end: localDateKey(end) };
};

async function request(path, options = {}, token = '') {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new Error(`No hay conexión con el servidor (${API_URL}). Inicia Backend y abre la tienda en el puerto 5173.`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la solicitud.');
  return payload;
}

function BrandLogo({ className = '' }) {
  return <img className={`brand-logo ${className}`.trim()} src={logoImage} alt="Lo Mío Store Online" width="912" height="345" />;
}

function Barcode({ value }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value) {
      JsBarcode(ref.current, value, { format: 'CODE128', lineColor: '#252b26', width: 1.35, height: 34, displayValue: false, margin: 0 });
    }
  }, [value]);
  return <svg ref={ref} className="barcode-svg" role="img" aria-label={`Código de barras ${value}`} />;
}

function ProductImage({ src, alt, className = '' }) {
  return (
    <img
      className={className}
      src={src || IMAGE_FALLBACK}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(event) => {
        if (event.currentTarget.src !== IMAGE_FALLBACK) event.currentTarget.src = IMAGE_FALLBACK;
      }}
    />
  );
}

function App() {
  const [screen, setScreen] = useState('store');
  const [section, setSection] = useState('inventory');
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [orders, setOrders] = useState([]);
  const [closeouts, setCloseouts] = useState([]);
  const [stockAdjustments, setStockAdjustments] = useState([]);
  const [reportPeriod, setReportPeriod] = useState('daily');
  const [reportDate, setReportDate] = useState(() => localDateKey(new Date()));
  const [periodSummary, setPeriodSummary] = useState(null);
  const [stockCountOpen, setStockCountOpen] = useState(false);
  const [stockCountReason, setStockCountReason] = useState('Conteo físico de inventario');
  const [stockCountValues, setStockCountValues] = useState({});
  const [cart, setCart] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('lomio-cart') || '[]');
    } catch {
      return [];
    }
  });
  const [checkoutForm, setCheckoutForm] = useState({ name: '', email: '', phone: '', taxId: '', address: '', deliveryRoute: '' });
  const [paymentMethod, setPaymentMethod] = useState('cash_pickup');
  const [lastOrder, setLastOrder] = useState(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [token, setToken] = useState(() => sessionStorage.getItem('lomio-admin-token') || '');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');
  const cameraInputRef = useRef(null);
  const libraryInputRef = useRef(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [login, setLogin] = useState({ username: '', password: '' });
  const [previewProduct, setPreviewProduct] = useState(null);
  const [saleForm, setSaleForm] = useState({ productId: '', quantity: 1, customer: '', method: 'Efectivo' });

  useEffect(() => {
    localStorage.setItem('lomio-cart', JSON.stringify(cart));
  }, [cart]);

  useEffect(() => () => {
    if (imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!previewProduct) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setPreviewProduct(null); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [previewProduct]);

  useEffect(() => {
    request('/api/products')
      .then((data) => setProducts(data.map((product) => ({ ...product, price: Number(product.price), stock: Number(product.stock || 0), sold: Number(product.sold || 0) }))))
      .catch((loadError) => setError(loadError.message))
      .finally(() => setProductsLoading(false));
  }, []);

  useEffect(() => {
    if (!token) return;
    request('/api/admin/session', {}, token)
      .catch(() => {
        sessionStorage.removeItem('lomio-admin-token');
        setToken('');
      });
  }, [token]);

  useEffect(() => {
    if (screen !== 'admin' || !token) return;
    request('/api/sales', {}, token)
      .then(setSales)
      .catch((loadError) => setError(loadError.message));
    request('/api/orders', {}, token)
      .then((data) => setOrders(Array.isArray(data) ? data.map(normalizeOrder) : []))
      .catch((loadError) => setError(loadError.message));
  }, [screen, token]);

  useEffect(() => {
    if (screen !== 'admin' || !token || section !== 'reports') return;
    const query = new URLSearchParams({ type: reportPeriod, date: reportDate });
    request(`/api/reports/period?${query}`, {}, token)
      .then(setPeriodSummary)
      .catch((loadError) => setError(loadError.message));
    request('/api/admin/closeouts', {}, token)
      .then(setCloseouts)
      .catch((loadError) => setError(loadError.message));
    request('/api/admin/stock-adjustments', {}, token)
      .then(setStockAdjustments)
      .catch((loadError) => setError(loadError.message));
  }, [screen, token, section, reportPeriod, reportDate]);

  const visibleProducts = useMemo(() => products.filter((product) => product.stock > 0), [products]);
  const filteredProducts = useMemo(() => products.filter((product) => {
    const query = search.toLocaleLowerCase('es');
    return `${product.name} ${product.category} ${product.barcode}`.toLocaleLowerCase('es').includes(query);
  }), [products, search]);
  const inventoryValue = products.reduce((sum, product) => sum + product.price * product.stock, 0);
  const revenue = sales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const lowStockCount = products.filter((product) => product.stock <= 5).length;
  const activeRange = periodRange(reportPeriod, reportDate);
  const previousRange = previousPeriodRange(reportPeriod, activeRange);
  const currentPeriodSales = periodSummary?.sales || [];
  const previousPeriodSales = sales.filter((sale) => sale.date >= previousRange.start && sale.date <= previousRange.end);
  const previousPeriodTotal = previousPeriodSales.reduce((total, sale) => total + Number(sale.total || 0), 0);
  const periodChange = previousPeriodTotal === 0
    ? null
    : ((Number(periodSummary?.salesTotal || 0) - previousPeriodTotal) / previousPeriodTotal) * 100;
  const cartDetails = cart.map((item) => {
    const product = products.find((entry) => Number(entry.id) === Number(item.productId));
    return product ? { ...product, quantity: item.quantity, lineTotal: Number(product.price) * item.quantity } : null;
  }).filter(Boolean);
  const cartTotal = cartDetails.reduce((sum, item) => sum + item.lineTotal, 0);
  const cartCount = cartDetails.reduce((sum, item) => sum + item.quantity, 0);

  const refreshProducts = async () => {
    const data = await request('/api/products');
    setProducts(data.map((product) => ({ ...product, price: Number(product.price), stock: Number(product.stock || 0), sold: Number(product.sold || 0) })));
  };

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyForm());
    setImageFile(null);
    setImagePreview('');
    setError('');
    setFormOpen(true);
  };

  const openEditForm = (product) => {
    setEditingId(product.id);
    setForm({ name: product.name || '', category: product.category || '', price: String(product.price), stock: String(product.stock), barcode: product.barcode || '', imageUrl: product.image || '' });
    setImageFile(null);
    setImagePreview(product.image || '');
    setError('');
    setFormOpen(true);
  };

  const handleImageChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setForm((current) => ({ ...current, imageUrl: '' }));
    event.target.value = '';
  };

  const saveProduct = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = new FormData();
      Object.entries(form).forEach(([key, value]) => payload.append(key, String(value)));
      if (imageFile) payload.append('image', imageFile);
      const path = editingId ? `/api/products/${editingId}` : '/api/products';
      await request(path, { method: editingId ? 'PUT' : 'POST', body: payload }, token);
      await refreshProducts();
      setFormOpen(false);
      setNotice(editingId ? 'Producto actualizado.' : 'Producto agregado al inventario.');
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteProduct = async (product) => {
    if (!window.confirm(`¿Eliminar ${product.name} del inventario?`)) return;
    setError('');
    try {
      await request(`/api/products/${product.id}`, { method: 'DELETE' }, token);
      setProducts((current) => current.filter((item) => item.id !== product.id));
      setNotice('Producto eliminado.');
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const submitLogin = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const result = await request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(login),
      });
      sessionStorage.setItem('lomio-admin-token', result.token);
      setToken(result.token);
      setLogin({ username: '', password: '' });
      setScreen('admin');
      setSection('inventory');
    } catch (loginError) {
      setError(loginError.message);
    }
  };

  const logout = () => {
    sessionStorage.removeItem('lomio-admin-token');
    setToken('');
    setSales([]);
    setOrders([]);
    setScreen('store');
    setNotice('Sesión administrativa cerrada.');
  };

  const addToCart = (product) => {
    if (Number(product.stock) < 1) {
      setNotice('Este producto ya no tiene existencias disponibles.');
      return;
    }
    setCart((current) => {
      const existing = current.find((item) => Number(item.productId) === Number(product.id));
      if (existing) {
        return current.map((item) => Number(item.productId) === Number(product.id)
          ? { ...item, quantity: Math.min(Number(product.stock), Number(item.quantity) + 1) }
          : item);
      }
      return [...current, { productId: product.id, quantity: 1 }];
    });
    setNotice(`${product.name} se agregó a tu carrito.`);
  };

  const changeCartQuantity = (productId, delta) => {
    const product = products.find((item) => Number(item.id) === Number(productId));
    setCart((current) => current.map((item) => Number(item.productId) === Number(productId)
      ? { ...item, quantity: Math.min(Number(product?.stock ?? 0), Number(item.quantity) + delta) }
      : item).filter((item) => item.quantity > 0));
  };

  const placeOrder = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    const checkoutItems = cartDetails.map((item) => ({
      productId: item.id,
      productName: item.name,
      unitPrice: Number(item.price),
      quantity: Number(item.quantity),
      lineTotal: Number(item.lineTotal),
    }));
    try {
      const response = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: checkoutForm,
          paymentMethod,
          items: cart.map(({ productId, quantity }) => ({ productId, quantity })),
        }),
      });
      const normalizedOrder = normalizeOrder(response);
      const order = {
        ...normalizedOrder,
        items: normalizedOrder.items.length ? normalizedOrder.items : checkoutItems,
      };
      setLastOrder(order);
      setCart([]);
      setProducts((current) => current.map((product) => {
        const line = order.items.find((item) => Number(item.productId) === Number(product.id));
        return line ? { ...product, stock: Math.max(0, product.stock - Number(line.quantity)) } : product;
      }));
      setCheckoutForm({ name: '', email: '', phone: '', taxId: '', address: '', deliveryRoute: '' });
      setPaymentMethod('cash_pickup');
      setScreen('invoice');
    } catch (orderError) {
      setError(orderError.message);
    } finally {
      setSaving(false);
    }
  };

  const updateOrder = async (order, status) => {
    setError('');
    try {
      await request(`/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }, token);
      const [updatedOrders, updatedSales, updatedProducts] = await Promise.all([
        request('/api/orders', {}, token),
        request('/api/sales', {}, token),
        request('/api/products'),
      ]);
      setOrders(Array.isArray(updatedOrders) ? updatedOrders.map(normalizeOrder) : []);
      setSales(updatedSales);
      setProducts(updatedProducts.map((product) => ({ ...product, price: Number(product.price), stock: Number(product.stock || 0), sold: Number(product.sold || 0) })));
      setNotice(status === 'paid' ? 'Pedido confirmado como pagado.' : 'Pedido cancelado y existencias liberadas.');
    } catch (orderError) {
      setError(orderError.message);
    }
  };

  const [salesRange, setSalesRange] = useState({ from: '', to: '' });

  const deleteSales = async (all) => {
    const { from, to } = salesRange;
    if (!all && !from && !to) { setError('Elige al menos una fecha para eliminar por rango.'); return; }
    const label = all ? 'TODO el historial de ventas' : `las ventas ${from && to ? (from === to ? `del ${from}` : `del ${from} al ${to}`) : from ? `desde el ${from}` : `hasta el ${to}`}`;
    if (!window.confirm(`¿Eliminar ${label}? Esta acción no se puede deshacer.`)) return;
    setError('');
    try {
      const query = all ? '' : `?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`;
      const result = await request(`/api/sales${query}`, { method: 'DELETE' }, token);
      setSales(await request('/api/sales', {}, token));
      setNotice(result.deleted ? `${result.deleted} venta(s) eliminada(s).` : 'No había ventas en ese rango.');
    } catch (salesError) {
      setError(salesError.message);
    }
  };
  const refreshAfterOrderDelete = async () => {
    const [updatedOrders, updatedProducts] = await Promise.all([request('/api/orders', {}, token), request('/api/products')]);
    setOrders(Array.isArray(updatedOrders) ? updatedOrders.map(normalizeOrder) : []);
    setProducts(updatedProducts.map((product) => ({ ...product, price: Number(product.price), stock: Number(product.stock || 0), sold: Number(product.sold || 0) })));
  };

  const deleteOrder = async (order) => {
    const warning = order.status === 'pending' ? ' Las existencias reservadas volverán al inventario.' : '';
    if (!window.confirm(`¿Eliminar el pedido ${order.orderNumber}?${warning}`)) return;
    setError('');
    try {
      await request(`/api/orders/${order.id}`, { method: 'DELETE' }, token);
      await refreshAfterOrderDelete();
      setNotice('Pedido eliminado.');
    } catch (orderError) {
      setError(orderError.message);
    }
  };

  const [ordersRange, setOrdersRange] = useState({ from: '', to: '' });

  const clearOrders = async (all) => {
    const { from, to } = ordersRange;
    if (!all && !from && !to) { setError('Elige al menos una fecha para eliminar por rango.'); return; }
    const label = all ? 'TODOS los pedidos' : `los pedidos ${from && to ? (from === to ? `del ${from}` : `del ${from} al ${to}`) : from ? `desde el ${from}` : `hasta el ${to}`}`;
    if (!window.confirm(`¿Eliminar ${label}? Los pendientes devolverán sus existencias. Esta acción no se puede deshacer.`)) return;
    setError('');
    try {
      const query = all ? '' : `?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`;
      const result = await request(`/api/orders${query}`, { method: 'DELETE' }, token);
      await refreshAfterOrderDelete();
      setNotice(result.deleted ? `${result.deleted} pedido(s) eliminado(s).` : 'No había pedidos en ese rango.');
    } catch (orderError) {
      setError(orderError.message);
    }
  };
  const registerSale = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const result = await request('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...saleForm, quantity: Number(saleForm.quantity) }),
      }, token);
      setSales((current) => [result.sale, ...current]);
      setProducts((current) => current.map((product) => product.id === result.product.id ? { ...product, ...result.product, price: Number(result.product.price) } : product));
      setSaleForm({ productId: '', quantity: 1, customer: '', method: 'Efectivo' });
      setNotice('Venta registrada y stock actualizado.');
    } catch (saleError) {
      setError(saleError.message);
    }
  };

  const exportSales = () => {
    const rows = [['Fecha', 'Producto', 'Cliente', 'Cantidad', 'Método', 'Total'], ...sales.map((sale) => [sale.date, sale.product, sale.customer, sale.quantity, sale.method, sale.total])];
    const content = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'reporte-ventas-lomio.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const saveCloseout = async () => {
    setError('');
    try {
      const closeout = await request('/api/admin/closeouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType: reportPeriod, date: reportDate }),
      }, token);
      setCloseouts((current) => [closeout, ...current]);
      setNotice('Cierre guardado con su historial de caja e inventario.');
    } catch (closeoutError) {
      setError(closeoutError.message);
    }
  };

  const openStockCount = () => {
    setStockCountValues(Object.fromEntries(products.map((product) => [product.id, String(product.stock)])));
    setStockCountReason('Conteo físico de inventario');
    setError('');
    setStockCountOpen(true);
  };

  const saveStockCount = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await request('/api/admin/stock-counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: stockCountReason,
          items: products.map((product) => ({ productId: product.id, stock: Number(stockCountValues[product.id]) })),
        }),
      }, token);
      await refreshProducts();
      setStockAdjustments((current) => [...result.adjustments, ...current]);
      setStockCountOpen(false);
      setNotice(result.adjustments.length ? `Conteo guardado: ${result.adjustments.length} productos ajustados.` : 'Conteo guardado; no hubo diferencias.');
    } catch (countError) {
      setError(countError.message);
    } finally {
      setSaving(false);
    }
  };

  if (screen === 'login') {
    return (
      <main className="login-screen">
        <button className="back-link" type="button" onClick={() => { setScreen('store'); setError(''); }}>← Volver a la tienda</button>
        <section className="login-layout">
          <div className="login-art" aria-label="Estudio de belleza">
            <span className="login-brand"><BrandLogo className="on-dark" /></span>
            <div className="login-art-copy"><span>BEAUTY · NAILS · CARE</span><h1>El cuidado<br />también se administra.</h1></div>
            <span className="login-art-caption">ESTUDIO DE BELLEZA · 01</span>
          </div>
          <form className="login-form" onSubmit={submitLogin}>
            <div className="login-heading"><span className="eyebrow">ÁREA PRIVADA</span><h2>Qué gusto verte.</h2><p>Inicia sesión para gestionar el salón.</p></div>
            <label className="field"><span>Usuario</span><input autoComplete="username" value={login.username} onChange={(event) => setLogin({ ...login, username: event.target.value })} required /></label>
            <label className="field"><span>Contraseña</span><input type="password" autoComplete="current-password" value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} required /></label>
            {error && <p className="inline-message error-message">{error}</p>}
            <button className="button button-dark button-wide" type="submit">Entrar al panel <span>↗</span></button>
            <p className="login-footnote">Acceso reservado al equipo de LoMio Studio.</p>
          </form>
        </section>
      </main>
    );
  }

  if (screen === 'invoice' && lastOrder) {
    return (
      <main className="receipt-screen">
        <header className="receipt-toolbar"><button type="button" className="back-link" onClick={() => setScreen('store')}>← Volver a la tienda</button><button type="button" className="button button-dark" onClick={() => window.print()}>Imprimir comprobante <span>↓</span></button></header>
        <article className="receipt-paper">
          <header className="receipt-heading"><span className="receipt-brand">LoMio <i>Studio</i></span><span className="eyebrow">BEAUTY · NAILS · CARE</span><h1>Comprobante de pedido</h1><p>Pedido {lastOrder.orderNumber}</p></header>
          <section className="receipt-customer"><div><span>CLIENTE</span><strong>{lastOrder.name}</strong><small>{lastOrder.email}</small><small>Teléfono: {lastOrder.phone}</small>{lastOrder.taxId && <small>Identificación: {lastOrder.taxId}</small>}</div><div><span>PEDIDO</span><strong>{lastOrder.date}</strong><small>Pago: {paymentMethodLabels[lastOrder.paymentMethod] || 'Por confirmar'}</small>{lastOrder.deliveryRoute && <small>Ruta de envío: {lastOrder.deliveryRoute}</small>}{lastOrder.address && <small>Dirección: {lastOrder.address}</small>}</div></section>
          <div className="receipt-lines"><div className="receipt-line receipt-line-head"><span>PRODUCTO</span><span>CANT.</span><span>PRECIO</span><span>IMPORTE</span></div>{lastOrder.items.map((item) => <div className="receipt-line" key={`${lastOrder.id}-${item.productId}`}><span>{item.productName}</span><span>{item.quantity}</span><span>{currency(item.unitPrice)}</span><strong>{currency(item.lineTotal)}</strong></div>)}</div>
          <div className="receipt-total"><span>Total</span><strong>{currency(lastOrder.subtotal)}</strong></div>
          <p className="receipt-disclaimer">Este documento es un comprobante de pedido y no sustituye una factura fiscal autorizada.</p>
          <footer className="receipt-footer">Gracias por elegir LoMio Studio.</footer>
        </article>
      </main>
    );
  }

  if (screen === 'cart') {
    return (
      <div className="storefront cart-screen">
        <header className="store-header"><button className="store-brand" type="button" aria-label="Volver a la tienda" onClick={() => setScreen('store')}><BrandLogo /></button><span className="checkout-step">TU COMPRA / DATOS DEL CLIENTE</span><button className="back-link" type="button" onClick={() => setScreen('store')}>Seguir viendo productos</button></header>
        <main className="checkout-content">
          <div className="checkout-heading"><span className="eyebrow">LOMIO, PARA TI</span><h1>Tu carrito</h1><p>Revisa tu selección y déjanos tus datos para preparar el pedido.</p></div>
          {error && <div className="toast-message error-toast checkout-error" role="alert">{error}<button type="button" aria-label="Cerrar mensaje" onClick={() => setError('')}>×</button></div>}
          {cartDetails.length === 0 ? <section className="empty-cart"><span>♡</span><h2>Tu carrito está esperando.</h2><p>Explora la colección y agrega tus favoritos.</p><button className="button button-dark" type="button" onClick={() => setScreen('store')}>Ver colección <span>↗</span></button></section> : <div className="checkout-layout">
            <section className="cart-items-panel"><div className="cart-panel-heading"><h2>Productos seleccionados</h2><span>{cartCount} unidades</span></div>{cartDetails.map((item) => <article className="checkout-item" key={item.id}><ProductImage src={item.image} alt={item.name} /><div className="checkout-item-info"><strong>{item.name}</strong><small>{item.category || 'LoMio Studio'}</small><b>{currency(item.price)}</b></div><div className="checkout-quantity"><button type="button" aria-label={`Quitar una unidad de ${item.name}`} onClick={() => changeCartQuantity(item.id, -1)}>−</button><span>{item.quantity}</span><button type="button" aria-label={`Agregar una unidad de ${item.name}`} onClick={() => changeCartQuantity(item.id, 1)} disabled={item.quantity >= item.stock}>＋</button></div><strong className="checkout-line-total">{currency(item.lineTotal)}</strong><button type="button" className="remove-item" aria-label={`Quitar ${item.name}`} onClick={() => setCart((current) => current.filter((entry) => Number(entry.productId) !== Number(item.id)))}>×</button></article>)}<div className="checkout-subtotal"><span>Subtotal</span><strong>{currency(cartTotal)}</strong></div><p className="checkout-pickup-note">{paymentMethod === 'cash_pickup' ? 'Pagarás en efectivo al retirar el pedido.' : paymentMethod === 'card_at_salon' ? 'Pagarás con tarjeta en el estudio al retirar el pedido.' : 'Al confirmar, el estudio te compartirá los datos para completar la transferencia.'} No ingreses datos de tarjeta en esta página.</p></section>
            <form className="customer-panel" onSubmit={placeOrder}>
              <span className="eyebrow">DATOS PARA TU COMPROBANTE</span>
              <h2>¿A quién preparamos el pedido?</h2>
              <label className="field"><span>Nombre completo</span><input autoComplete="name" value={checkoutForm.name} onChange={(event) => setCheckoutForm({ ...checkoutForm, name: event.target.value })} required /></label>
              <label className="field"><span>Correo electrónico</span><input type="email" autoComplete="email" value={checkoutForm.email} onChange={(event) => setCheckoutForm({ ...checkoutForm, email: event.target.value })} required /></label>
              <label className="field"><span>Teléfono</span><input type="tel" autoComplete="tel" value={checkoutForm.phone} onChange={(event) => setCheckoutForm({ ...checkoutForm, phone: event.target.value })} required /></label>
              <label className="field"><span>Cédula / RUC <small>OPCIONAL</small></span><input value={checkoutForm.taxId} onChange={(event) => setCheckoutForm({ ...checkoutForm, taxId: event.target.value })} /></label>
              <label className="field"><span>Dirección <small>OPCIONAL</small></span><input autoComplete="street-address" value={checkoutForm.address} onChange={(event) => setCheckoutForm({ ...checkoutForm, address: event.target.value })} /></label>
              <label className="field"><span>Ruta o referencia de envío <small>OPCIONAL</small></span><textarea rows="2" value={checkoutForm.deliveryRoute} onChange={(event) => setCheckoutForm({ ...checkoutForm, deliveryRoute: event.target.value })} placeholder="Barrio, zona, referencias para llegar…" /></label>
              <label className="field"><span>Forma de pago</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} required><option value="cash_pickup">Efectivo al retirar</option><option value="transfer_bac">Transferencia BAC Nicaragua</option><option value="transfer_lafise">Transferencia LAFISE</option><option value="card_at_salon">Tarjeta al pagar en el estudio</option></select></label>
              <p className="payment-hint">No ingreses datos de tarjeta aquí. Para BAC o LAFISE, se te indicarán los datos de transferencia al confirmar; el pago con tarjeta online requiere activar la pasarela del banco.</p>
              {error && <p className="inline-message error-message">{error}</p>}
              <div className="customer-total"><span>Total del pedido</span><strong>{currency(cartTotal)}</strong></div>
              <button className="button button-dark button-wide" type="submit" disabled={saving}>{saving ? 'Preparando pedido…' : 'Confirmar pedido'} <span>↗</span></button>
              <small className="privacy-note">Tus datos se usan solo para gestionar este pedido.</small>
            </form>
          </div>}
        </main>
      </div>
    );
  }

  if (screen === 'admin' && token) {
    const navItems = [
      { id: 'inventory', label: 'Inventario', symbol: '▦' },
      { id: 'orders', label: 'Pedidos', symbol: '▣' },
      { id: 'sales', label: 'Ventas', symbol: '↗' },
      { id: 'reports', label: 'Reportes', symbol: '▤' },
    ];
    return (
      <div className="admin-shell">
        <aside className="admin-sidebar">
          <button className="brand-lockup" type="button" onClick={() => setScreen('store')}><span className="brand-logo-wrap"><BrandLogo /><small>CONTROL DEL SALÓN</small></span></button>
          <span className="side-label">GESTIÓN</span>
          <nav className="side-nav" aria-label="Secciones administrativas">
            {navItems.map((item) => <button key={item.id} type="button" className={section === item.id ? 'selected' : ''} onClick={() => { setSection(item.id); setError(''); setNotice(''); }}><span>{item.symbol}</span>{item.label}{item.id === 'inventory' && <small>{products.length}</small>}</button>)}
          </nav>
          <div className="sidebar-bottom"><div className="user-chip"><span className="user-avatar">L</span><span><strong>Administración</strong><small>LoMio Studio</small></span></div><button className="sidebar-action" type="button" onClick={logout}>Cerrar sesión <span>↗</span></button></div>
        </aside>

        <main className="admin-main">
          <header className="admin-topbar"><button className="mobile-brand" type="button" aria-label="Ir a la tienda" onClick={() => setScreen('store')}><BrandLogo /></button><span>ADMINISTRACIÓN <b>/</b> {navItems.find((item) => item.id === section)?.label.toUpperCase()}</span><button className="store-link" type="button" onClick={() => setScreen('store')}>Ver tienda <span>↗</span></button></header>
          <div className="admin-content">
            {notice && <div className="toast-message" role="status">{notice}<button type="button" aria-label="Cerrar mensaje" onClick={() => setNotice('')}>×</button></div>}
            {error && <div className="toast-message error-toast" role="alert">{error}<button type="button" aria-label="Cerrar mensaje" onClick={() => setError('')}>×</button></div>}

            {section === 'inventory' && <>
              <div className="section-heading"><div><span className="eyebrow">TU SALÓN, EN ORDEN</span><h1>Inventario</h1><p>Productos, existencias y referencias en un solo lugar.</p></div><div className="heading-actions"><button className="button button-outline" type="button" onClick={openStockCount}>Conteo de stock <span>↻</span></button><button className="button button-dark" type="button" onClick={openCreateForm}><span>＋</span> Agregar producto</button></div></div>
              <div className="metric-row"><article className="metric"><span>Productos registrados</span><strong>{products.length}</strong><small>En todo el catálogo</small></article><article className="metric"><span>Valor en existencias</span><strong>{currency(inventoryValue)}</strong><small>Al precio de venta actual</small></article><article className="metric metric-alert"><span>Stock por reponer</span><strong>{lowStockCount}</strong><small>5 unidades o menos</small></article></div>
              <section className="inventory-section"><div className="inventory-toolbar"><div><h2>Productos</h2><span>{filteredProducts.length} referencias</span></div><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nombre o código" aria-label="Buscar en inventario" /></label></div>
                {productsLoading ? <div className="empty-panel">Cargando inventario…</div> : filteredProducts.length === 0 ? <div className="empty-panel">{products.length ? 'No hay productos que coincidan con la búsqueda.' : 'Aún no hay productos. Agrega el primero al inventario.'}</div> : <div className="inventory-list"><div className="inventory-table-head"><span>PRODUCTO</span><span>PRECIO</span><span>EXISTENCIAS</span><span>REFERENCIA</span><span>ACCIONES</span></div>
                  {filteredProducts.map((product) => <article className="inventory-row" key={product.id}><div className="inventory-product"><ProductImage src={product.image} alt={product.name} /><span><strong>{product.name}</strong><small>{product.category || 'Sin categoría'}</small></span></div><strong className="inventory-price">{currency(product.price)}</strong><span className={`stock-count ${product.stock <= 5 ? 'stock-low' : ''}`}><b>{product.stock}</b><small>{product.stock <= 5 ? 'Reponer' : 'En stock'}</small></span><div className="reference-code"><Barcode value={product.barcode || `LM-${product.id}`} /><small>{product.barcode || 'Sin código'}</small></div><div className="row-actions"><button type="button" title="Editar producto" aria-label={`Editar ${product.name}`} onClick={() => openEditForm(product)}>Editar</button><button type="button" title="Eliminar producto" aria-label={`Eliminar ${product.name}`} onClick={() => deleteProduct(product)}>Eliminar</button></div></article>)}
                </div>}
              </section>
            </>}

            {section === 'orders' && <>
              <div className="section-heading"><div><span className="eyebrow">VENTA EN LÍNEA</span><h1>Pedidos</h1><p>Consulta los datos del cliente y el estado de cada pedido.</p></div><div className="sales-total"><span>PENDIENTES DE PAGO</span><strong>{orders.filter((order) => order.status === 'pending').length}</strong></div></div>{orders.length > 0 && <div className="sales-cleaner orders-cleaner"><label className="field"><span>Desde</span><input type="date" value={ordersRange.from} max={ordersRange.to || undefined} onChange={(event) => setOrdersRange({ ...ordersRange, from: event.target.value })} /></label><label className="field"><span>Hasta</span><input type="date" value={ordersRange.to} min={ordersRange.from || undefined} onChange={(event) => setOrdersRange({ ...ordersRange, to: event.target.value })} /></label><button className="button button-outline" type="button" onClick={() => clearOrders(false)}>Eliminar rango</button><button className="button button-outline orders-clear" type="button" onClick={() => clearOrders(true)}>Vaciar pedidos</button></div>}
              {orders.length ? <div className="order-list">{orders.map((order) => <article className="admin-order" key={order.id}><header className="admin-order-heading"><div><span className="eyebrow">{order.orderNumber}</span><h2>{order.name}</h2><small>{order.date} · {order.email} · {order.phone}</small><small>Pago: {paymentMethodLabels[order.paymentMethod] || order.paymentMethod}</small>{order.deliveryRoute && <small>Ruta de envío: {order.deliveryRoute}</small>}</div><span className={`order-status status-${order.status}`}>{order.status === 'pending' ? 'Pendiente de pago' : order.status === 'paid' ? 'Pagado' : 'Cancelado'}</span></header><div className="admin-order-items">{order.items.length ? order.items.map((item) => <div className="admin-order-line" key={`${order.id}-${item.productId}`}><span>{item.productName} <small>× {item.quantity}</small></span><strong>{currency(item.lineTotal)}</strong></div>) : <p className="order-items-missing">No se recibieron los productos de este pedido. Actualiza el backend y vuelve a cargar.</p>}</div><footer className="admin-order-footer"><span>Total del pedido <strong>{currency(order.subtotal)}</strong>{order.taxId && <small>Identificación fiscal: {order.taxId}</small>}</span>{order.status === 'pending' && <div><button className="button button-outline" type="button" onClick={() => updateOrder(order, 'cancelled')}>Cancelar pedido</button><button className="button button-dark" type="button" onClick={() => updateOrder(order, 'paid')}>Confirmar pago al retirar</button></div>}<button className="order-delete" type="button" onClick={() => deleteOrder(order)}>Eliminar</button></footer></article>)}</div> : <div className="empty-panel order-empty">Aún no hay pedidos realizados desde la tienda.</div>}
            </>}

            {section === 'sales' && <>
              <div className="section-heading"><div><span className="eyebrow">PUNTO DE VENTA</span><h1>Ventas</h1><p>Registra cada movimiento y mantén las existencias al día.</p></div><div className="sales-total"><span>INGRESOS REGISTRADOS</span><strong>{currency(revenue)}</strong></div></div>
              <div className="sales-layout"><section className="work-panel sale-entry"><div className="panel-title"><div><span className="eyebrow">NUEVA OPERACIÓN</span><h2>Registrar venta</h2></div><span className="panel-icon">＋</span></div><form className="product-form" onSubmit={registerSale}><label className="field"><span>Producto</span><select value={saleForm.productId} onChange={(event) => setSaleForm({ ...saleForm, productId: event.target.value })} required><option value="">Selecciona un producto</option>{products.filter((product) => product.stock > 0).map((product) => <option key={product.id} value={product.id}>{product.name} · {product.stock} disponibles</option>)}</select></label><div className="form-columns"><label className="field"><span>Cantidad</span><input type="number" min="1" max={products.find((product) => String(product.id) === saleForm.productId)?.stock || undefined} value={saleForm.quantity} onChange={(event) => setSaleForm({ ...saleForm, quantity: event.target.value })} required /></label><label className="field"><span>Método de pago</span><select value={saleForm.method} onChange={(event) => setSaleForm({ ...saleForm, method: event.target.value })}><option>Efectivo</option><option>Tarjeta</option><option>Transferencia</option></select></label></div><label className="field"><span>Cliente <small>OPCIONAL</small></span><input value={saleForm.customer} onChange={(event) => setSaleForm({ ...saleForm, customer: event.target.value })} placeholder="Nombre del cliente" /></label><div className="sale-estimate"><span>Total de la venta</span><strong>{currency((products.find((product) => String(product.id) === saleForm.productId)?.price || 0) * Number(saleForm.quantity || 0))}</strong></div><button className="button button-dark button-wide" type="submit">Confirmar venta <span>↗</span></button></form></section>
                <section className="work-panel sales-history"><div className="panel-title"><div><span className="eyebrow">MOVIMIENTOS</span><h2>Historial de ventas</h2></div><span className="history-count">{sales.length}</span></div><div className="sales-cleaner"><label className="field"><span>Desde</span><input type="date" value={salesRange.from} max={salesRange.to || undefined} onChange={(event) => setSalesRange({ ...salesRange, from: event.target.value })} /></label><label className="field"><span>Hasta</span><input type="date" value={salesRange.to} min={salesRange.from || undefined} onChange={(event) => setSalesRange({ ...salesRange, to: event.target.value })} /></label><button className="button button-outline" type="button" onClick={() => deleteSales(false)}>Eliminar rango</button><button className="button button-outline orders-clear" type="button" onClick={() => deleteSales(true)} disabled={!sales.length}>Vaciar historial</button></div>{sales.length ? <div className="sales-list">{sales.map((sale) => <article className="sale-row" key={sale.id}><span className="sale-mark">↗</span><span className="sale-details"><strong>{sale.product}</strong><small>{sale.customer || 'Venta en salón'} · {sale.method} · {sale.date}</small></span><span className="sale-quantity">× {sale.quantity}</span><strong className="sale-amount">{currency(sale.total)}</strong></article>)}</div> : <div className="empty-panel">Todavía no hay ventas registradas.</div>}</section></div>
            </>}

            {section === 'reports' && <>
              <div className="section-heading"><div><span className="eyebrow">RESUMEN DEL NEGOCIO</span><h1>Cierres y reportes</h1><p>Ventas por periodo, cierres de caja y cambios de inventario.</p></div><button className="button button-outline" type="button" onClick={exportSales}>Descargar ventas <span>↓</span></button></div>
              <section className="period-toolbar"><div className="period-switch" role="group" aria-label="Periodo del reporte">{[['daily', 'Diario'], ['weekly', 'Semanal'], ['monthly', 'Mensual']].map(([value, label]) => <button key={value} type="button" className={reportPeriod === value ? 'active' : ''} onClick={() => setReportPeriod(value)}>{label}</button>)}</div><label className="period-date"><span>Fecha de referencia</span><input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} /></label><span className="period-range">{activeRange.start === activeRange.end ? activeRange.start : `${activeRange.start} — ${activeRange.end}`}</span></section>
              <div className="report-metrics"><article className="report-highlight"><span>VENTAS DEL PERIODO</span><strong>{currency(periodSummary?.salesTotal || 0)}</strong><small>{periodSummary?.salesCount || 0} ventas registradas</small><i>↗</i></article><article className="metric"><span>Unidades vendidas</span><strong>{periodSummary?.unitsSold || 0}</strong><small>{reportPeriod === 'daily' ? 'En este día' : reportPeriod === 'weekly' ? 'En esta semana' : 'En este mes'}</small></article><article className="metric"><span>Periodo anterior</span><strong>{periodChange === null ? currency(previousPeriodTotal) : `${periodChange > 0 ? '+' : ''}${periodChange.toFixed(1)}%`}</strong><small>{currency(previousPeriodTotal)} en {previousRange.start} — {previousRange.end}</small></article><article className="metric"><span>Existencias actuales</span><strong>{currency(periodSummary?.inventoryValue ?? inventoryValue)}</strong><small>{products.length} productos · {lowStockCount} por reponer</small></article></div>
              <section className="work-panel cash-closeout"><div className="panel-title"><div><span className="eyebrow">CIERRE DE CAJA</span><h2>{reportPeriod === 'daily' ? 'Cierre diario' : reportPeriod === 'weekly' ? 'Cierre semanal' : 'Cierre mensual'}</h2></div><button className="button button-dark" type="button" onClick={saveCloseout} disabled={closeouts.some((closeout) => closeout.periodType === reportPeriod && closeout.periodStart === activeRange.start)}>Guardar cierre <span>✓</span></button></div><div className="closeout-summary"><span>Ventas <strong>{currency(periodSummary?.salesTotal || 0)}</strong></span><span>Operaciones <strong>{periodSummary?.salesCount || 0}</strong></span><span>Unidades <strong>{periodSummary?.unitsSold || 0}</strong></span>{Object.entries(periodSummary?.paymentTotals || {}).map(([method, total]) => <span key={method}>{method} <strong>{currency(total)}</strong></span>)}</div><p className="closeout-note">El cierre guarda una copia de las ventas y existencias de este periodo. Cada periodo solo puede cerrarse una vez.</p></section>
              <section className="work-panel report-history"><div className="panel-title"><div><span className="eyebrow">HISTORIAL INMUTABLE</span><h2>Cierres guardados</h2></div><span className="history-count">{closeouts.length}</span></div>{closeouts.length ? <div className="closeout-list">{closeouts.map((closeout) => <article className="closeout-row" key={closeout.id}><span className="closeout-type">{closeout.periodType === 'daily' ? 'Diario' : closeout.periodType === 'weekly' ? 'Semanal' : 'Mensual'}</span><span className="closeout-dates">{closeout.periodStart} — {closeout.periodEnd}</span><span>{closeout.salesCount} ventas · {closeout.unitsSold} unidades</span><strong>{currency(closeout.salesTotal)}</strong><small>Guardado {closeout.createdAt}</small></article>)}</div> : <div className="empty-panel">Todavía no hay cierres guardados.</div>}</section>
              <section className="work-panel report-history"><div className="panel-title"><div><span className="eyebrow">CONTEOS FÍSICOS</span><h2>Historial de ajustes de stock</h2></div><span className="history-count">{stockAdjustments.length}</span></div>{stockAdjustments.length ? <div className="closeout-list">{stockAdjustments.slice(0, 30).map((adjustment) => <article className="stock-audit-row" key={adjustment.id}><strong>{adjustment.productName}</strong><span>{adjustment.previousStock} → {adjustment.countedStock}</span><small>{adjustment.reason}</small><time>{adjustment.createdAt}</time></article>)}</div> : <div className="empty-panel">Los conteos y sus diferencias aparecerán aquí.</div>}</section>
              <section className="work-panel report-history"><div className="panel-title"><div><span className="eyebrow">DETALLE DEL PERIODO</span><h2>Ventas {reportPeriod === 'daily' ? 'diarias' : reportPeriod === 'weekly' ? 'semanales' : 'mensuales'}</h2></div><span className="history-count">{currentPeriodSales.length}</span></div>{currentPeriodSales.length ? <div className="sales-list">{currentPeriodSales.map((sale) => <article className="sale-row" key={sale.id}><span className="sale-mark">↗</span><span className="sale-details"><strong>{sale.product}</strong><small>{sale.customer || 'Venta en salón'} · {sale.method} · {sale.date}</small></span><span className="sale-quantity">× {sale.quantity}</span><strong className="sale-amount">{currency(sale.total)}</strong></article>)}</div> : <div className="empty-panel">No hay ventas en el periodo seleccionado.</div>}</section>
            </>}
          </div>
        </main>

        {stockCountOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setStockCountOpen(false); }}><section className="product-dialog stock-count-dialog" role="dialog" aria-modal="true" aria-labelledby="stock-count-title"><header className="dialog-heading"><div><span className="eyebrow">INVENTARIO AUDITABLE</span><h2 id="stock-count-title">Conteo físico de stock</h2><p>Indica cuántas unidades hay realmente. Se guardarán las diferencias; no se borran ventas.</p></div><button type="button" className="close-button" aria-label="Cerrar" onClick={() => setStockCountOpen(false)}>×</button></header><form className="product-form" onSubmit={saveStockCount}><label className="field"><span>Motivo del ajuste</span><input value={stockCountReason} onChange={(event) => setStockCountReason(event.target.value)} maxLength="255" required /></label><div className="stock-count-list">{products.map((product) => <label className="stock-count-input" key={product.id}><span><ProductImage src={product.image} alt="" /><strong>{product.name}</strong><small>Sistema: {product.stock}</small></span><input type="number" min="0" step="1" aria-label={`Conteo físico ${product.name}`} value={stockCountValues[product.id] ?? product.stock} onChange={(event) => setStockCountValues((current) => ({ ...current, [product.id]: event.target.value }))} required /></label>)}</div>{error && <p className="inline-message error-message">{error}</p>}<footer className="dialog-actions"><button className="button button-outline" type="button" onClick={() => setStockCountOpen(false)}>Cancelar</button><button className="button button-dark" type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar conteo e historial'}</button></footer></form></section></div>}
        {formOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}><section className="product-dialog" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title"><header className="dialog-heading"><div><span className="eyebrow">GESTIÓN DE PRODUCTOS</span><h2 id="product-dialog-title">{editingId ? 'Editar producto' : 'Nuevo producto'}</h2></div><button type="button" className="close-button" aria-label="Cerrar" onClick={() => setFormOpen(false)}>×</button></header><form className="product-form" onSubmit={saveProduct}><label className="field"><span>Nombre del producto</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ej. Esmalte gel efecto brillo" required /></label><div className="form-columns"><label className="field"><span>Precio de venta</span><input type="number" min="0" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="0.00" required /></label><label className="field"><span>Existencias</span><input type="number" min="0" step="1" value={form.stock} onChange={(event) => setForm({ ...form, stock: event.target.value })} required /></label></div><label className="field"><span>Categoría</span><input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="Uñas, cuidado facial…" /></label><label className="field"><span>Número de serie / código</span><div className="serial-field"><input value={form.barcode} onChange={(event) => setForm({ ...form, barcode: event.target.value })} required /><button type="button" onClick={() => setForm({ ...form, barcode: `LM-${Date.now().toString().slice(-8)}` })}>Generar nuevo</button></div></label><div className="field"><span>Fotografía del producto</span><div className="photo-upload"><ProductImage src={imagePreview || form.imageUrl} alt="Vista previa del producto" /><div className="photo-upload-content"><strong>{imagePreview ? 'Fotografía lista' : 'Añade una fotografía'}</strong><small>Cámara o fototeca · JPG, PNG, HEIC o WEBP · Máximo 15 MB</small><div className="photo-upload-actions">
        <button className="photo-action" type="button" onClick={() => cameraInputRef.current?.click()}>Tomar foto <span>◉</span></button>
        <button className="photo-action" type="button" onClick={() => libraryInputRef.current?.click()}>Elegir de fototeca <span>▧</span></button>
      </div></div><input ref={cameraInputRef} className="visually-hidden-input" type="file" accept="image/*" capture="environment" onChange={handleImageChange} /><input ref={libraryInputRef} className="visually-hidden-input" type="file" accept="image/*" onChange={handleImageChange} /></div></div>{error && <p className="inline-message error-message">{error}</p>}<footer className="dialog-actions"><button className="button button-outline" type="button" onClick={() => setFormOpen(false)}>Cancelar</button><button className="button button-dark" type="submit" disabled={saving}>{saving ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Agregar al inventario'}</button></footer></form></section></div>}
      </div>
    );
  }

  return (
    <div className="storefront">
      {notice && <div className="store-notice" role="status"><span className="notice-icon" aria-hidden="true">✓</span><span className="notice-text">{notice}</span><button type="button" aria-label="Cerrar mensaje" onClick={() => setNotice('')}>×</button></div>}
      {error && <div className="store-notice error-toast" role="alert">{error}<button type="button" aria-label="Cerrar mensaje" onClick={() => setError('')}>×</button></div>}
      <header className="store-header"><a className="store-brand" href="#inicio" aria-label="Lo Mío Store Online, ir al inicio" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><BrandLogo /></a><nav className="store-nav"><a href="#coleccion">Colección</a><a href="#nosotros">El estudio</a></nav><div className="store-header-actions"><button className="cart-entry" type="button" aria-label={`Carrito, ${cartCount} ${cartCount === 1 ? 'producto' : 'productos'}`} onClick={() => { setScreen('cart'); setError(''); setNotice(''); }}><svg className="cart-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 8.5h11l1 11.5h-13z" /><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" /></svg><strong className="cart-label">Carrito</strong><span key={cartCount} className={`cart-badge${cartCount ? ' ' : ' is-empty'}`}>{cartCount}</span></button><button className="admin-entry" type="button" onClick={() => { setScreen(token ? 'admin' : 'login'); setError(''); }}>Área privada <span>↗</span></button></div></header>
      <main>
        <section className="store-hero" id="inicio"><div className="hero-visual"><ProductImage src={HERO_IMAGE} alt="Productos seleccionados para el cuidado de manos y piel" className="hero-photo" /><span className="hero-photo-tag">RITUALES PARA TI</span><span className="hero-index">LOMIO STUDIO <b>·</b> 2026</span></div><div className="hero-message"><span className="eyebrow">TU MOMENTO, TU ESTILO</span><h1>Belleza que<br /><i>se siente tuya.</i></h1><p>Pequeños rituales, tonos que hablan por ti y productos elegidos con cariño en nuestro estudio.</p><a className="button button-dark" href="#coleccion">Descubrir productos <span>↓</span></a><span className="hero-note">SELECCIÓN DEL ESTUDIO <b>01 — 04</b></span></div></section>
        <section className="collection-section" id="coleccion"><div className="collection-heading"><div><span className="eyebrow">LOMIO, PARA LLEVAR</span><h2>Elige tu próximo <i>favorito.</i></h2></div><span className="collection-count">{visibleProducts.length.toString().padStart(2, '0')} PRODUCTOS</span></div>{productsLoading ? <div className="store-empty" aria-live="polite">Preparando la colección…</div> : visibleProducts.length ? <div className="store-product-grid">{visibleProducts.map((product, index) => <article className="store-product" key={product.id}><div className="store-product-image"><button className="image-zoom" type="button" aria-label={`Ver foto ampliada de ${product.name}`} onClick={() => setPreviewProduct(product)}><ProductImage src={product.image} alt={product.name} /></button><span>{String(index + 1).padStart(2, '0')}</span><small>{product.category || 'LOMIO STUDIO'}</small></div><div className="store-product-details"><h3>{product.name}</h3><span className="store-stock">{product.stock} disponibles</span><strong>{currency(product.price)}</strong><button className="add-cart-button" type="button" onClick={() => addToCart(product)}>Agregar al carrito <span>＋</span></button></div></article>)}</div> : <div className="store-empty">{error ? 'No pudimos cargar la colección. Revisa tu conexión e inténtalo de nuevo.' : 'La colección se está preparando. Vuelve pronto.'}</div>}</section>
        <section className="studio-note" id="nosotros"><span className="eyebrow">UN ESPACIO PARA SENTIRTE BIEN</span><p>En LoMio Studio, cada detalle empieza con <i>cuidarte.</i></p><span>BEAUTY · NAILS · CARE</span></section>
      </main>
      {previewProduct && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Foto de ${previewProduct.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewProduct(null); }}>
          <figure className="lightbox-card">
            <button className="lightbox-close" type="button" aria-label="Cerrar" autoFocus onClick={() => setPreviewProduct(null)}>×</button>
            <div className="lightbox-image"><ProductImage src={previewProduct.image} alt={previewProduct.name} /></div>
            <figcaption>
              <div><small>{previewProduct.category || 'LOMIO STUDIO'}</small><h3>{previewProduct.name}</h3><strong>{currency(previewProduct.price)}</strong></div>
              <button className="button button-dark" type="button" onClick={() => { addToCart(previewProduct); setPreviewProduct(null); }}>Agregar al carrito</button>
            </figcaption>
          </figure>
        </div>
      )}      <footer className="store-footer"><a className="store-brand" href="#inicio" aria-label="Lo Mío Store Online, ir al inicio"><BrandLogo /></a><span>Hecho para tu momento.</span><button type="button" onClick={() => { setScreen(token ? 'admin' : 'login'); setError(''); }}>Acceso administrativo ↗</button></footer>
    </div>
  );
}

export default App;