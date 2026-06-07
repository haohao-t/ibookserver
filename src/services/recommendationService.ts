import pool from '../config/database';

export interface Recommendation {
  id: number;
  title: string;
  author: string;
  cover_url: string | null;
  description: string | null;
  reason: string | null;
  genre: string | null;
  pages: number | null;
  publish_year: number | null;
  publisher: string | null;
  created_at: string;
}

interface AIBook {
  title: string;
  author: string;
  reason?: string;
  genre?: string;
  description?: string;
}

interface UserContext {
  totalBooks: number;
  books: Array<{ title: string; author: string; genre: string | null; user_rating: number | null; status: string | null }>;
  finished: Array<{ title: string; author: string; user_rating: number | null }>;
  reading: Array<{ title: string; author: string }>;
  wantToRead: Array<{ title: string; author: string }>;
  topRated: Array<{ title: string; author: string }>;
  favoriteAuthors: string[];
  favoriteGenres: string[];
}

const DEFAULT_BOOKS: AIBook[] = [
  {
    title: 'Мастер и Маргарита', author: 'Михаил Булгаков', genre: 'Классика',
    reason: 'Один из самых читаемых русских романов XX века с уникальным сочетанием сатиры, мистики и философии.',
    description: 'Дьявол и его свита приезжают в советскую Москву, где встречают литературных чиновников, обывателей и влюблённых. Параллельно разворачивается история Понтия Пилата и Иешуа. Роман о добре, зле, трусости и любви.',
  },
  {
    title: 'Дюна', author: 'Фрэнк Херберт', genre: 'Фантастика',
    reason: 'Эпическая космическая опера, заложившая основы жанра научной фантастики.',
    description: 'На пустынной планете Арракис добывают редчайшее вещество во вселенной. Молодой Пол Атрейдес оказывается в центре политического заговора и начинает путь к становлению легендой. История о власти, экологии и судьбе.',
  },
  {
    title: '1984', author: 'Джордж Оруэлл', genre: 'Антиутопия',
    reason: 'Пророческий роман о тоталитаризме, актуальный как никогда.',
    description: 'Уинстон Смит живёт в государстве, где история переписывается, мысли контролируются, а война никогда не заканчивается. Его попытка сохранить человечность в бесчеловечном мире — история о любви и сопротивлении.',
  },
  {
    title: 'Маленький принц', author: 'Антуан де Сент-Экзюпери', genre: 'Философия',
    reason: 'Тонкая философская притча, которую по-разному воспринимают в детстве и во взрослом возрасте.',
    description: 'Маленький принц путешествует с планеты на планету и встречает разных взрослых, забывших, что важно в жизни. Трогательная история о дружбе, любви и потере, написанная лётчиком во время Второй мировой войны.',
  },
  {
    title: 'Преступление и наказание', author: 'Фёдор Достоевский', genre: 'Классика',
    reason: 'Глубочайший психологический роман о природе вины и морального выбора.',
    description: 'Студент Раскольников совершает убийство, чтобы проверить свою теорию о «праве сильных». Роман исследует психологию преступления, муки совести и путь к искуплению через страдание.',
  },
];

class RecommendationService {
  private readonly CACHE_HOURS = 24;
  private readonly YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

  async getRecommendations(userId: number): Promise<Recommendation[]> {
    await this.ensureTable();

    const cached = await pool.query(
      `SELECT * FROM user_recommendations
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '${this.CACHE_HOURS} hours'
       ORDER BY id`,
      [userId]
    );
    if (cached.rows.length > 0) {
      console.log(`[Recommendations] Возврат из кэша (${cached.rows.length} рек.) для user ${userId}`);
      return cached.rows;
    }

    return this.generateAndSave(userId);
  }

  async refreshRecommendations(userId: number): Promise<Recommendation[]> {
    await this.ensureTable();
    const context = await this.getUserContext(userId);
    if (context.totalBooks === 0) {
      const existing = await pool.query(
        `SELECT * FROM user_recommendations WHERE user_id = $1 AND source = 'default' ORDER BY id`,
        [userId]
      );
      if (existing.rows.length > 0) {
        await pool.query(
          'UPDATE user_recommendations SET created_at = NOW() WHERE user_id = $1',
          [userId]
        );
        return existing.rows;
      }
    }
    await pool.query('DELETE FROM user_recommendations WHERE user_id = $1', [userId]);
    return this.generateAndSave(userId, context);
  }

  private async generateAndSave(userId: number, preloadedContext?: UserContext): Promise<Recommendation[]> {
    console.log(`[Recommendations] Генерация рекомендаций для user ${userId}`);

    const context = preloadedContext ?? await this.getUserContext(userId);
    let aiBooks: AIBook[];
    let source: 'yandex' | 'default';

    if (context.totalBooks === 0) {
      console.log('[Recommendations] Библиотека пуста — используем дефолтные книги');
      aiBooks = DEFAULT_BOOKS;
      source = 'default';
    } else {
      const prompt = this.buildPrompt(context);
      const fromAI = await this.callYandexGPT(prompt);
      if (fromAI.length > 0) {
        aiBooks = fromAI;
        source = 'yandex';
      } else {
        aiBooks = DEFAULT_BOOKS;
        source = 'default';
      }
    }

    const enriched = await Promise.all(aiBooks.slice(0, 5).map(b => this.enrichWithGoogle(b)));

    await pool.query('DELETE FROM user_recommendations WHERE user_id = $1', [userId]);
    const saved: Recommendation[] = [];
    for (const book of enriched) {
      try {
        const row = await pool.query(
          `INSERT INTO user_recommendations
             (user_id, title, author, cover_url, description, reason, genre, pages, publish_year, publisher, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [userId, book.title, book.author, book.cover_url ?? null,
           book.description ?? null, book.reason ?? null, book.genre ?? null,
           (book as any).pages ?? null, (book as any).publish_year ?? null, (book as any).publisher ?? null,
           source]
        );
        saved.push(row.rows[0]);
      } catch (err) {
        console.error('[Recommendations] Ошибка сохранения:', err);
      }
    }

    console.log(`[Recommendations] Сохранено ${saved.length} рекомендаций (источник: ${source})`);
    return saved;
  }

  private async getUserContext(userId: number): Promise<UserContext> {
    const result = await pool.query(`
      SELECT
        w.title,
        a.full_name AS author,
        w.genre,
        rp.user_rating,
        rp.status
      FROM user_library ul
      LEFT JOIN editions e ON ul.edition_id = e.id
      LEFT JOIN works w ON COALESCE(e.work_id, ul.work_id) = w.id
      LEFT JOIN authors a ON w.author_id = a.id
      LEFT JOIN reading_progress rp ON
        rp.user_id = $1 AND
        (rp.edition_id = ul.edition_id OR rp.work_id = ul.work_id)
      WHERE ul.user_id = $1
        AND w.title IS NOT NULL
      ORDER BY rp.user_rating DESC NULLS LAST
      LIMIT 40
    `, [userId]);

    const books = result.rows;
    const finished   = books.filter((b: any) => b.status === 'finished');
    const reading    = books.filter((b: any) => b.status === 'reading');
    const wantToRead = books.filter((b: any) => b.status === 'want_to_read');
    const topRated   = books.filter((b: any) => b.user_rating >= 4);

    const authorCounts: Record<string, number> = {};
    books.forEach((b: any) => {
      if (b.author) authorCounts[b.author] = (authorCounts[b.author] || 0) + 1;
    });
    const favoriteAuthors = Object.entries(authorCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);

    const genreCounts: Record<string, number> = {};
    books.forEach((b: any) => {
      if (b.genre) genreCounts[b.genre] = (genreCounts[b.genre] || 0) + 1;
    });
    const favoriteGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);

    return { totalBooks: books.length, books, finished, reading, wantToRead, topRated, favoriteAuthors, favoriteGenres };
  }

  private buildPrompt(ctx: UserContext): string {
    const fmtBook = (b: { title: string; author: string; user_rating?: number | null }) =>
      `«${b.title}» (${b.author || '?'})${b.user_rating ? `, оценка ${b.user_rating}/5` : ''}`;

    const finishedLines = ctx.finished.length
      ? `Прочитано:\n${ctx.finished.slice(0, 12).map(fmtBook).join('\n')}` : '';
    const readingLines = ctx.reading.length
      ? `Читает сейчас:\n${ctx.reading.map(fmtBook).join('\n')}` : '';
    const wantLines = ctx.wantToRead.length
      ? `В планах:\n${ctx.wantToRead.slice(0, 8).map(fmtBook).join('\n')}` : '';
    const topLines = ctx.topRated.length
      ? `Высоко оценил (≥4/5):\n${ctx.topRated.slice(0, 6).map(fmtBook).join('\n')}` : '';
    const authorsLine = ctx.favoriteAuthors.length
      ? `Любимые авторы: ${ctx.favoriteAuthors.join(', ')}` : '';
    const genresLine = ctx.favoriteGenres.length
      ? `Предпочитаемые жанры: ${ctx.favoriteGenres.join(', ')}` : '';

    const sections = [finishedLines, readingLines, wantLines, topLines, authorsLine, genresLine]
      .filter(Boolean).join('\n\n');

    const allTitles = ctx.books.map(b => b.title.toLowerCase()).join(', ');

    return `Профиль читателя:

${sections}

Все книги читателя (НЕ рекомендовать ни одну из них): ${allTitles}

Порекомендуй ровно 5 реально существующих книг, которых НЕТ в списке читателя.

ТРЕБОВАНИЯ:

Поле "reason" (ОБЯЗАТЕЛЬНО персональное):
- Упомяни КОНКРЕТНУЮ книгу из библиотеки читателя по названию.
- Объясни КОНКРЕТНУЮ связь: похожий стиль, та же тема, тот же автор, продолжение идей.
- НЕ пиши "культовый роман", "шедевр", "лучший роман" — только персональная связь.
- Формат: "Поскольку вам [понравилась/интересна] «Книга X», вам понравится эта, потому что [конкретная связь]."
- Длина: 1–2 предложения.

Поле "description" (краткое описание сюжета):
- 2–3 предложения: о чём книга, главный герой, основной конфликт.
- НЕ спойлеры. Пиши как аннотация на обложке.

Ответь ТОЛЬКО в JSON без комментариев:
{
  "recommendations": [
    { "title": "Название", "author": "Автор", "genre": "Жанр", "reason": "персональное объяснение", "description": "краткая аннотация" }
  ]
}`;
  }

  private async callYandexGPT(prompt: string): Promise<AIBook[]> {
    const folderId = process.env.YANDEX_FOLDER_ID || '';
    const apiKey   = process.env.YANDEX_API_KEY   || '';

    if (!folderId || !apiKey) {
      console.warn('[Recommendations] YandexGPT не настроен, используем дефолт');
      return [];
    }

    try {
      const response = await fetch(this.YANDEX_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Api-Key ${apiKey}`,
          'x-folder-id': folderId,
        },
        body: JSON.stringify({
          modelUri: `gpt://${folderId}/yandexgpt-lite`,
          completionOptions: { stream: false, temperature: 0.6, maxTokens: 1500 },
          messages: [
            { role: 'system', text: 'Ты — эксперт по литературе. Отвечай ТОЛЬКО в формате JSON, без лишних слов.' },
            { role: 'user',   text: prompt },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error('[Recommendations] YandexGPT статус:', response.status);
        return [];
      }

      const data: any = await response.json();
      const text: string = data.result?.alternatives?.[0]?.message?.text ?? '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.error('[Recommendations] JSON не найден в ответе'); return []; }

      const parsed = JSON.parse(jsonMatch[0]);
      const recs: AIBook[] = parsed.recommendations ?? parsed.books ?? [];

      console.log(`[Recommendations] YandexGPT вернул ${recs.length} рекомендаций`);
      return recs;

    } catch (err: any) {
      console.error('[Recommendations] Ошибка YandexGPT:', err.message);
      return [];
    }
  }

  private async enrichWithGoogle(book: AIBook): Promise<AIBook & {
    cover_url: string | undefined;
    description: string | undefined;
    pages: number | undefined;
    publish_year: number | undefined;
    publisher: string | undefined;
  }> {
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY || '';
    const blank = {
      ...book,
      cover_url: undefined as string | undefined,
      pages: undefined as number | undefined,
      publish_year: undefined as number | undefined,
      publisher: undefined as string | undefined,
    } as AIBook & { cover_url: string | undefined; description: string | undefined; pages: number | undefined; publish_year: number | undefined; publisher: string | undefined };

    const trySearch = async (q: string) => {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3${apiKey ? `&key=${apiKey}` : ''}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const data: any = await resp.json();
      return (data.items ?? []) as any[];
    };

    const pickCover = (vol: any): string | undefined => {
      const raw =
        vol.imageLinks?.extraLarge ??
        vol.imageLinks?.large      ??
        vol.imageLinks?.medium     ??
        vol.imageLinks?.thumbnail;
      return raw
        ? raw.replace(/^http:\/\//, 'https://').replace('&edge=curl', '').replace('zoom=1', 'zoom=3')
        : undefined;
    };

    try {
      let items = await trySearch(`intitle:"${book.title}" inauthor:"${book.author}"`);
      // Fallback: unquoted search
      if (!items.length) items = await trySearch(`${book.title} ${book.author}`);

      const vol = items.find((i: any) => pickCover(i.volumeInfo))?.volumeInfo
               ?? items[0]?.volumeInfo;

      let cover_url: string | undefined;
      let description: string | undefined;
      let pages: number | undefined;
      let publish_year: number | undefined;
      let publisher: string | undefined;

      if (vol) {
        cover_url   = pickCover(vol);
        description = vol.description || book.description;
        pages       = vol.pageCount || undefined;
        publish_year = vol.publishedDate ? (parseInt(vol.publishedDate.substring(0, 4)) || undefined) : undefined;
        publisher   = vol.publisher || undefined;
      } else {
        description = book.description;
      }

      if (!cover_url) {
        cover_url = await this.fetchOpenLibraryCover(book.title, book.author);
      }

      return { ...book, cover_url, description, pages, publish_year, publisher } as AIBook & { cover_url: string | undefined; description: string | undefined; pages: number | undefined; publish_year: number | undefined; publisher: string | undefined };
    } catch {
      return blank;
    }
  }

  private async fetchOpenLibraryCover(title: string, author: string): Promise<string | undefined> {
    try {
      const q = encodeURIComponent(`${title} ${author}`);
      const resp = await fetch(
        `https://openlibrary.org/search.json?q=${q}&fields=cover_i&limit=3`,
        { signal: AbortSignal.timeout(5000) }
      );
      const data: any = await resp.json();
      const coverId = data.docs?.find((d: any) => d.cover_i)?.cover_i;
      if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    } catch {
    }
    return undefined;
  }

  private tableChecked = false;

  private async ensureTable() {
    if (this.tableChecked) return;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_recommendations (
          id          SERIAL PRIMARY KEY,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title       VARCHAR(500) NOT NULL,
          author      VARCHAR(500) NOT NULL,
          cover_url   TEXT,
          description TEXT,
          reason      TEXT,
          genre       VARCHAR(200),
          pages       INTEGER,
          publish_year INTEGER,
          publisher   VARCHAR(300),
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`ALTER TABLE user_recommendations ADD COLUMN IF NOT EXISTS pages INTEGER`);
      await pool.query(`ALTER TABLE user_recommendations ADD COLUMN IF NOT EXISTS publish_year INTEGER`);
      await pool.query(`ALTER TABLE user_recommendations ADD COLUMN IF NOT EXISTS publisher VARCHAR(300)`);
      await pool.query(`ALTER TABLE user_recommendations ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'default'`);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_recommendations_user_id
          ON user_recommendations(user_id)
      `);
      this.tableChecked = true;
    } catch (err) {
      console.error('[Recommendations] Ошибка создания таблицы:', err);
    }
  }
}

export const recommendationService = new RecommendationService();
