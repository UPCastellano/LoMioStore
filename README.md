# LoMioStore

Tienda en línea de productos de belleza con panel de administración, inventario, pedidos y ventas.

## Tecnologías

- **Frontend:** React + Vite (`frontend/`)
- **Backend:** Node.js + Express (`Backend/`)
- **Base de datos:** PostgreSQL (Clever Cloud)
- **Imágenes de productos:** Google Drive (opcional; sin configurar se guardan en `Backend/uploads/`)

## Requisitos

- Node.js 18 o superior
- Una base de datos PostgreSQL

## Instalación

```bash
cd Backend
npm install
cp .env.example .env

cd ../frontend
npm install
cp .env.example .env
```

Completa los valores de cada `.env`. Esos archivos nunca se suben al repositorio.

### Variables del backend (`Backend/.env`)

| Variable | Descripción |
|---|---|
| `PORT`, `BACKEND_URL` | Puerto y URL pública del backend |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Credenciales del panel de administración |
| `POSTGRESQL_ADDON_*` | Datos de conexión a PostgreSQL |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID` | Subida de imágenes a Google Drive |

### Variables del frontend (`frontend/.env`)

| Variable | Descripción |
|---|---|
| `VITE_API_URL` | URL del backend |
| `VITE_CURRENCY` | Moneda (por ejemplo `NIO`) |

## Ejecución

```bash
# Backend (http://localhost:5000)
cd Backend
npm run dev

# Frontend
cd frontend
npm run dev
```

## Pruebas

```bash
cd Backend
npm test
```

## Más información

- [Pagos y facturación](./PAGOS_Y_FACTURACION.md)
- [Política de privacidad](./PRIVACY.md)
