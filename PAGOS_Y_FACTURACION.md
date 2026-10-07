# Pagos y facturacion de LoMio Studio

## Estado actual

- La tienda acepta pedidos con productos y cantidades; el servidor calcula el total con sus propios precios y reserva existencias.
- El pedido queda pendiente de pago. El comercio puede confirmarlo al cobrar en el estudio o cancelarlo y liberar el stock.
- El comprobante del pedido se puede imprimir o guardar como PDF desde el navegador.
- El checkout pide nombre, correo, telefono y, de forma opcional, cedula/RUC y direccion. El panel administrativo es el unico que puede consultar pedidos.
- No se capturan ni almacenan numeros de tarjeta, CVV, PIN ni claves bancarias.
- El comprobante actual no es una factura fiscal autorizada y no se ha conectado una pasarela. No se debe anunciar el pago con tarjeta como disponible hasta completar los pasos siguientes.

## Para habilitar BAC, LAFISE u otro adquirente

1. Abrir con BAC Nicaragua y/o LAFISE una cuenta de comercio y solicitar el producto de adquirencia para ventas por internet. Confirmar por escrito que esta disponible para la razon social y actividad del negocio.
2. Solicitar documentacion tecnica vigente, ambiente de pruebas, credenciales de prueba, lista de tarjetas/marcas admitidas, monedas y paises, comisiones, plazos de liquidacion, contracargos, reembolsos y soporte.
3. Confirmar el tipo de integracion: checkout alojado por el proveedor o campos/tokenizacion certificados; autenticacion 3-D Secure; URLs de retorno; notificaciones firmadas (webhooks); proceso de conciliacion.
4. Probar en sandbox aprobaciones, rechazos, cancelaciones, reintentos, pagos duplicados, notificaciones repetidas, reembolsos y diferencias de moneda. La confirmacion final del pago debe venir del servidor/proveedor, nunca de una pantalla de retorno del navegador.
5. Configurar dominio publico con HTTPS, URLs de retorno y webhook en produccion. Guardar secretos solo en variables del backend/servicio de despliegue; no usar `VITE_*` para secretos. No activar la pasarela hasta que el proveedor habilite el comercio en produccion.
6. Verificar con el adquirente si se pueden aceptar tarjetas nacionales e internacionales y las marcas concretas. "Cualquier tarjeta" no se puede prometer: depende de las marcas, el pais emisor, el emisor y las reglas antifraude.

La aplicacion queda preparada para que el servidor cree una sesion de pago y cambie el pedido a pagado al verificar un webhook firmado. El adaptador concreto debe implementarse con el manual y credenciales que entregue el banco; cada proveedor tiene contratos distintos y no es seguro adivinar endpoints.

## Factura fiscal y datos del cliente

El comprobante imprimible actual es una confirmacion de pedido, no un documento tributario. Antes de emitir facturas oficiales, consultar con un contador y la DGI los requisitos vigentes para el negocio, numeracion, impuestos, identificacion del comprador y emision electronica; luego integrar el sistema o proveedor autorizado que corresponda.

Publicar aviso de privacidad, finalidad y periodo de retencion; limitar el acceso a datos personales; usar HTTPS; definir como atender rectificacion/eliminacion y solicitudes fiscales. No guardar datos de tarjeta: deben permanecer en la pasarela certificada.

## Configuracion local

1. Copiar `Backend/.env.example` a `Backend/.env` y definir credenciales administrativas propias y los datos reales de PostgreSQL.
2. Copiar `frontend/.env.example` a `frontend/.env`; `VITE_CURRENCY=NIO` establece cordobas y `VITE_API_URL` apunta al backend. Revisar los precios actuales para confirmar que tambien estan expresados en cordobas.
3. Reiniciar backend y frontend despues de cambiar variables de entorno.

No subir ninguno de los archivos `.env` con credenciales a Git ni compartir contrasenas, llaves privadas o claves de webhook.
