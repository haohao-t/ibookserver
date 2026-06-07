import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isCloud = !!process.env.DATABASE_URL;

const pool = new Pool(
  isCloud
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 60000,
        max: 10,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'ibook_db',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'asasd',
        ssl: false,
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 30000,
        max: 10,
        allowExitOnIdle: false,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      }
);

pool.on('error', (err: any) => {
  if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return;
  console.error('Ошибка пула:', err.message);
});

pool.query('SELECT 1 + 1 AS result', (err, res) => {
  if (err) {
    console.error('\nОШИБКА ПОДКЛЮЧЕНИЯ К БД:');
    console.error('   ', err.message);
  } else {
    console.log('\nБаза данных ПОДКЛЮЧЕНА!');
    console.log('   Тестовый запрос:', res.rows[0]);
  }
});

export default pool;
