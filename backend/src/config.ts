import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// .env vive en la raiz del proyecto (compartido con los scripts Python). Nunca se versiona.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  LAB_DB_HOST: z.string().default('localhost'),
  LAB_DB_PORT: z.coerce.number().int().positive().default(5432),
  LAB_DB_NAME: z.string().default('lab_banco'),
  LAB_API_PASSWORD: z.string().min(8, 'LAB_API_PASSWORD es obligatorio'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  CARD_PEPPER: z.string().min(16, 'CARD_PEPPER debe tener al menos 16 caracteres'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(12),
  SESSION_MINUTES: z.coerce.number().int().positive().default(30),
  ATM_SESSION_MINUTES: z.coerce.number().int().positive().default(3),
  LOGIN_MAX_FAILS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_RATE_MAX: z.coerce.number().int().positive().default(20),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const faltan = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Configuracion invalida (revisa .env): ${faltan}`);
}

export const config = parsed.data;
