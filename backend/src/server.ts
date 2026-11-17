import { createApp } from './app';
import { config } from './config';
import { pool } from './db';

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`Banco Andino API en http://localhost:${config.PORT}/api (${config.NODE_ENV})`);
});

// Un fallo no previsto se registra y el proceso termina de forma ordenada (el supervisor lo reinicia);
// nunca debe quedar vivo en un estado desconocido ni morir sin dejar rastro.
for (const evento of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(evento, (err) => {
    console.error(JSON.stringify({ nivel: 'fatal', evento, err: err instanceof Error ? { mensaje: err.message, pila: err.stack } : String(err) }));
    apagar(1);
  });
}

function apagar(codigo = 0) {
  const limite = setTimeout(() => process.exit(codigo || 1), 5_000); // si el cierre ordenado se cuelga, se fuerza
  limite.unref();
  server.close(() => pool.end().finally(() => process.exit(codigo)));
}
process.on('SIGINT', () => apagar());
process.on('SIGTERM', () => apagar());
