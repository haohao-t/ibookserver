-- Миграция: таблица персональных рекомендаций книг
-- Запустить в pgAdmin: Query Tool → выполнить весь файл

CREATE TABLE IF NOT EXISTS user_recommendations (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(500) NOT NULL,
  author       VARCHAR(500) NOT NULL,
  cover_url    TEXT,
  description  TEXT,
  reason       TEXT,
  genre        VARCHAR(200),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_recommendations_user_id
  ON user_recommendations(user_id);
