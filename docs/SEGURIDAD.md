# Seguridad

## Autenticación y sesiones
- Contraseñas con bcrypt; PIN de ATM aparte y bloqueo de tarjeta tras intentos fallidos.
- JWT HS256 con `jti` registrado en `seguridad.sesion`: el logout y la desactivación de un usuario revocan la sesión de inmediato. Tokens web y ATM separados.
- Rate limiting en `/auth/login` y `/atm/login`; mensajes genéricos (no revelan si el usuario o la tarjeta existe).

## Autorización
- RBAC: 4 roles, 24 permisos, matriz editable solo por ADMIN. Cada ruta declara su permiso; además se valida propiedad del recurso (IDOR): un CLIENTE solo consulta sus cuentas y operaciones.
- El último administrador activo no puede desactivarse ni perder el rol (advisory lock evita la carrera).

## Datos
- Consultas parametrizadas siempre; los filtros se construyen con listas blancas.
- `lab_api` no es superusuario ni dueño de tablas; REVOKE a PUBLIC y GRANT mínimos por esquema.
- Hashes de contraseña y PIN se omiten en la bitácora. Las vistas no exponen `clave_idempotencia` ni el actor interno.
- Números de tarjeta: HMAC con `CARD_PEPPER` para búsqueda, solo se muestran enmascarados.

## Errores
`mapPgError` traduce códigos SQLSTATE a mensajes seguros; solo se muestra el texto cuando lo escribió una función PL/pgSQL propia (marcador `PL/pgSQL`, independiente del idioma del servidor). Cualquier otro error se enmascara y se registra con `requestId`.

## Transporte y cabeceras
helmet, CORS limitado a `FRONTEND_ORIGIN`, límite de tamaño del cuerpo JSON. Para producción falta TLS (terminación en proxy) — **no verificado en este laboratorio**.

## Secretos
`.env` fuera del repositorio; `.env.example` sin valores reales.

## Lo que NO se afirma
Sin pruebas de penetración externas, sin análisis de dependencias continuo y sin TLS probado. Las revisiones ECC son una ayuda, no una certificación.
