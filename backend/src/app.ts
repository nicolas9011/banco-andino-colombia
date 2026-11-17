import crypto from 'node:crypto';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config';
import { pool } from './db';
import { AppError, mapPgError } from './errors';
import { accountsRouter } from './routes/accounts';
import { auditRouter, catalogRouter, rolesRouter, statsRouter, usersRouter } from './routes/admin';
import { atmRouter } from './routes/atm';
import { authRouter } from './routes/auth';
import { brebeRouter } from './routes/brebe';
import { customersRouter } from './routes/customers';
import { meRouter } from './routes/me';
import { transactionsRouter } from './routes/transactions';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Detras de un proxy inverso hay que declarar cuantos saltos son de confianza; si no, req.ip (auditoria y limitador)
  // seria la IP del proxy y todos los clientes compartirian el mismo cupo. Por defecto: sin proxy.
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.use(cors({ origin: true, credentials: false, maxAge: 600 }));
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const t0 = Date.now();
    res.on('finish', () => {
      if (config.NODE_ENV !== 'test') {
        console.log(JSON.stringify({ nivel: 'info', req: req.id, m: req.method, ruta: req.path, s: res.statusCode, ms: Date.now() - t0 }));
      }
    });
    next();
  });
  app.use(express.json({ limit: '50kb' }));

  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 100_000 : 300, standardHeaders: true, legacyHeaders: false }),
  );

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ estado: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/users', usersRouter);
  app.use('/api', rolesRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/stats', statsRouter);
  app.use('/api/me', meRouter);
  app.use('/api/brebe', brebeRouter);
  app.use('/api/atm', atmRouter);

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'RUTA_NO_ENCONTRADA', 'Recurso no encontrado.')));

  // Manejo central: el usuario recibe un mensaje claro; el detalle tecnico va solo a los logs.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: AppError | null = err instanceof AppError ? err : mapPgError(err);
    if (!e) {
      const t = (err as { type?: string; status?: number }) ?? {};
      if (t.type === 'entity.parse.failed') e = new AppError(400, 'JSON_INVALIDO', 'El cuerpo de la solicitud no es JSON valido.');
      else if (t.type === 'entity.too.large') e = new AppError(413, 'CUERPO_GRANDE', 'La solicitud es demasiado grande.');
      // Otros errores del parser de cuerpos (codificacion o charset no soportados): son del cliente, no un 500.
      else if (typeof t.status === 'number' && t.status >= 400 && t.status < 500) e = new AppError(t.status, 'SOLICITUD_INVALIDA', 'La solicitud no se pudo procesar.');
    }
    if (!e) {
      console.error(JSON.stringify({
        nivel: 'error', req: req.id, ruta: req.path,
        err: err instanceof Error ? { nombre: err.name, mensaje: err.message, pila: err.stack } : String(err),
        pg: (err as { code?: string })?.code,
      }));
      e = new AppError(500, 'ERROR_INTERNO', 'Ocurrio un error inesperado. Intenta de nuevo.');
    } else if (e.status >= 500) {
      console.error(JSON.stringify({ nivel: 'error', req: req.id, ruta: req.path, codigo: e.code, original: String((err as Error)?.message) }));
    }
    res.status(e.status).json({ error: { code: e.code, message: e.message }, requestId: req.id });
  });

  return app;
}
