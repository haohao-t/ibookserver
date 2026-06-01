import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Загружаем .env прямо здесь — database.ts инициализируется раньше dotenv.config() в index.ts
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

pool.query('SELECT 1 + 1 AS result', (err, res) => {
  if (err) {
    console.error('\n❌ ОШИБКА ПОДКЛЮЧЕНИЯ К БД:');
    console.error('   ', err.message);
    console.error('\n📌 ЧТО ДЕЛАТЬ:');
    console.error('   1. Проверьте, запущен ли PostgreSQL:');
    console.error('      Win+R → services.msc → PostgreSQL → Запустить');
    console.error('   2. Проверьте пароль в pgAdmin:');
    console.error('      Откройте pgAdmin → Servers → PostgreSQL → Connect');
    console.error('   3. Создайте базу данных вручную:');
    console.error('      psql -U postgres -c "CREATE DATABASE person_liprary;"');
    console.error('   4. Временно отключите брандмауэр');
  } else {
    console.log('\n✅ База данных ПОДКЛЮЧЕНА!');
    console.log('   Тестовый запрос:', res.rows[0]);
  }
});

export default pool;