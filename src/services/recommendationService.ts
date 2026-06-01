// book_server/src/services/recommendationService.ts
import pool from '../config/database';

export interface Recommendation {
  id: number;
  title: string;
  author: string;
  cover_url: string | null;
  description: string | null;
  reason: string | null;
  genre: string | null;
  created_at: string;
}

interface AIBook {
  title: string;
  author: string;
  reason?: string;
  genre?: string;
}

interface UserContext {
  totalBooks: number;
  books: Array<{ title: string; author: string; genre: string | null; user_rating: number | null }>;
  topRated: Array<{ title: string; author: string }>;
  favoriteAuthors: string[];
  favoriteGenres: string[];
}

// Классические книги на случай если AI недоступен или библиотека пуста
const DEFAULT_BOOKS: AIBook[] = [
  { title: 'Мастер и Маргарита',          author: 'Михаил Булгаков',        reason: 'Культовый роман русской литературы',          genre: 'Классика' },
  { title: 'Дюна',                          author: 'Фрэнк Херберт',          reason: 'Лучший научно-фантастический роман XX века',   genre: 'Фантастика' },
  { title: '1984',                          author: 'Джордж Оруэлл',          reason: 'Антиутопия, изменившая взгляд на мир',         genre: 'Антиутопия' },
  { title: 'Маленький принц',               author: 'Антуан де Сент-Экзюпери', reason: 'Философская сказка для взрослых',              genre: 'Философия' },
  { title: 'Преступление и наказание',      author: 'Фёдор Достоевский',      reason: 'Глубочайший психологический роман мировой литературы', genre: 'Классика' },
];

class RecommendationService {
  private readonly CACHE_HOURS = 24;
  private readonly YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

  // ── Публичные методы ────────────────────────────────────────────────────────

  async getRecommendations(userId: number): Promise<Recommendation[]> {
    await this.ensureTable();

    // Есть свежий кэш?
    const cached = await pool.query(
      `SELECT * FROM user_recommendations
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '${this.CACHE_HOURS} hours'
       ORDER BY id`,
      [userId]
    );
    if (cached.rows.length > 0) {
      console.log(`📚 [Recommendations] Возврат из кэша (${cached.rows.length} рек.) для user ${userId}`);
      return cached.rows;
    }

    return this.generateAndSave(userId);
  }

  async refreshRecommendations(userId: number): Promise<Recommendation[]> {
    await this.ensureTable();
    await pool.query('DELETE FROM user_recommendations WHERE user_id = $1', [userId]);
    return this.generateAndSave(userId);
  }

  // ── Генерация ────────────────────────────────────────────────────────────────

  private async generateAndSave(userId: number): Promise<Recommendation[]> {
    console.log(`🤖 [Recommendations] Генерация рекомендаций для user ${userId}`);

    const context = await this.getUserContext(userId);
    let aiBooks: AIBook[];

    if (context.totalBooks === 0) {
      console.log('📚 [Recommendations] Библиотека пуста — используем дефолтные книги');
      aiBooks = DEFAULT_BOOKS;
    } else {
      const prompt = this.buildPrompt(context);
      const fromAI = await this.callYandexGPT(prompt);
      aiBooks = fromAI.length > 0 ? fromAI : DEFAULT_BOOKS;
    }

    // Обогащаем обложками и описанием из Google Books
    const enriched = await Promise.all(aiBooks.slice(0, 5).map(b => this.enrichWithGoogle(b)));

    // Сохраняем в БД
    await pool.query('DELETE FROM user_recommendations WHERE user_id = $1', [userId]);
    const saved: Recommendation[] = [];
    for (const book of enriched) {
      try {
        const row = await pool.query(
          `INSERT INTO user_recommendations
             (user_id, title, author, cover_url, description, reason, genre)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [userId, book.title, book.author, book.cover_url ?? null,
           book.description ?? null, book.reason ?? null, book.genre ?? null]
        );
        saved.push(row.rows[0]);
      } catch (err) {
        console.error('❌ [Recommendations] Ошибка сохранения:', err);
      }
    }

    console.log(`✅ [Recommendations] Сохранено ${saved.length} рекомендаций`);
    return saved;
  }

  // ── Контекст пользователя ────────────────────────────────────────────────────

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
    const topRated = books.filter((b: any) => b.user_rating >= 4);

    // Частотный анализ авторов
    const authorCounts: Record<string, number> = {};
    books.forEach((b: any) => {
      if (b.author) authorCounts[b.author] = (authorCounts[b.author] || 0) + 1;
    });
    const favoriteAuthors = Object.entries(authorCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);

    // Частотный анализ жанров
    const genreCounts: Record<string, number> = {};
    books.forEach((b: any) => {
      if (b.genre) genreCounts[b.genre] = (genreCounts[b.genre] || 0) + 1;
    });
    const favoriteGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);

    return { totalBooks: books.length, books, topRated, favoriteAuthors, favoriteGenres };
  }

  // ── Промпт ────────────────────────────────────────────────────────────────────

  private buildPrompt(ctx: UserContext): string {
    const bookLines = ctx.books.slice(0, 15)
      .map(b => `- «${b.title}» (${b.author || '?'})${b.user_rating ? `, оценка ${b.user_rating}/5` : ''}`)
      .join('\n');

    const topLines = ctx.topRated.length
      ? `\nВысоко оценённые:\n${ctx.topRated.map(b => `- «${b.title}» (${b.author})`).join('\n')}`
      : '';

    const authorsLine = ctx.favoriteAuthors.length
      ? `\nЛюбимые авторы: ${ctx.favoriteAuthors.join(', ')}` : '';
    const genresLine = ctx.favoriteGenres.length
      ? `\nПредпочитаемые жанры: ${ctx.favoriteGenres.join(', ')}` : '';

    return `У читателя в библиотеке есть книги:\n${bookLines}${topLines}${authorsLine}${genresLine}

Порекомендуй ровно 5 реальных книг, которых НЕТ в списке выше. Книги должны быть опубликованы и известны. Учитывай вкусы читателя. Ответь ТОЛЬКО в JSON:
{
  "recommendations": [
    { "title": "Название", "author": "Автор", "genre": "Жанр", "reason": "1-2 предложения почему эта книга подойдёт" }
  ]
}`;
  }

  // ── YandexGPT ────────────────────────────────────────────────────────────────

  private async callYandexGPT(prompt: string): Promise<AIBook[]> {
    const folderId = process.env.YANDEX_FOLDER_ID || '';
    const apiKey   = process.env.YANDEX_API_KEY   || '';

    if (!folderId || !apiKey) {
      console.warn('⚠️ [Recommendations] YandexGPT не настроен, используем дефолт');
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
        console.error('❌ [Recommendations] YandexGPT статус:', response.status);
        return [];
      }

      const data: any = await response.json();
      const text: string = data.result?.alternatives?.[0]?.message?.text ?? '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.error('❌ [Recommendations] JSON не найден в ответе'); return []; }

      const parsed = JSON.parse(jsonMatch[0]);
      const recs: AIBook[] = parsed.recommendations ?? parsed.books ?? [];

      console.log(`✅ [Recommendations] YandexGPT вернул ${recs.length} рекомендаций`);
      return recs;

    } catch (err: any) {
      console.error('❌ [Recommendations] Ошибка YandexGPT:', err.message);
      return [];
    }
  }

  // ── Google Books (обложка + описание) ───────────────────────────────────────

  private async enrichWithGoogle(book: AIBook): Promise<AIBook & {
    cover_url: string | undefined; description: string | undefined;
  }> {
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY || '';
    const q      = encodeURIComponent(`${book.title} ${book.author}`);
    const url    = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1${apiKey ? `&key=${apiKey}` : ''}`;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data: any = await resp.json();
      const vol  = data.items?.[0]?.volumeInfo;

      if (!vol) return { ...book, cover_url: undefined, description: undefined };

      const cover_url: string | undefined =
        vol.imageLinks?.extraLarge ??
        vol.imageLinks?.large      ??
        vol.imageLinks?.medium     ??
        vol.imageLinks?.thumbnail;

      const description: string | undefined = vol.description;

      return { ...book, cover_url, description };
    } catch {
      return { ...book, cover_url: undefined, description: undefined };
    }
  }

  // ── Создание таблицы при первом запуске ──────────────────────────────────────

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
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_recommendations_user_id
          ON user_recommendations(user_id)
      `);
      this.tableChecked = true;
    } catch (err) {
      console.error('❌ [Recommendations] Ошибка создания таблицы:', err);
    }
  }
}

export const recommendationService = new RecommendationService();
