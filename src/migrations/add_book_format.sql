-- Миграция: добавить поле format в user_library
-- Запустить в pgAdmin: Query Tool → выполнить весь файл

ALTER TABLE user_library
  ADD COLUMN IF NOT EXISTS format VARCHAR(10) DEFAULT 'physical'
  CHECK (format IN ('physical', 'digital', 'audio'));

-- Обновим все существующие записи
UPDATE user_library SET format = 'physical' WHERE format IS NULL;
