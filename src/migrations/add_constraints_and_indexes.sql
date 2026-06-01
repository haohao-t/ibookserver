-- Миграция: CHECK-ограничения, индексы, уникальные ключи
-- Запустить в pgAdmin: Query Tool → выполнить весь файл
-- Каждый ADD CONSTRAINT обёрнут в DO-блок — безопасно запускать повторно

-- ─── 1. CHECK-ограничения ──────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE reading_progress ADD CONSTRAINT rp_status_check
    CHECK (status IN ('want_to_read','reading','finished','paused','abandoned'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE reading_progress ADD CONSTRAINT rp_rating_check
    CHECK (user_rating IS NULL OR (user_rating >= 1 AND user_rating <= 5));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE reading_progress ADD CONSTRAINT rp_current_page_check
    CHECK (current_page IS NULL OR current_page >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE reading_routes ADD CONSTRAINT rr_status_check
    CHECK (status IN ('draft','active','completed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE editions ADD CONSTRAINT editions_pages_check
    CHECK (pages IS NULL OR pages > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE editions ADD CONSTRAINT editions_year_check
    CHECK (publish_year IS NULL OR (publish_year >= 1000 AND publish_year <= 2100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE book_notes ADD CONSTRAINT notes_page_check
    CHECK (page_number IS NULL OR page_number > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_goal_check
    CHECK (reading_goal_pages IS NULL OR reading_goal_pages > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ─── 2. Уникальный ключ для route_books ───────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS route_books_route_work_unique
  ON route_books (route_id, work_id);


-- ─── 3. Производительные индексы ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_rp_user_id        ON reading_progress (user_id);
CREATE INDEX IF NOT EXISTS idx_rp_edition_id     ON reading_progress (edition_id) WHERE edition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rp_work_id        ON reading_progress (work_id)    WHERE work_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ul_user_id        ON user_library (user_id);
CREATE INDEX IF NOT EXISTS idx_ul_edition_id     ON user_library (edition_id) WHERE edition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ul_work_id        ON user_library (work_id)    WHERE work_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rr_user_id        ON reading_routes (user_id);
CREATE INDEX IF NOT EXISTS idx_rb_route_id       ON route_books (route_id);
CREATE INDEX IF NOT EXISTS idx_bc_collection_id  ON book_collections (collection_id);
CREATE INDEX IF NOT EXISTS idx_bn_library_id     ON book_notes (user_library_id);
CREATE INDEX IF NOT EXISTS idx_editions_isbn     ON editions (isbn) WHERE isbn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_works_author_id   ON works (author_id);
