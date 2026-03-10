import { Pool } from 'pg';

// ЖЁСТКО прописываем параметры подключения
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'person_liprary',
  user: 'postgres',
  password: 'asasd',  // Пароль прямо здесь!
  // Эти настройки важны для Windows
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10
});

// Тест подключения с явным запросом
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