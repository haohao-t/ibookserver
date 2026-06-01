-- Миграция: поддержка добавления книг без ISBN (только как произведение)
-- Запустить в pgAdmin: Query Tool → выполнить весь файл

-- 1. user_library: edition_id → необязательный, добавить work_id
ALTER TABLE user_library ALTER COLUMN edition_id DROP NOT NULL;
ALTER TABLE user_library ADD COLUMN work_id INTEGER REFERENCES works(id) ON DELETE CASCADE;
ALTER TABLE user_library ADD CONSTRAINT ul_check_edition_or_work
  CHECK (edition_id IS NOT NULL OR work_id IS NOT NULL);

-- Заменяем старый уникальный индекс частичными
ALTER TABLE user_library DROP CONSTRAINT IF EXISTS user_library_user_id_edition_id_key;
CREATE UNIQUE INDEX ul_edition_unique ON user_library (user_id, edition_id) WHERE edition_id IS NOT NULL;
CREATE UNIQUE INDEX ul_work_unique   ON user_library (user_id, work_id)   WHERE work_id   IS NOT NULL;

-- 2. reading_progress: то же самое
ALTER TABLE reading_progress ALTER COLUMN edition_id DROP NOT NULL;
ALTER TABLE reading_progress ADD COLUMN work_id INTEGER REFERENCES works(id) ON DELETE CASCADE;
ALTER TABLE reading_progress ADD CONSTRAINT rp_check_edition_or_work
  CHECK (edition_id IS NOT NULL OR work_id IS NOT NULL);

ALTER TABLE reading_progress DROP CONSTRAINT IF EXISTS reading_progress_user_id_edition_id_key;
CREATE UNIQUE INDEX rp_edition_unique ON reading_progress (user_id, edition_id) WHERE edition_id IS NOT NULL;
CREATE UNIQUE INDEX rp_work_unique    ON reading_progress (user_id, work_id)    WHERE work_id   IS NOT NULL;
