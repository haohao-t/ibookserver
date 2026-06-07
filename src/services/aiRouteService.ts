import pool from '../config/database';

export interface AIBookSuggestion {
  title: string;
  author: string;
  reason?: string;
}

export interface AIRouteResponse {
  name: string;
  description: string;
  books: AIBookSuggestion[];
}

export type RouteErrorCode = 'not_related' | 'no_books' | 'ai_error';

export type RouteGenerationResult =
  | { ok: true; route: AIRouteResponse }
  | { ok: false; errorCode: RouteErrorCode };

class YandexGptService {
  private folderId: string;
  private apiKey: string;
  private apiUrl = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

  constructor() {
    this.folderId = process.env.YANDEX_FOLDER_ID || '';
    this.apiKey = process.env.YANDEX_API_KEY || '';

    if (!this.folderId || !this.apiKey) {
      console.warn('YandexGPT: не заданы YANDEX_FOLDER_ID или YANDEX_API_KEY');
    }
  }

  async generateReadingRoute(userQuery: string, userContext?: {
    readBooks: string[];
    favoriteGenres: string[];
    favoriteAuthors: string[];
    userAge?: number | null;
  }): Promise<RouteGenerationResult> {
    console.log('\n[YandexGPT] ========== ГЕНЕРАЦИЯ МАРШРУТА ==========');
    console.log('[YandexGPT] Запрос:', userQuery);

    const ageNote = userContext?.userAge
      ? `\n- Возраст читателя: ${userContext.userAge} лет — подбирай книги, подходящие по возрасту и уровню восприятия`
      : '';

    const librarySection = userContext && (userContext.readBooks.length > 0 || userContext.userAge)
      ? `\n\nКонтекст читателя:${ageNote}
- Уже прочитано (НЕ включать в маршрут): ${userContext.readBooks.slice(0, 15).join(', ') || 'нет данных'}
- Любимые жанры: ${userContext.favoriteGenres.join(', ') || 'не указаны'}
- Любимые авторы: ${userContext.favoriteAuthors.join(', ') || 'не указаны'}

Учитывай вкусы и возраст читателя при формировании маршрута. НЕ добавляй книги из списка "уже прочитано".`
      : '';

    try {
      const requestBody = {
        modelUri: `gpt://${this.folderId}/yandexgpt-lite`,
        completionOptions: {
          stream: false,
          temperature: 0.6,
          maxTokens: 2000
        },
        messages: [
          {
            role: 'system',
            text: `Ты — эксперт по литературе. Создавай персонализированные читательские маршруты.
ВАЖНО: Всегда отвечай ТОЛЬКО на русском языке, даже если запрос на другом языке.
Ответь ТОЛЬКО в формате JSON, без лишних слов и пояснений.

СНАЧАЛА проверь, связан ли запрос с книгами, чтением, литературой, изучением любой темы или навыка через книги.

Если запрос НЕ связан с книгами (например: рецепты, спорт, технические задачи без учёбы, бытовые вопросы) — ответь ТОЛЬКО:
{"error":"not_related"}

Если запрос связан с книгами, но реально существующих подходящих книг крайне мало или их нет — ответь ТОЛЬКО:
{"error":"no_books"}

Иначе ответь в формате:
{
  "name": "Название маршрута (3-6 слов, на русском)",
  "description": "Описание маршрута (2-3 предложения, на русском)",
  "books": [
    { "title": "Название книги (оригинал или перевод)", "author": "Автор", "reason": "1 предложение на русском — почему эта книга в маршруте" }
  ]
}

Требования к маршруту:
- Ровно 5 книг
- Книги реально существующие и широко известные
- Порядок: от простых к сложным
- reason: конкретный (связь с темой запроса), не «культовый роман»
- Все поля name, description, reason — строго на русском языке

Если пользователь хочет изучить язык (например, английский, испанский и т.д.):
- Включай учебники и методические пособия по изучению этого языка (Мёрфи, Эккерсли, Голицынский и т.п.)
- Включай произведения на изучаемом языке с адаптацией для начинающих (graded readers)
- Если запрос на русском — значит пользователь русскоязычный, книги должны помочь изучить нужный язык с нуля
- Не предлагай только художественные произведения на этом языке${librarySection}`
          },
          {
            role: 'user',
            text: userQuery
          }
        ]
      };

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Api-Key ${this.apiKey}`,
          'x-folder-id': this.folderId
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[YandexGPT] Ошибка API:', response.status, errorText);
        return { ok: false, errorCode: 'ai_error' };
      }

      const data = await response.json();
      console.log('[YandexGPT] Ответ получен');

      const assistantMessage: string = data.result?.alternatives?.[0]?.message?.text ?? '';

      if (!assistantMessage) {
        console.error('[YandexGPT] Пустой ответ от модели');
        return { ok: false, errorCode: 'ai_error' };
      }

      console.log('[YandexGPT] Raw response (first 300):', assistantMessage.substring(0, 300));

      let jsonString: string | null = null;

      const mdMatch = assistantMessage.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (mdMatch) {
        jsonString = mdMatch[1] ?? null;
      }

      if (!jsonString) {
        const start = assistantMessage.indexOf('{');
        const end = assistantMessage.lastIndexOf('}');
        if (start !== -1 && end > start) {
          jsonString = assistantMessage.substring(start, end + 1);
        }
      }

      if (!jsonString) {
        console.error('[YandexGPT] JSON не найден в ответе');
        return { ok: false, errorCode: 'ai_error' };
      }

      try {
        const parsed = JSON.parse(jsonString);

        if (parsed.error === 'not_related') {
          console.log('[YandexGPT] Запрос не связан с книгами');
          return { ok: false, errorCode: 'not_related' };
        }
        if (parsed.error === 'no_books') {
          console.log('[YandexGPT] Не удалось подобрать книги');
          return { ok: false, errorCode: 'no_books' };
        }

        if (!parsed.books || !Array.isArray(parsed.books) || parsed.books.length === 0) {
          console.error('[YandexGPT] Нет книг в ответе');
          return { ok: false, errorCode: 'no_books' };
        }
        return { ok: true, route: parsed as AIRouteResponse };
      } catch (parseErr) {
        console.error('[YandexGPT] Ошибка парсинга JSON:', (parseErr as Error).message);
        console.error('[YandexGPT] Строка:', jsonString.substring(0, 300));
        return { ok: false, errorCode: 'ai_error' };
      }

    } catch (error) {
      console.error('[YandexGPT] Ошибка:', error);
      return { ok: false, errorCode: 'ai_error' };
    }
  }
 
  async findOrCreateWork(title: string, author: string): Promise<number | null> {
    console.log(`[AI] Поиск/создание произведения: ${title} - ${author}`);
    
    try { 
      let authorId = await this.findOrCreateAuthor(author);
      if (!authorId) {
        console.error(`[AI] Не удалось создать автора: ${author}`);
        return null;
      }
 
      const workResult = await pool.query(
        `SELECT id FROM works 
         WHERE LOWER(title) = LOWER($1) AND author_id = $2`,
        [title.trim(), authorId]
      );

      if (workResult.rows.length > 0) {
        console.log(`[AI] Произведение найдено, work_id: ${workResult.rows[0].id}`);
        return workResult.rows[0].id;
      }
 
      console.log(`[AI] Произведения нет в БД, ищем реальные данные...`);
      const bookData = await this.findBookData(title, author);
       
      const description = bookData?.description || null;
      const genre = bookData?.genre || null;
      
      const newWork = await pool.query(
        `INSERT INTO works (title, author_id, description, genre, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
         RETURNING id`,
        [title, authorId, description, genre]
      );
      
      const workId = newWork.rows[0].id;
      console.log(`[AI] Создано новое произведение, work_id: ${workId}`);
 
      if (bookData && (bookData.isbn || bookData.publisher || bookData.pages)) {
        await this.createEdition(workId, bookData);
      }

      return workId;

    } catch (error) {
      console.error('[AI] Ошибка поиска/создания произведения:', error);
      return null;
    }
  }

  private async findOrCreateAuthor(authorName: string): Promise<number | null> {
    try { 
      const authorResult = await pool.query(
        'SELECT id FROM authors WHERE LOWER(full_name) = LOWER($1)',
        [authorName.trim()]
      );
      
      if (authorResult.rows.length > 0) {
        return authorResult.rows[0].id;
      }
 
      const newAuthor = await pool.query(
        'INSERT INTO authors (full_name, created_at) VALUES ($1, CURRENT_TIMESTAMP) RETURNING id',
        [authorName.trim()]
      );
      
      console.log(`[AI] Создан новый автор: ${authorName}, ID: ${newAuthor.rows[0].id}`);
      return newAuthor.rows[0].id;

    } catch (error) {
      console.error('[AI] Ошибка при работе с автором:', error);
      return null;
    }
  }

  private async findBookData(title: string, author: string): Promise<{
    isbn?: string;
    publisher?: string;
    publishYear?: number;
    pages?: number;
    coverUrl?: string;
    language?: string;
    description?: string;
    genre?: string;
  } | null> {
    console.log(`[AI] Поиск данных книги в Google Books: ${title} - ${author}`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
  
    try {
      const searchQuery = encodeURIComponent(`${title} ${author}`);
      const url = `https://www.googleapis.com/books/v1/volumes?q=${searchQuery}&maxResults=1`;
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      const data = await response.json();
      
      if (!data.items || data.items.length === 0) {
        console.log(`[AI] Книга не найдена в Google Books`);
        return null;
      }
      
      const volume = data.items[0].volumeInfo;
      
      const isbnIdentifier = volume.industryIdentifiers?.find(
        (id: any) => id.type === 'ISBN_13' || id.type === 'ISBN_10'
      );
      
      const genre = volume.categories?.[0] || null;
      
      let publishYear: number | undefined;
      if (volume.publishedDate) {
        const year = parseInt(volume.publishedDate.substring(0, 4));
        if (!isNaN(year)) {
          publishYear = year;
        }
      }
      
      const bookData: {
        isbn?: string;
        publisher?: string;
        publishYear?: number;
        pages?: number;
        coverUrl?: string;
        language?: string;
        description?: string;
        genre?: string;
      } = {};
      
      if (isbnIdentifier?.identifier) bookData.isbn = isbnIdentifier.identifier;
      if (volume.publisher) bookData.publisher = volume.publisher;
      if (publishYear !== undefined) bookData.publishYear = publishYear;
      if (volume.pageCount) bookData.pages = volume.pageCount;
      if (volume.imageLinks?.thumbnail || volume.imageLinks?.smallThumbnail) {
        bookData.coverUrl = volume.imageLinks?.thumbnail || volume.imageLinks?.smallThumbnail;
      }
      if (volume.language) bookData.language = volume.language;
      if (volume.description) bookData.description = volume.description;
      if (genre) bookData.genre = genre;
       
      if (!bookData.language) bookData.language = 'ru';
      
      console.log(`[AI] Найдены данные: ISBN=${bookData.isbn || '?'}, страниц=${bookData.pages || '?'}, жанр=${bookData.genre || '?'}`);
      return bookData;
      
    } catch (error) {
      clearTimeout(timeout);
      console.warn(`[AI] Ошибка поиска данных для "${title}":`, error);
      return null;
    }
  }

  private async createEdition(workId: number, bookData: {
    isbn?: string;
    publisher?: string;
    publishYear?: number;
    pages?: number;
    coverUrl?: string;
    language?: string;
    description?: string;
    genre?: string;
  }): Promise<number | null> {
    try {
      const isbn = bookData.isbn || null;
      const publisher = bookData.publisher || null;
      const publishYear = bookData.publishYear || null;
      const pages = bookData.pages || null;
      const coverUrl = bookData.coverUrl || null;
      const language = bookData.language || 'ru';
      
      const editionResult = await pool.query(
        `INSERT INTO editions (work_id, isbn, publisher, publish_year, pages, cover_url, language, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
         ON CONFLICT (isbn) DO NOTHING
         RETURNING id`,
        [workId, isbn, publisher, publishYear, pages, coverUrl, language]
      );
      
      if (editionResult.rows.length > 0) {
        console.log(`[AI] Создано издание, edition_id: ${editionResult.rows[0].id}`);
        return editionResult.rows[0].id;
      }
      
      if (isbn) {
        const existing = await pool.query(
          'SELECT id FROM editions WHERE isbn = $1',
          [isbn]
        );
        if (existing.rows.length > 0) {
          console.log(`[AI] Издание уже существует, edition_id: ${existing.rows[0].id}`);
          return existing.rows[0].id;
        }
      }
      
      return null;
    } catch (error) {
      console.error('[AI] Ошибка создания издания:', error);
      return null;
    }
  }

  async getOrCreateEdition(workId: number): Promise<number | null> {
    try {
      const existingEdition = await pool.query(
        `SELECT id FROM editions WHERE work_id = $1 LIMIT 1`,
        [workId]
      );
      
      if (existingEdition.rows.length > 0) {
        console.log(`[AI] Найдено существующее издание, edition_id: ${existingEdition.rows[0].id}`);
        return existingEdition.rows[0].id;
      }
      
      const newEdition = await pool.query(
        `INSERT INTO editions (work_id, language, created_at, updated_at) 
         VALUES ($1, 'ru', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
         RETURNING id`,
        [workId]
      );
      
      console.log(`[AI] Создано базовое издание, edition_id: ${newEdition.rows[0].id}`);
      return newEdition.rows[0].id;
      
    } catch (error) {
      console.error('[AI] Ошибка при получении/создании издания:', error);
      return null;
    }
  }

  async addBookToRoute(
    routeId: number,
    workId: number,
    orderIndex: number
  ): Promise<boolean> {
  
    try {
  
      await pool.query(
        `
        INSERT INTO route_books (
          route_id,
          work_id,
          order_index
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (route_id, work_id)
        DO NOTHING
        `,
        [
          routeId,
          workId,
          orderIndex
        ]
      );
  
      return true;
  
    } catch (error) {
  
      console.error(error);
      return false;
  
    }
  }

  async getUserBooks(userId: number): Promise<string[]> {
    try {
      const result = await pool.query(
        `SELECT DISTINCT w.title, a.full_name as author
         FROM user_library ul
         JOIN editions e ON ul.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         JOIN authors a ON w.author_id = a.id
         WHERE ul.user_id = $1
         LIMIT 20`,
        [userId]
      );
      
      return result.rows.map((row: any) => `${row.title} (${row.author})`);
    } catch (error) {
      console.error('[AI] Ошибка получения книг пользователя:', error);
      return [];
    }
  } 
  async getRouteWithBooks(routeId: number, userId: number) { 
    const routeResult = await pool.query(
      'SELECT * FROM reading_routes WHERE id = $1 AND user_id = $2',
      [routeId, userId]
    );
    if (routeResult.rows.length === 0) throw new Error('Маршрут не найден');
 
    const booksResult = await pool.query(`
      SELECT 
        rb.id as route_book_id,
        rb.order_index,
        w.id as work_id,
        w.title,
        a.full_name as author,
        COALESCE(
          (SELECT e.cover_url FROM editions e JOIN user_library ul ON ul.edition_id = e.id WHERE e.work_id = rb.work_id AND ul.user_id = $2 LIMIT 1),
          (SELECT cover_url FROM editions WHERE work_id = rb.work_id ORDER BY id LIMIT 1)
        ) as cover_url,
        COALESCE(
          (SELECT e.pages FROM editions e JOIN user_library ul ON ul.edition_id = e.id WHERE e.work_id = rb.work_id AND ul.user_id = $2 LIMIT 1),
          (SELECT pages FROM editions WHERE work_id = rb.work_id ORDER BY id LIMIT 1)
        ) as total_pages,
        (SELECT rp.current_page FROM reading_progress rp JOIN editions e ON rp.edition_id = e.id WHERE e.work_id = rb.work_id AND rp.user_id = $2 LIMIT 1) as current_page,
        (SELECT rp.status FROM reading_progress rp JOIN editions e ON rp.edition_id = e.id WHERE e.work_id = rb.work_id AND rp.user_id = $2 LIMIT 1) as user_status,
        (SELECT rp.user_rating FROM reading_progress rp JOIN editions e ON rp.edition_id = e.id WHERE e.work_id = rb.work_id AND rp.user_id = $2 LIMIT 1) as user_rating,
        (SELECT e.id FROM editions e JOIN user_library ul ON ul.edition_id = e.id WHERE e.work_id = rb.work_id AND ul.user_id = $2 LIMIT 1) as owned_edition_id,
        EXISTS(
          SELECT 1 FROM user_library ul JOIN editions e ON ul.edition_id = e.id WHERE e.work_id = rb.work_id AND ul.user_id = $2
        ) as is_owned
      FROM route_books rb
      JOIN works w ON rb.work_id = w.id
      JOIN authors a ON w.author_id = a.id
      WHERE rb.route_id = $1
      ORDER BY rb.order_index
    `, [routeId, userId]);

    return {
      route: routeResult.rows[0],
      books: booksResult.rows.map(row => ({
        id: row.route_book_id,
        book_id: row.owned_edition_id, 
        work_id: row.work_id,
        title: row.title,
        author: row.author,
        cover_url: row.cover_url,
        order_index: row.order_index,
        status: row.user_status || 'want_to_read',
        current_page: row.current_page || 0,
        total_pages: row.total_pages || 0,
        user_rating: row.user_rating,
        is_owned: row.is_owned 
      }))
    };
  }

}

export const aiRouteService = new YandexGptService();