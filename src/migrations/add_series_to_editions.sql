-- Добавление поля series в таблицу editions
-- Серия — это маркетинговая линейка издания (напр. "Эксклюзивная классика", "Азбука-классика")

ALTER TABLE editions ADD COLUMN IF NOT EXISTS series VARCHAR(255) DEFAULT NULL;

-- Индекс для поиска по серии
CREATE INDEX IF NOT EXISTS idx_editions_series ON editions(series) WHERE series IS NOT NULL;
