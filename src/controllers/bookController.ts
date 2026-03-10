// book_server/src/controllers/bookController.ts

import { Request, Response } from 'express';
import pool from '../config/database';
import { enhancedBookApiService } from '../services/enhancedBookApiService';

export const bookController = {
  // 1️⃣ ДОБАВЛЕНИЕ КНИГИ ПО ISBN
  async addBookByISBN(req: Request, res: Response) {
    try {
      const { isbn } = req.body;
      const userId = (req as any).user.id;

      console.log('\n📚 [Controller] ========== ДОБАВЛЕНИЕ КНИГИ ==========');
      console.log('📚 [Controller] User ID:', userId);
      console.log('📚 [Controller] ISBN:', isbn);

      if (!isbn) {
        return res.status(400).json({ error: 'ISBN не указан' });
      }

      // Очищаем ISBN
      const cleanIsbn = isbn.replace(/[-\s]/g, '');

      // 1️⃣ Проверяем, есть ли уже эта книга у пользователя
      const userBookCheck = await pool.query(
        `SELECT ul.id, b.id as book_id, b.title, b.isbn 
         FROM user_library ul
         JOIN books b ON ul.book_id = b.id
         WHERE ul.user_id = $1 AND b.isbn = $2`,
        [userId, cleanIsbn]
      );

      if (userBookCheck.rows.length > 0) {
        console.log('📚 [Controller] ⚠️ Книга уже есть у пользователя');
        return res.status(200).json({
          success: true,
          message: 'Книга уже в вашей библиотеке',
          bookId: userBookCheck.rows[0].book_id,
          alreadyExists: true
        });
      }

      // 2️⃣ Проверяем, есть ли книга в общей таблице books
      let bookResult = await pool.query(
        'SELECT * FROM books WHERE isbn = $1',
        [cleanIsbn]
      );

      let bookId;
      let bookTitle = '';

      // 3️⃣ Если книги нет в БД - ищем в API и добавляем
      if (bookResult.rows.length === 0) {
        console.log('📚 [Controller] Книга не найдена в БД, ищем в API...');
        
        const bookData = await enhancedBookApiService.findBookByISBN(cleanIsbn);

        if (!bookData) {
          return res.status(404).json({ 
            error: 'Книга не найдена ни в одном из внешних API' 
          });
        }

        bookTitle = bookData.title;
        console.log('📚 [Controller] Найдена книга:', bookTitle);

        // Проверяем/добавляем автора
        let authorId;
        if (bookData.authors && bookData.authors.length > 0) {
          const authorName = bookData.authors[0];
          
          let authorRes = await pool.query(
            'SELECT id FROM authors WHERE full_name = $1',
            [authorName]
          );

          if (authorRes.rows.length === 0) {
            const newAuthor = await pool.query(
              'INSERT INTO authors (full_name) VALUES ($1) RETURNING id',
              [authorName]
            );
            authorId = newAuthor.rows[0].id;
            console.log('📚 [Controller] Добавлен новый автор:', authorName);
          } else {
            authorId = authorRes.rows[0].id;
          }
        }

        // Добавляем книгу
        // В методе addBookByISBN, строка с INSERT INTO books:
const newBook = await pool.query(
  `INSERT INTO books 
   (title, isbn, author_id, description, cover_url, pages, publisher, language, publish_year, genre) 
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
   RETURNING id`,
  [
    bookData.title,
    cleanIsbn,
    authorId || null,
    bookData.description || '',
    bookData.coverUrl || '',
    bookData.pages,
    bookData.publisher || '',
    bookData.language || 'ru',
    bookData.publish_year,
    bookData.genre || '' // Добавьте genre, если есть в API
  ]
);
        bookId = newBook.rows[0].id;
        console.log('📚 [Controller] Книга добавлена в БД, ID:', bookId);
      } else {
        // Книга уже есть в БД
        bookId = bookResult.rows[0].id;
        bookTitle = bookResult.rows[0].title;
        console.log('📚 [Controller] Книга уже есть в БД, ID:', bookId);
      }

      // 4️⃣ Добавляем в библиотеку пользователя (с проверкой на дубликат)
      const libraryResult = await pool.query(
        `INSERT INTO user_library (user_id, book_id, added_via, added_at) 
         VALUES ($1, $2, 'isbn_scan', CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, book_id) DO NOTHING
         RETURNING id`,
        [userId, bookId]
      );

      // 5️⃣ Если запись добавилась (не было конфликта)
      if (libraryResult.rows.length > 0) {
        // Создаем запись прогресса
        await pool.query(
          `INSERT INTO reading_progress (user_id, book_id, status, created_at) 
           VALUES ($1, $2, 'want_to_read', CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, book_id) DO NOTHING`,
          [userId, bookId]
        );
        
        console.log('📚 [Controller] ✅ Книга добавлена в библиотеку пользователя');
        
        res.status(201).json({ 
          success: true, 
          message: 'Книга добавлена в библиотеку',
          bookId,
          title: bookTitle,
          alreadyExists: false
        });
      } else {
        // Книга уже была в библиотеке (сработал ON CONFLICT)
        console.log('📚 [Controller] ⚠️ Книга уже была в библиотеке пользователя');
        
        res.status(200).json({ 
          success: true, 
          message: 'Книга уже в вашей библиотеке',
          bookId,
          title: bookTitle,
          alreadyExists: true
        });
      }

    } catch (error) {
      console.error('❌ Ошибка добавления книги:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 2️⃣ ПОИСК КНИГИ ПО ISBN (без сохранения)
  async searchBookByISBN(req: Request, res: Response) {
    console.log('\n🔵 [Controller] ========== ПОИСК КНИГИ ==========');
    
    try {
      const isbnParam = req.params.isbn;
      const isbn = Array.isArray(isbnParam) ? isbnParam[0] : isbnParam;
      
      if (!isbn || isbn.trim() === '') {
        return res.status(400).json({ error: 'ISBN не указан' });
      }

      const cleanIsbn = isbn.replace(/[-\s]/g, '');
      
      // Устанавливаем таймаут для всего запроса
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Search timeout')), 15000);
      });

      const searchPromise = enhancedBookApiService.findBookByISBN(cleanIsbn);
      
      const bookData = await Promise.race([searchPromise, timeoutPromise]);

      if (!bookData) {
        return res.status(200).json({ 
          found: false, 
          isbn: cleanIsbn,
          message: 'Книга не найдена' 
        });
      }

      res.json({
        found: true,
        ...bookData
      });

    } catch (error) {
      console.error('🔵 [Controller] ❌ Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 3️⃣ ПОЛУЧИТЬ ВСЕ КНИГИ ПОЛЬЗОВАТЕЛЯ
 
// В bookController.ts - метод getUserBooks

async getUserBooks(req: Request, res: Response) {
  try {
    const userId = (req as any).user.id;
    
    console.log('[Controller] Получение книг пользователя:', userId);
    
    // Исправленный запрос - убраны лишние кавычки и исправлены имена полей
    const result = await pool.query(
      `SELECT 
        b.id, 
        b.title, 
        b.isbn, 
        b.cover_url, 
        b.pages, 
        b.publish_year,
        a.full_name as author,
        rp.status, 
        rp.current_page, 
        rp.total_pages, 
        rp.user_rating,
        ul.added_at, 
        ul.added_via,
        ul.is_favorite
       FROM user_library ul
       JOIN books b ON ul.book_id = b.id
       JOIN authors a ON b.author_id = a.id
       LEFT JOIN reading_progress rp ON rp.user_id = ul.user_id AND rp.book_id = ul.book_id
       WHERE ul.user_id = $1
       ORDER BY ul.added_at DESC`,
      [userId]
    );
    
    console.log('[Controller] Найдено книг:', result.rows.length);
    res.json(result.rows);
    
  } catch (error) {
    console.error('❌ Ошибка получения книг:', error);
    res.status(500).json({ error: 'Ошибка сервера при получении книг' });
  }
},

  // 4️⃣ ОБНОВИТЬ ПРОГРЕСС ЧТЕНИЯ
  async updateProgress(req: Request, res: Response) {
    try {
      const { bookId } = req.params;
      const userId = (req as any).user.id;
      const { current_page, status, user_rating, user_review } = req.body;

      // Получаем общее количество страниц
      const bookInfo = await pool.query(
        'SELECT pages FROM books WHERE id = $1',
        [bookId]
      );

      let finished_at = null;
      if (status === 'finished') {
        finished_at = new Date();
      }

      const result = await pool.query(
        `UPDATE reading_progress 
         SET 
           current_page = COALESCE($1, current_page),
           status = COALESCE($2, status),
           user_rating = COALESCE($3, user_rating),
           user_review = COALESCE($4, user_review),
           finished_at = COALESCE($5, finished_at),
           total_pages = COALESCE($6, total_pages),
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $7 AND book_id = $8
         RETURNING *`,
        [
          current_page, 
          status, 
          user_rating, 
          user_review, 
          finished_at,
          bookInfo.rows[0]?.pages,
          userId, 
          bookId
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Запись не найдена' });
      }

      res.json({ 
        success: true, 
        message: 'Прогресс обновлен',
        progress: result.rows[0] 
      });

    } catch (error) {
      console.error('Ошибка обновления прогресса:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 5️⃣ ДОБАВИТЬ ЗАМЕТКУ К КНИГЕ
  async addNote(req: Request, res: Response) {
    try {
      const { bookId } = req.params;
      const userId = (req as any).user.id;
      const { content, page_number } = req.body;

      // Получаем user_library_id
      const libRes = await pool.query(
        'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
        [userId, bookId]
      );

      if (libRes.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      const result = await pool.query(
        `INSERT INTO book_notes (user_library_id, content, page_number) 
         VALUES ($1, $2, $3) 
         RETURNING *`,
        [libRes.rows[0].id, content, page_number]
      );

      res.status(201).json({ 
        success: true, 
        message: 'Заметка добавлена',
        note: result.rows[0] 
      });

    } catch (error) {
      console.error('Ошибка добавления заметки:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 6️⃣ ПОЛУЧИТЬ ВСЕ ЗАМЕТКИ К КНИГЕ
  async getNotes(req: Request, res: Response) {
    try {
      const { bookId } = req.params;
      const userId = (req as any).user.id;

      const result = await pool.query(
        `SELECT bn.* 
         FROM book_notes bn
         JOIN user_library ul ON bn.user_library_id = ul.id
         WHERE ul.user_id = $1 AND ul.book_id = $2
         ORDER BY bn.created_at DESC`,
        [userId, bookId]
      );

      res.json(result.rows);
    } catch (error) {
      console.error('Ошибка получения заметок:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 7️⃣ УДАЛИТЬ ЗАМЕТКУ
async deleteNote(req: Request, res: Response) {
  try {
    const noteIdParam = req.params.noteId;
    
    if (!noteIdParam || Array.isArray(noteIdParam)) {
      return res.status(400).json({ error: 'Неверный ID заметки' });
    }
    
    const noteId = parseInt(noteIdParam);
    const userId = (req as any).user.id;

    console.log('[Controller] Удаление заметки:', { noteId, userId });

    // Проверяем, принадлежит ли заметка пользователю
    const noteCheck = await pool.query(
      `SELECT bn.id 
       FROM book_notes bn
       JOIN user_library ul ON bn.user_library_id = ul.id
       WHERE bn.id = $1 AND ul.user_id = $2`,
      [noteId, userId]
    );

    if (noteCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Заметка не найдена' });
    }

    // Удаляем заметку
    await pool.query('DELETE FROM book_notes WHERE id = $1', [noteId]);

    console.log('[Controller] ✅ Заметка удалена');
    res.json({ success: true, message: 'Заметка удалена' });

  } catch (error) {
    console.error('❌ Ошибка удаления заметки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

  // 7️⃣ СОЗДАТЬ КОЛЛЕКЦИЮ
  async createCollection(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { name, description, is_private } = req.body;

      const result = await pool.query(
        `INSERT INTO user_collections (user_id, name, description, is_private) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
        [userId, name, description, is_private ?? true]
      );

      res.status(201).json({ 
        success: true, 
        collection: result.rows[0] 
      });

    } catch (error) {
      if ((error as any).code === '23505') {
        return res.status(400).json({ error: 'Коллекция с таким именем уже существует' });
      }
      console.error('Ошибка создания коллекции:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 8️⃣ ДОБАВИТЬ КНИГУ В КОЛЛЕКЦИЮ
  async addBookToCollection(req: Request, res: Response) {
    try {
      const { collectionId, bookId } = req.body;
      const userId = (req as any).user.id;

      // Получаем user_library_id
      const libRes = await pool.query(
        'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
        [userId, bookId]
      );

      if (libRes.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      await pool.query(
        `INSERT INTO book_collections (user_library_id, collection_id) 
         VALUES ($1, $2) 
         ON CONFLICT DO NOTHING`,
        [libRes.rows[0].id, collectionId]
      );

      res.json({ success: true, message: 'Книга добавлена в коллекцию' });

    } catch (error) {
      console.error('Ошибка добавления в коллекцию:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 9️⃣ ПОЛУЧИТЬ ВСЕ КОЛЛЕКЦИИ ПОЛЬЗОВАТЕЛЯ
  async getCollections(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;

      const result = await pool.query(
        `SELECT 
          uc.*,
          COUNT(bc.id) as books_count
         FROM user_collections uc
         LEFT JOIN book_collections bc ON uc.id = bc.collection_id
         WHERE uc.user_id = $1
         GROUP BY uc.id
         ORDER BY uc.created_at DESC`,
        [userId]
      );

      res.json(result.rows);
    } catch (error) {
      console.error('Ошибка получения коллекций:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 🔟 СТАТИСТИКА ЧТЕНИЯ
  async getReadingStats(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;

      // Общая статистика
      const totalStats = await pool.query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'finished') as books_finished,
           COUNT(*) FILTER (WHERE status = 'reading') as books_reading,
           COUNT(*) as books_total,
           COALESCE(SUM(total_reading_minutes), 0) as total_minutes,
           COALESCE(AVG(user_rating) FILTER (WHERE user_rating IS NOT NULL), 0) as avg_rating
         FROM reading_progress
         WHERE user_id = $1`,
        [userId]
      );

      // Статистика по месяцам (последние 6 месяцев)
      const monthlyStats = await pool.query(
        `SELECT 
           DATE_TRUNC('month', finished_at) as month,
           COUNT(*) as books_read
         FROM reading_progress
         WHERE user_id = $1 
           AND status = 'finished' 
           AND finished_at IS NOT NULL
           AND finished_at > NOW() - INTERVAL '6 months'
         GROUP BY DATE_TRUNC('month', finished_at)
         ORDER BY month DESC`,
        [userId]
      );

      // Любимые авторы
      const topAuthors = await pool.query(
        `SELECT 
           a.full_name as author,
           COUNT(*) as books_read
         FROM reading_progress rp
         JOIN books b ON rp.book_id = b.id
         JOIN authors a ON b.author_id = a.id
         WHERE rp.user_id = $1 AND rp.status = 'finished'
         GROUP BY a.id
         ORDER BY books_read DESC
         LIMIT 5`,
        [userId]
      );

      res.json({
        total: totalStats.rows[0],
        monthly: monthlyStats.rows,
        topAuthors: topAuthors.rows
      });

    } catch (error) {
      console.error('Ошибка получения статистики:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // 1️⃣1️⃣ ИСТОРИЯ ЧТЕНИЯ
  async getReadingHistory(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;

      const result = await pool.query(
        `SELECT 
           b.id, b.title, b.cover_url, b.publish_year,
           a.full_name as author,
           rp.finished_at,
           rp.user_rating,
           rp.total_reading_minutes
         FROM reading_progress rp
         JOIN books b ON rp.book_id = b.id
         JOIN authors a ON b.author_id = a.id
         WHERE rp.user_id = $1 AND rp.status = 'finished'
         ORDER BY rp.finished_at DESC
         LIMIT 50`,
        [userId]
      );

      res.json(result.rows);
    } catch (error) {
      console.error('Ошибка получения истории:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },
 
async getCollectionById(req: Request, res: Response) {
  try {
    const collectionIdParam = req.params.id;
    
    if (!collectionIdParam || Array.isArray(collectionIdParam)) {
      return res.status(400).json({ error: 'Неверный ID коллекции' });
    }
    
    const collectionId = parseInt(collectionIdParam);
    
    if (isNaN(collectionId)) {
      return res.status(400).json({ error: 'ID коллекции должен быть числом' });
    }
    
    const userId = (req as any).user.id;

    console.log('[Controller] Получение коллекции:', { collectionId, userId });

    // Проверяем, принадлежит ли коллекция пользователю
    const collectionCheck = await pool.query(
      'SELECT * FROM user_collections WHERE id = $1 AND user_id = $2',
      [collectionId, userId]
    );

    if (collectionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Коллекция не найдена' });
    }

    // Получаем книги в коллекции (даже если их нет)
    const booksResult = await pool.query(
      `SELECT 
        b.id, 
        b.title, 
        b.cover_url,
        a.full_name as author,
        COALESCE(bc.added_at, CURRENT_TIMESTAMP) as added_at
       FROM book_collections bc
       JOIN user_library ul ON bc.user_library_id = ul.id
       JOIN books b ON ul.book_id = b.id
       JOIN authors a ON b.author_id = a.id
       WHERE bc.collection_id = $1
       ORDER BY bc.added_at DESC`,
      [collectionId]
    );

    console.log('[Controller] Найдено книг в коллекции:', booksResult.rows.length);

    // Возвращаем коллекцию даже если книг нет
    const collection = {
      ...collectionCheck.rows[0],
      books: booksResult.rows || [] // Всегда возвращаем массив, даже пустой
    };

    res.json(collection);

  } catch (error) {
    console.error('❌ Ошибка получения коллекции:', error);
    res.status(500).json({ error: 'Ошибка сервера при получении коллекции' });
  }
},

// 1️⃣3️⃣ УДАЛИТЬ КНИГУ ИЗ КОЛЛЕКЦИИ
async removeBookFromCollection(req: Request, res: Response) {
  try {
    const collectionIdParam = req.params.collectionId;
    const bookIdParam = req.params.bookId;
    
    // ✅ ПРОВЕРКА ТИПА
    if (!collectionIdParam || Array.isArray(collectionIdParam) || 
        !bookIdParam || Array.isArray(bookIdParam)) {
      return res.status(400).json({ error: 'Неверные параметры' });
    }
    
    const collectionId = parseInt(collectionIdParam);
    const bookId = parseInt(bookIdParam);
    
    if (isNaN(collectionId) || isNaN(bookId)) {
      return res.status(400).json({ error: 'ID должны быть числами' });
    }
    
    const userId = (req as any).user.id;

    // Получаем user_library_id
    const libRes = await pool.query(
      'SELECT ul.id FROM user_library ul WHERE ul.user_id = $1 AND ul.book_id = $2',
      [userId, bookId]
    );

    if (libRes.rows.length === 0) {
      return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
    }

    await pool.query(
      'DELETE FROM book_collections WHERE collection_id = $1 AND user_library_id = $2',
      [collectionId, libRes.rows[0].id]
    );

    res.json({ success: true, message: 'Книга удалена из коллекции' });

  } catch (error) {
    console.error('Ошибка удаления из коллекции:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 1️⃣4️⃣ УДАЛИТЬ КОЛЛЕКЦИЮ
async deleteCollection(req: Request, res: Response) {
  try {
    const collectionIdParam = req.params.id;
    
    // ✅ ПРОВЕРКА ТИПА
    if (!collectionIdParam || Array.isArray(collectionIdParam)) {
      return res.status(400).json({ error: 'Неверный ID коллекции' });
    }
    
    const collectionId = parseInt(collectionIdParam);
    
    if (isNaN(collectionId)) {
      return res.status(400).json({ error: 'ID коллекции должен быть числом' });
    }
    
    const userId = (req as any).user.id;

    const result = await pool.query(
      'DELETE FROM user_collections WHERE id = $1 AND user_id = $2 RETURNING id',
      [collectionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Коллекция не найдена' });
    }

    res.json({ success: true, message: 'Коллекция удалена' });

  } catch (error) {
    console.error('Ошибка удаления коллекции:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 1️⃣5️⃣ ОБНОВИТЬ КОЛЛЕКЦИЮ
async updateCollection(req: Request, res: Response) {
  try {
    const collectionIdParam = req.params.id;
    
    // ✅ ПРОВЕРКА ТИПА
    if (!collectionIdParam || Array.isArray(collectionIdParam)) {
      return res.status(400).json({ error: 'Неверный ID коллекции' });
    }
    
    const collectionId = parseInt(collectionIdParam);
    
    if (isNaN(collectionId)) {
      return res.status(400).json({ error: 'ID коллекции должен быть числом' });
    }
    
    const userId = (req as any).user.id;
    const { name, description, is_private } = req.body;

    const result = await pool.query(
      `UPDATE user_collections 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           is_private = COALESCE($3, is_private),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [name, description, is_private, collectionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Коллекция не найдена' });
    }

    res.json({ 
      success: true, 
      message: 'Коллекция обновлена',
      collection: result.rows[0]
    });

  } catch (error) {
    if ((error as any).code === '23505') {
      return res.status(400).json({ error: 'Коллекция с таким именем уже существует' });
    }
    console.error('Ошибка обновления коллекции:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},
// ПОЛУЧИТЬ КНИГИ, ДОСТУПНЫЕ ДЛЯ ДОБАВЛЕНИЯ В КОЛЛЕКЦИЮ
async getAvailableBooksForCollection(req: Request, res: Response) {
  try {
    const collectionIdParam = req.params.collectionId;
    
    if (!collectionIdParam || Array.isArray(collectionIdParam)) {
      return res.status(400).json({ error: 'Неверный ID коллекции' });
    }
    
    const collectionId = parseInt(collectionIdParam);
    
    if (isNaN(collectionId)) {
      return res.status(400).json({ error: 'ID коллекции должен быть числом' });
    }
    
    const userId = (req as any).user.id;

    // Получаем все книги пользователя, которых еще нет в этой коллекции
    const result = await pool.query(
      `SELECT 
        b.id, b.title, b.cover_url,
        a.full_name as author
       FROM user_library ul
       JOIN books b ON ul.book_id = b.id
       JOIN authors a ON b.author_id = a.id
       WHERE ul.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM book_collections bc
         JOIN user_library ul2 ON bc.user_library_id = ul2.id
         WHERE ul2.book_id = b.id 
         AND bc.collection_id = $2
       )
       ORDER BY b.title`,
      [userId, collectionId]
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Ошибка получения доступных книг:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// Добавить книгу вручную
// Добавить книгу вручную
async addManualBook(req: Request, res: Response) {
  try {
    const userId = (req as any).user.id;
    const { isbn, title, authors, pages, publisher, publish_year, description, cover_url, language, genre } = req.body;

    console.log('\n📚 [Controller] ========== ДОБАВЛЕНИЕ КНИГИ ВРУЧНУЮ ==========');
    console.log('📚 [Controller] User ID:', userId);
    console.log('📚 [Controller] ISBN:', isbn);
    console.log('📚 [Controller] Title:', title);

    // Проверяем обязательные поля
    if (!title) {
      return res.status(400).json({ error: 'Название книги обязательно' });
    }

    if (!isbn) {
      return res.status(400).json({ error: 'ISBN обязателен' });
    }

    const cleanIsbn = isbn.replace(/[-\s]/g, '');

    // 1️⃣ Проверяем, есть ли уже эта книга у пользователя
    const userBookCheck = await pool.query(
      `SELECT ul.id, b.id as book_id, b.title, b.isbn 
       FROM user_library ul
       JOIN books b ON ul.book_id = b.id
       WHERE ul.user_id = $1 AND b.isbn = $2`,
      [userId, cleanIsbn]
    );

    if (userBookCheck.rows.length > 0) {
      console.log('📚 [Controller] ⚠️ Книга уже есть у пользователя');
      return res.status(200).json({
        success: true,
        message: 'Книга уже в вашей библиотеке',
        bookId: userBookCheck.rows[0].book_id,
        alreadyExists: true
      });
    }

    // 2️⃣ Проверяем, есть ли книга в общей таблице books
    let bookResult = await pool.query(
      'SELECT * FROM books WHERE isbn = $1',
      [cleanIsbn]
    );

    let bookId;

    // 3️⃣ Если книги нет в БД - добавляем
    if (bookResult.rows.length === 0) {
      console.log('📚 [Controller] Книга не найдена в БД, добавляем...');
      
      // Проверяем/добавляем авторов
      let authorId = null;
      if (authors && authors.length > 0 && authors[0].trim() !== '') {
        const authorName = authors[0].trim(); // Берем первого автора
        
        let authorRes = await pool.query(
          'SELECT id FROM authors WHERE full_name = $1',
          [authorName]
        );

        if (authorRes.rows.length === 0) {
          const newAuthor = await pool.query(
            'INSERT INTO authors (full_name) VALUES ($1) RETURNING id',
            [authorName]
          );
          authorId = newAuthor.rows[0].id;
          console.log('📚 [Controller] Добавлен новый автор:', authorName);
        } else {
          authorId = authorRes.rows[0].id;
        }
      }

      // Добавляем книгу
      const newBook = await pool.query(
        `INSERT INTO books 
         (title, isbn, author_id, description, cover_url, pages, publisher, language, publish_year, genre) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
         RETURNING id`,
        [
          title,
          cleanIsbn,
          authorId,
          description || '',
          cover_url || '',
          pages || null,
          publisher || '',
          language || 'ru',
          publish_year || null,
          genre || ''
        ]
      );
      
      bookId = newBook.rows[0].id;
      console.log('📚 [Controller] Книга добавлена в БД, ID:', bookId);
    } else {
      // Книга уже есть в БД
      bookId = bookResult.rows[0].id;
      console.log('📚 [Controller] Книга уже есть в БД, ID:', bookId);
    }

    // 4️⃣ Добавляем в библиотеку пользователя
    const libraryResult = await pool.query(
      `INSERT INTO user_library (user_id, book_id, added_via, added_at) 
       VALUES ($1, $2, 'manual', CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, book_id) DO NOTHING
       RETURNING id`,
      [userId, bookId]
    );

    // 5️⃣ Если запись добавилась (не было конфликта)
    if (libraryResult.rows.length > 0) {
      // Создаем запись прогресса
      await pool.query(
        `INSERT INTO reading_progress (user_id, book_id, status, created_at) 
         VALUES ($1, $2, 'want_to_read', CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, book_id) DO NOTHING`,
        [userId, bookId]
      );

      console.log('📚 [Controller] ✅ Книга добавлена в библиотеку пользователя');
      
      res.status(201).json({ 
        success: true, 
        message: 'Книга добавлена в библиотеку',
        bookId,
        alreadyExists: false
      });
    } else {
      // Книга уже была в библиотеке
      console.log('📚 [Controller] ⚠️ Книга уже была в библиотеке пользователя');
      
      res.status(200).json({ 
        success: true, 
        message: 'Книга уже в вашей библиотеке',
        bookId,
        alreadyExists: true
      });
    }

  } catch (error) {
    console.error('❌ Ошибка добавления книги вручную:', error);
    
    // Обработка специфических ошибок БД
    if ((error as any).code === '23505') {
      return res.status(400).json({ 
        error: 'Книга с таким ISBN уже существует в системе',
        details: (error as any).detail
      });
    }
    
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// Добавить/убрать из избранного

// В bookController.ts

async toggleFavorite(req: Request, res: Response) {
  try {
    const bookIdParam = req.params.bookId;
    
    if (!bookIdParam || Array.isArray(bookIdParam)) {
      return res.status(400).json({ error: 'Неверный ID книги' });
    }
    
    const bookId = parseInt(bookIdParam);
    const userId = (req as any).user.id;
    const { isFavorite } = req.body;

    console.log('[Controller] Переключение избранного:', { userId, bookId, isFavorite });

    // 1️⃣ Обновляем is_favorite в user_library
    const result = await pool.query(
      `UPDATE user_library 
       SET is_favorite = $1 
       WHERE user_id = $2 AND book_id = $3
       RETURNING id, is_favorite`,
      [isFavorite, userId, bookId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
    }

    // 2️⃣ Находим или создаем коллекцию "Избранные"
    let favoritesCollection = await pool.query(
      'SELECT id FROM user_collections WHERE user_id = $1 AND name = $2',
      [userId, 'Избранные']
    );

    let collectionId;
    if (favoritesCollection.rows.length === 0) {
      // Создаем коллекцию "Избранные" если её нет
      const newCollection = await pool.query(
        `INSERT INTO user_collections (user_id, name, description, is_private) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id`,
        [userId, 'Избранные', 'Книги, которые вы отметили как избранные', true]
      );
      collectionId = newCollection.rows[0].id;
    } else {
      collectionId = favoritesCollection.rows[0].id;
    }

    // 3️⃣ Получаем user_library_id
    const libRes = await pool.query(
      'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
      [userId, bookId]
    );

    // 4️⃣ Добавляем или удаляем книгу из коллекции "Избранные"
    if (libRes.rows.length > 0) {
      if (isFavorite) {
        // Добавляем в коллекцию "Избранные"
        await pool.query(
          `INSERT INTO book_collections (user_library_id, collection_id) 
           VALUES ($1, $2) 
           ON CONFLICT DO NOTHING`,
          [libRes.rows[0].id, collectionId]
        );
        console.log('[Controller] Книга добавлена в коллекцию Избранные');
      } else {
        // Удаляем из коллекции "Избранные"
        await pool.query(
          'DELETE FROM book_collections WHERE user_library_id = $1 AND collection_id = $2',
          [libRes.rows[0].id, collectionId]
        );
        console.log('[Controller] Книга удалена из коллекции Избранные');
      }
    }

    res.json({ 
      success: true, 
      message: isFavorite ? 'Книга добавлена в избранное' : 'Книга убрана из избранного',
      is_favorite: result.rows[0].is_favorite
    });

  } catch (error) {
    console.error('Ошибка обновления избранного:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

async deleteBook(req: Request, res: Response) {
  try {
    const bookIdParam = req.params.bookId;
    
    // ✅ ПРОВЕРКА ТИПА
    if (!bookIdParam || Array.isArray(bookIdParam)) {
      return res.status(400).json({ error: 'Неверный ID книги' });
    }
    
    const bookId = parseInt(bookIdParam);
    
    if (isNaN(bookId)) {
      return res.status(400).json({ error: 'ID книги должен быть числом' });
    }
    
    const userId = (req as any).user.id;

    // Удаляем из библиотеки пользователя
    const result = await pool.query(
      'DELETE FROM user_library WHERE user_id = $1 AND book_id = $2 RETURNING id',
      [userId, bookId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
    }

    // Прогресс и заметки удалятся каскадно благодаря внешним ключам

    res.json({ success: true, message: 'Книга удалена из библиотеки' });

  } catch (error) {
    console.error('Ошибка удаления книги:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},



// В bookController.ts добавьте эти методы:

// ============= ЧИТАТЕЛЬСКИЕ МАРШРУТЫ =============

// 1️⃣ ПОЛУЧИТЬ ВСЕ МАРШРУТЫ ПОЛЬЗОВАТЕЛЯ
async getRoutes(req: Request, res: Response) {
  try {
    const userId = (req as any).user.id;

    console.log('[Controller] Получение маршрутов для пользователя:', userId);

    // Получаем маршруты с вычислением прогресса
    const result = await pool.query(
      `SELECT 
        r.id, 
        r.name, 
        r.description, 
        r.status,
        r.planned_start_date, 
        r.planned_end_date,
        r.created_at, 
        r.updated_at,
        (
          SELECT COUNT(*) 
          FROM route_books 
          WHERE route_id = r.id
        ) as books_count,
        (
          SELECT COALESCE(
            AVG(
              CASE 
                WHEN rp.status = 'finished' THEN 100
                WHEN b.pages > 0 THEN (rp.current_page * 100.0 / b.pages)
                ELSE 0
              END
            ), 0
          )
          FROM route_books rb
          JOIN user_library ul ON rb.user_library_id = ul.id
          JOIN books b ON ul.book_id = b.id
          LEFT JOIN reading_progress rp ON rp.user_id = ul.user_id AND rp.book_id = ul.book_id
          WHERE rb.route_id = r.id
        ) as progress
       FROM reading_routes r
       WHERE r.user_id = $1
       ORDER BY 
         CASE r.status
           WHEN 'active' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'completed' THEN 3
         END,
         r.created_at DESC`,
      [userId]
    );

    console.log('[Controller] Найдено маршрутов:', result.rows.length);
    res.json(result.rows);

  } catch (error) {
    console.error('❌ Ошибка получения маршрутов:', error);
    res.status(500).json({ error: 'Ошибка сервера при получении маршрутов' });
  }
},

async getRouteById(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;

    // Получаем маршрут
    const routeResult = await pool.query(
      `SELECT 
        id, name, description, status,
        planned_start_date, planned_end_date,
        created_at, updated_at
       FROM reading_routes 
       WHERE id = $1 AND user_id = $2`,
      [routeId, userId]
    );

    if (routeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Маршрут не найден' });
    }

    // Получаем книги в маршруте - используем правильные названия полей
    const booksResult = await pool.query(
      `SELECT 
        rb.id,
        b.id as book_id,
        b.title,
        b.cover_url,
        b.pages as total_pages,
        a.full_name as author,
        rb.order_index,
        rb.planned_start_date,
        rb.planned_end_date,
        COALESCE(rp.status, 'want_to_read') as status,
        COALESCE(rp.current_page, 0) as current_page
       FROM route_books rb
       JOIN user_library ul ON rb.user_library_id = ul.id
       JOIN books b ON ul.book_id = b.id
       JOIN authors a ON b.author_id = a.id
       LEFT JOIN reading_progress rp ON rp.user_id = ul.user_id AND rp.book_id = ul.book_id
       WHERE rb.route_id = $1
       ORDER BY rb.order_index`,
      [routeId]
    );

    res.json({
      route: routeResult.rows[0],
      books: booksResult.rows
    });

  } catch (error) {
    console.error('❌ Ошибка получения маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},
 
async createRoute(req: Request, res: Response) {
  try {
    const userId = (req as any).user.id;
    const { name, description, planned_start_date, planned_end_date, books } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Название маршрута обязательно' });
    }

    await pool.query('BEGIN');

    const routeResult = await pool.query(
      `INSERT INTO reading_routes 
       (user_id, name, description, planned_start_date, planned_end_date, status) 
       VALUES ($1, $2, $3, $4, $5, 'draft') 
       RETURNING id, name, description, status, planned_start_date, planned_end_date, created_at, updated_at`,
      [userId, name, description, planned_start_date, planned_end_date]
    );

    const routeId = routeResult.rows[0].id;
    const addedBooks = [];

    if (books && books.length > 0) {
      for (const book of books) {
        const libRes = await pool.query(
          'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
          [userId, book.bookId]
        );

        if (libRes.rows.length > 0) {
          await pool.query(
            `INSERT INTO route_books (route_id, user_library_id, order_index, created_at) 
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [routeId, libRes.rows[0].id, book.order_index]
          );
          
          addedBooks.push({
            bookId: book.bookId,
            order_index: book.order_index
          });
        }
      }
    }

    await pool.query('COMMIT');

    // Возвращаем полную информацию о маршруте с книгами
    const result = {
      ...routeResult.rows[0],
      books: addedBooks
    };

    res.status(201).json(result);

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Ошибка создания маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

async updateRouteBooks(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;
    const { books } = req.body;

    console.log('[Controller] Обновление книг в маршруте:', { routeId, books });

    // Проверяем, что маршрут принадлежит пользователю
    const routeCheck = await pool.query(
      'SELECT status FROM reading_routes WHERE id = $1 AND user_id = $2',
      [routeId, userId]
    );

    if (routeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Маршрут не найден' });
    }

    if (routeCheck.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'Нельзя изменять завершенный маршрут' });
    }

    await pool.query('BEGIN');

    // Удаляем все текущие книги из маршрута
    await pool.query('DELETE FROM route_books WHERE route_id = $1', [routeId]);

    // Добавляем новые книги
    const addedBooks = [];
    if (books && books.length > 0) {
      for (const book of books) {
        const libRes = await pool.query(
          'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
          [userId, book.bookId]
        );

        if (libRes.rows.length > 0) {
          await pool.query(
            `INSERT INTO route_books (route_id, user_library_id, order_index, created_at) 
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [routeId, libRes.rows[0].id, book.order_index]
          );
          
          addedBooks.push({
            bookId: book.bookId,
            order_index: book.order_index
          });
        }
      }
    }

    await pool.query('COMMIT');

    res.json({ 
      success: true, 
      message: 'Книги в маршруте обновлены',
      books: addedBooks 
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Ошибка обновления книг в маршруте:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 4️⃣ ОБНОВИТЬ МАРШРУТ
async updateRoute(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;
    const { name, description, planned_start_date, planned_end_date, status, books } = req.body;

    // Проверяем, что маршрут принадлежит пользователю
    const checkRes = await pool.query(
      'SELECT status FROM reading_routes WHERE id = $1 AND user_id = $2',
      [routeId, userId]
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'Маршрут не найден' });
    }

    if (checkRes.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'Нельзя редактировать завершенный маршрут' });
    }

    await pool.query('BEGIN');

    // Обновляем основную информацию маршрута
    const routeResult = await pool.query(
      `UPDATE reading_routes 
       SET 
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         planned_start_date = COALESCE($3, planned_start_date),
         planned_end_date = COALESCE($4, planned_end_date),
         status = COALESCE($5, status),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND user_id = $7
       RETURNING id, name, description, status, planned_start_date, planned_end_date, created_at, updated_at`,
      [name, description, planned_start_date, planned_end_date, status, routeId, userId]
    );

    // Если переданы книги, обновляем их
    if (books) {
      // Удаляем старые книги
      await pool.query('DELETE FROM route_books WHERE route_id = $1', [routeId]);

      // Добавляем новые книги
      if (books.length > 0) {
        for (const book of books) {
          const libRes = await pool.query(
            'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
            [userId, book.bookId]
          );

          if (libRes.rows.length > 0) {
            await pool.query(
              `INSERT INTO route_books (route_id, user_library_id, order_index, created_at) 
               VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
              [routeId, libRes.rows[0].id, book.order_index]
            );
          }
        }
      }
    }

    await pool.query('COMMIT');

    // Получаем обновленные книги для ответа
    const booksResult = await pool.query(
      `SELECT 
        rb.id,
        b.id as book_id,
        b.title,
        b.cover_url,
        b.pages as total_pages,
        a.full_name as author,
        rb.order_index
       FROM route_books rb
       JOIN user_library ul ON rb.user_library_id = ul.id
       JOIN books b ON ul.book_id = b.id
       JOIN authors a ON b.author_id = a.id
       WHERE rb.route_id = $1
       ORDER BY rb.order_index`,
      [routeId]
    );

    res.json({
      ...routeResult.rows[0],
      books: booksResult.rows
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Ошибка обновления маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 5️⃣ УДАЛИТЬ МАРШРУТ
async deleteRoute(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;

    const result = await pool.query(
      'DELETE FROM reading_routes WHERE id = $1 AND user_id = $2 RETURNING id',
      [routeId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Маршрут не найден' });
    }

    res.json({ success: true, message: 'Маршрут удален' });

  } catch (error) {
    console.error('Ошибка удаления маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 6️⃣ ДОБАВИТЬ КНИГУ В МАРШРУТ
// В bookController.ts - метод addBookToRoute

async addBookToRoute(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;
    const { bookId, order_index } = req.body;

    console.log('[Controller] Добавление книги в маршрут:', { routeId, bookId, order_index });

    // Проверяем, что маршрут принадлежит пользователю и не завершен
    const routeCheck = await pool.query(
      'SELECT status FROM reading_routes WHERE id = $1 AND user_id = $2',
      [routeId, userId]
    );

    if (routeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Маршрут не найден' });
    }

    if (routeCheck.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'Нельзя добавлять книги в завершенный маршрут' });
    }

    // Получаем user_library_id
    const libRes = await pool.query(
      'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
      [userId, bookId]
    );

    if (libRes.rows.length === 0) {
      return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
    }

    // Проверяем, нет ли уже этой книги в маршруте
    const bookCheck = await pool.query(
      'SELECT id FROM route_books WHERE route_id = $1 AND user_library_id = $2',
      [routeId, libRes.rows[0].id]
    );

    if (bookCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Книга уже есть в маршруте' });
    }

    // Добавляем книгу в маршрут
    const result = await pool.query(
      `INSERT INTO route_books (route_id, user_library_id, order_index, created_at) 
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
       RETURNING id`,
      [routeId, libRes.rows[0].id, order_index]
    );

    console.log('[Controller] Книга добавлена в маршрут, ID:', result.rows[0].id);
    res.status(201).json({ 
      success: true, 
      message: 'Книга добавлена в маршрут',
      id: result.rows[0].id
    });

  } catch (error) {
    console.error('❌ Ошибка добавления книги в маршрут:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 7️⃣ УДАЛИТЬ КНИГУ ИЗ МАРШРУТА
// В bookController.ts - метод removeBookFromRoute

async removeBookFromRoute(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    const bookIdParam = req.params.bookId;
    
    if (!routeIdParam || Array.isArray(routeIdParam) || !bookIdParam || Array.isArray(bookIdParam)) {
      return res.status(400).json({ error: 'Неверные параметры' });
    }
    
    const routeId = parseInt(routeIdParam);
    const bookId = parseInt(bookIdParam);
    const userId = (req as any).user.id;

    console.log('[Controller] Удаление книги из маршрута:', { routeId, bookId });

    // Получаем user_library_id
    const libRes = await pool.query(
      'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
      [userId, bookId]
    );

    if (libRes.rows.length === 0) {
      return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
    }

    // Удаляем книгу из маршрута
    const result = await pool.query(
      'DELETE FROM route_books WHERE route_id = $1 AND user_library_id = $2 RETURNING id',
      [routeId, libRes.rows[0].id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Книга не найдена в маршруте' });
    }

    console.log('[Controller] Книга удалена из маршрута');
    res.json({ success: true, message: 'Книга удалена из маршрута' });

  } catch (error) {
    console.error('❌ Ошибка удаления книги из маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

// 8️⃣ ОБНОВИТЬ ПОРЯДОК КНИГ
// В bookController.ts - метод updateBookOrder

async updateBookOrder(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;
    const { books } = req.body;

    console.log('[Controller] Обновление порядка книг:', { routeId, books });

    // Проверяем, что маршрут принадлежит пользователю
    const routeCheck = await pool.query(
      'SELECT status FROM reading_routes WHERE id = $1 AND user_id = $2',
      [routeId, userId]
    );

    if (routeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Маршрут не найден' });
    }

    // Начинаем транзакцию
    await pool.query('BEGIN');

    for (const book of books) {
      // Получаем user_library_id для каждой книги
      const libRes = await pool.query(
        'SELECT id FROM user_library WHERE user_id = $1 AND book_id = $2',
        [userId, book.bookId]
      );

      if (libRes.rows.length > 0) {
        await pool.query(
          'UPDATE route_books SET order_index = $1 WHERE route_id = $2 AND user_library_id = $3',
          [book.order_index, routeId, libRes.rows[0].id]
        );
      }
    }

    await pool.query('COMMIT');

    res.json({ success: true, message: 'Порядок книг обновлен' });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Ошибка обновления порядка книг:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

async activateRoute(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;

    // Просто меняем статус, без started_at
    const result = await pool.query(
      `UPDATE reading_routes 
       SET status = 'active' 
       WHERE id = $1 AND user_id = $2 AND status = 'draft'
       RETURNING id`,
      [routeId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Маршрут не найден или уже активен' });
    }

    res.json({ success: true, message: 'Маршрут активирован' });

  } catch (error) {
    console.error('❌ Ошибка активации маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},

async completeRoute(req: Request, res: Response) {
  try {
    const routeIdParam = req.params.id;
    
    if (!routeIdParam || Array.isArray(routeIdParam)) {
      return res.status(400).json({ error: 'Неверный ID маршрута' });
    }
    
    const routeId = parseInt(routeIdParam);
    const userId = (req as any).user.id;

    // Просто меняем статус, без completed_at
    const result = await pool.query(
      `UPDATE reading_routes 
       SET status = 'completed' 
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       RETURNING id`,
      [routeId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Маршрут не найден или не активен' });
    }

    res.json({ success: true, message: 'Маршрут завершен! Поздравляем!' });

  } catch (error) {
    console.error('❌ Ошибка завершения маршрута:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
},
};
