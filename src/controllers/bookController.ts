import { Request, Response } from 'express';
import fs from 'fs';
import axios from 'axios';
import pool from '../config/database';
import { enhancedBookApiService } from '../services/enhancedBookApiService';
import { recommendationService } from '../services/recommendationService';
import { searchBooks } from '../services/bookSearchService';

async function findOrCreateAuthor(rawName: string): Promise<number> {
  const normalized = rawName.trim().replace(/\s+/g, ' ') || 'Неизвестный автор';
  const sel = await pool.query('SELECT id FROM authors WHERE LOWER(full_name) = LOWER($1)', [normalized]);
  if (sel.rows.length > 0) return sel.rows[0].id;

  const ins = await pool.query(
    `INSERT INTO authors (full_name) VALUES ($1) ON CONFLICT (full_name) DO NOTHING RETURNING id`,
    [normalized]
  );
  if (ins.rows.length > 0) return ins.rows[0].id;

  const retry = await pool.query('SELECT id FROM authors WHERE LOWER(full_name) = LOWER($1)', [normalized]);
  return retry.rows[0].id;
}

async function findOrCreateWork(title: string, authorName: string, createdByUserId?: number, genre?: string | null): Promise<number> {
  const normalizedAuthor = authorName.trim().replace(/\s+/g, ' ') || 'Неизвестный автор';
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');

  const authorId = await findOrCreateAuthor(normalizedAuthor);

  const workResult = await pool.query(
    'SELECT id FROM works WHERE LOWER(title) = LOWER($1) AND author_id = $2',
    [normalizedTitle, authorId]
  );

  let workId;
  if (workResult.rows.length === 0) {
    const newWork = await pool.query(
      `INSERT INTO works (title, author_id, created_by_user_id, genre)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [normalizedTitle, authorId, createdByUserId ?? null, genre ?? null]
    );
    workId = newWork.rows[0].id;
  } else {
    workId = workResult.rows[0].id;
    if (genre) {
      await pool.query(
        'UPDATE works SET genre = $1 WHERE id = $2 AND (genre IS NULL OR genre = \'\')',
        [genre, workId]
      );
    }
  }

  return workId;
}

async function upsertWorkAuthors(workId: number, authorsList: string[]): Promise<void> {
  const clean = authorsList.map(a => a.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (clean.length === 0) return;

  await pool.query('DELETE FROM work_authors WHERE work_id = $1', [workId]);

  for (let i = 0; i < clean.length; i++) {
    const name = clean[i] as string;
    const authorId = await findOrCreateAuthor(name);
    await pool.query(
      `INSERT INTO work_authors (work_id, author_id, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (work_id, author_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [workId, authorId, i]
    );
  }

  const firstRes = await pool.query(
    `SELECT id FROM authors WHERE LOWER(full_name) = LOWER($1) LIMIT 1`,
    [clean[0]]
  );
  if (firstRes.rows.length > 0) {
    await pool.query('UPDATE works SET author_id = $1 WHERE id = $2', [firstRes.rows[0].id, workId]);
  }
}

async function findOrCreateEdition(workId: number, bookData: any, isbn: string): Promise<number> {
  let editionResult = await pool.query(
    'SELECT id, pages, publisher, publish_year FROM editions WHERE isbn = $1',
    [isbn]
  );

  if (editionResult.rows.length > 0) {
    const ed = editionResult.rows[0];
    const needsUpdate =
      (!ed.pages && bookData.pages) ||
      (!ed.publisher && bookData.publisher) ||
      (!ed.publish_year && bookData.publish_year);
    if (needsUpdate) {
      await pool.query(
        `UPDATE editions SET
           pages        = COALESCE(NULLIF(pages, 0),        $1::int),
           publisher    = COALESCE(NULLIF(publisher, ''),   $2::text),
           publish_year = COALESCE(NULLIF(publish_year, 0), $3::int),
           cover_url    = COALESCE(cover_url,               $4::text)
         WHERE id = $5`,
        [bookData.pages || null, bookData.publisher || null, bookData.publish_year || null, bookData.coverUrl || null, ed.id]
      );
    }
    return ed.id;
  }

  const newEdition = await pool.query(
    `INSERT INTO editions (work_id, isbn, publisher, publish_year, pages, cover_url, language, series)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      workId,
      isbn,
      bookData.publisher || null,
      bookData.publish_year || null,
      bookData.pages || null,
      bookData.coverUrl || null,
      bookData.language || 'ru',
      bookData.series || null
    ]
  );

  console.log(`Создано новое издание, ID: ${newEdition.rows[0].id}`);
  return newEdition.rows[0].id;
}

export const bookController = {
  async addBookByISBN(req: Request, res: Response) {
    try {
      const { isbn } = req.body;
      const userId = (req as any).user.id;
  
      console.log('\n[Controller] ========== ДОБАВЛЕНИЕ КНИГИ ==========');
      console.log('[Controller] User ID:', userId);
      console.log('[Controller] ISBN:', isbn);
  
      if (!isbn) {
        return res.status(400).json({ error: 'ISBN не указан' });
      }
  
      const cleanIsbn = isbn.replace(/[-\s]/g, '');
  
      const userEditionCheck = await pool.query(
        `SELECT ul.id, e.id as edition_id, e.isbn, w.title
         FROM user_library ul
         JOIN editions e ON ul.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         WHERE ul.user_id = $1 AND e.isbn = $2`,
        [userId, cleanIsbn]
      );
  
      if (userEditionCheck.rows.length > 0) {
        console.log('[Controller] Книга уже есть у пользователя');
        return res.status(200).json({
          success: true,
          message: 'Книга уже в вашей библиотеке',
          editionId: userEditionCheck.rows[0].edition_id,
          workId: userEditionCheck.rows[0].work_id,
          alreadyExists: true
        });
      }
  
      let editionResult = await pool.query(
        'SELECT * FROM editions WHERE isbn = $1',
        [cleanIsbn]
      );
  
      let editionId;
      let workId;
      let workTitle = '';
  
      if (editionResult.rows.length === 0) {
        console.log('[Controller] Издание не найдено в БД, ищем в API...');
        
        const bookData = await enhancedBookApiService.findBookByISBN(cleanIsbn);
  
        if (!bookData) {
          return res.status(404).json({ 
            error: 'Книга не найдена ни в одном из внешних API' 
          });
        }
  
        workTitle = bookData.title;
        const authorName = bookData.authors?.[0] || 'Неизвестный автор';
        const primaryGenre = bookData.genres?.[0] ?? null;

        workId = await findOrCreateWork(workTitle, authorName, undefined, primaryGenre);

        if (bookData.authors && bookData.authors.length > 0) {
          await upsertWorkAuthors(workId, bookData.authors);
        }

        editionId = await findOrCreateEdition(workId, bookData, cleanIsbn);
        
      } else {
        editionId = editionResult.rows[0].id;
        const workInfo = await pool.query(
          'SELECT w.title FROM works w JOIN editions e ON e.work_id = w.id WHERE e.id = $1',
          [editionId]
        );
        workTitle = workInfo.rows[0]?.title || '';
        console.log('[Controller] Издание уже есть в БД, ID:', editionId);
      }

      const libraryResult = await pool.query(
        `INSERT INTO user_library (user_id, edition_id, added_via, added_at)
         VALUES ($1, $2, 'isbn_scan', CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, editionId]
      );

      if (libraryResult.rows.length > 0) {
        await pool.query(
          `INSERT INTO reading_progress (user_id, edition_id, status, created_at)
           VALUES ($1, $2, 'want_to_read', CURRENT_TIMESTAMP)
           ON CONFLICT DO NOTHING`,
          [userId, editionId]
        );

        console.log('[Controller] Книга добавлена в библиотеку пользователя');
        res.status(201).json({
          success: true,
          message: 'Книга добавлена в библиотеку',
          libraryId: libraryResult.rows[0].id,
          editionId: editionId,
          workId: workId,
          title: workTitle,
          alreadyExists: false
        });
      } else {
        console.log('[Controller] Книга уже была в библиотеке пользователя');
        const existingLib = await pool.query(
          'SELECT id FROM user_library WHERE user_id = $1 AND edition_id = $2',
          [userId, editionId]
        );
        res.status(200).json({
          success: true,
          message: 'Книга уже в вашей библиотеке',
          libraryId: existingLib.rows[0]?.id,
          editionId: editionId,
          title: workTitle,
          alreadyExists: true
        });
      }

    } catch (error) {
      console.error('Ошибка добавления книги:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async searchBookByISBNAll(req: Request, res: Response) {
    try {
      const isbnRaw: string = String(req.params.isbn ?? '');
      const cleanIsbn = isbnRaw.replace(/[-\s]/g, '');
      if (!cleanIsbn) return res.status(400).json({ error: 'ISBN не указан' });

      const results = await enhancedBookApiService.findAllByISBN(cleanIsbn);
      res.json({ found: results.length > 0, results });
    } catch (error) {
      console.error('[searchBookByISBNAll] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async searchBooksByQuery(req: Request, res: Response) {
    const q = (req.query.q as string || '').trim();
    if (!q) return res.status(400).json({ error: 'Параметр q обязателен' });
    try {
      const results = await searchBooks(q);
      res.json({ results });
    } catch (err) {
      console.error('[searchBooksByQuery] Ошибка:', err);
      res.status(500).json({ error: 'Ошибка поиска' });
    }
  },

  async searchBookByISBN(req: Request, res: Response) {
    console.log('\n[Controller] ========== ПОИСК КНИГИ ==========');
    
    try {
      const isbnParam = req.params.isbn;
      const isbn = Array.isArray(isbnParam) ? isbnParam[0] : isbnParam;
      
      if (!isbn || isbn.trim() === '') {
        return res.status(400).json({ error: 'ISBN не указан' });
      }

      const cleanIsbn = isbn.replace(/[-\s]/g, '');
      
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
      console.error('[Controller] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async getUserBooks(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;

      console.log('[Controller] Получение книг пользователя:', userId);

      const result = await pool.query(
        `SELECT
          ul.id as id,
          CASE WHEN ul.edition_id IS NOT NULL THEN 'edition' ELSE 'work' END as entry_type,
          e.id as edition_id,
          e.isbn,
          e.publisher,
          e.publish_year,
          e.pages,
          COALESCE(ul.custom_cover_url, e.cover_url) as cover_url,
          e.language,
          e.series,
          w.id as work_id,
          w.title,
          COALESCE(ul.custom_description, w.description) as work_description,
          COALESCE(ul.custom_genre, w.genre) as genre,
          COALESCE((SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order) FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id WHERE wa.work_id = w.id), a.full_name) as author,
          rp.status,
          rp.current_page,
          rp.user_rating,
          rp.user_review,
          rp.started_at,
          rp.finished_at,
          ul.added_at,
          ul.added_via,
          ul.is_favorite,
          ul.custom_cover_url,
          COALESCE(ul.format, 'physical') AS format
         FROM user_library ul
         LEFT JOIN editions e ON ul.edition_id = e.id
         JOIN works w ON COALESCE(e.work_id, ul.work_id) = w.id
         JOIN authors a ON w.author_id = a.id
         LEFT JOIN reading_progress rp ON rp.user_id = ul.user_id
           AND (
             (ul.edition_id IS NOT NULL AND rp.edition_id = ul.edition_id)
             OR (ul.edition_id IS NULL AND ul.work_id IS NOT NULL AND rp.work_id = ul.work_id)
           )
         WHERE ul.user_id = $1
         ORDER BY ul.added_at DESC`,
        [userId]
      );
      
      console.log('[Controller] Найдено книг:', result.rows.length);
      res.json(result.rows);
      
    } catch (error) {
      console.error('Ошибка получения книг:', error);
      res.status(500).json({ error: 'Ошибка сервера при получении книг' });
    }
  },

  async updateProgress(req: Request, res: Response) {
    try {
      const { libraryId } = req.params;
      const userId = (req as any).user.id;
      const { current_page, status, user_rating, user_review,
              started_at: reqStartedAt, finished_at: reqFinishedAt } = req.body;

      if (current_page !== undefined && current_page !== null) {
        const p = Number(current_page);
        if (!Number.isInteger(p) || p < 0) {
          return res.status(400).json({ error: 'current_page должен быть неотрицательным целым числом' });
        }
        if (p > 10000) {
          return res.status(400).json({ error: 'Количество страниц не может превышать 10 000' });
        }
      }

      const libEntry = await pool.query(
        'SELECT edition_id, work_id FROM user_library WHERE id = $1 AND user_id = $2',
        [libraryId, userId]
      );
      if (libEntry.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }
      const { edition_id, work_id } = libEntry.rows[0];
      const progressKey = edition_id
        ? { col: 'edition_id', val: edition_id }
        : { col: 'work_id',    val: work_id };

      const currentProgress = await pool.query(
        `SELECT status, user_rating, started_at, finished_at FROM reading_progress WHERE user_id = $1 AND ${progressKey.col} = $2`,
        [userId, progressKey.val]
      );

      const currentStatus    = currentProgress.rows[0]?.status;
      const currentRating    = currentProgress.rows[0]?.user_rating;
      const currentStartedAt = currentProgress.rows[0]?.started_at;
      const currentFinishedAt= currentProgress.rows[0]?.finished_at;

      const VALID_STATUSES = ['want_to_read', 'reading', 'finished', 'paused', 'abandoned'];
      const newStatus = (status && VALID_STATUSES.includes(status))
        ? status
        : (currentStatus || 'want_to_read');

      let finalRating = user_rating;
      if (newStatus !== 'finished') {
        finalRating = null;
      } else if (user_rating === undefined || user_rating === null) {
        finalRating = currentRating || null;
      }
      if (finalRating !== null && (finalRating < 1 || finalRating > 5)) {
        finalRating = null;
      }

      let newStartedAt: Date | null = currentStartedAt || null;
      if (reqStartedAt !== undefined) {
        newStartedAt = reqStartedAt ? new Date(reqStartedAt) : null;
      } else if (newStatus === 'reading' && !currentStartedAt) {
        newStartedAt = new Date();
      }

      let newFinishedAt: Date | null;
      if (reqFinishedAt !== undefined) {
        newFinishedAt = reqFinishedAt ? new Date(reqFinishedAt) : null;
      } else if (newStatus === 'finished') {
        newFinishedAt = currentFinishedAt || new Date();
      } else {
        newFinishedAt = null;
      }

      const editionInfo = edition_id
        ? await pool.query('SELECT pages FROM editions WHERE id = $1', [edition_id])
        : { rows: [{ pages: null }] };
      const totalPages = editionInfo.rows[0]?.pages;

      const result = await pool.query(
        `UPDATE reading_progress
         SET
           current_page = COALESCE($1, current_page),
           status = $2,
           user_rating = $3,
           user_review = COALESCE($4, user_review),
           started_at = $5,
           finished_at = $6,
           total_pages = COALESCE($7, total_pages),
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $8 AND ${progressKey.col} = $9
         RETURNING *`,
        [
          current_page !== undefined ? current_page : null,
          newStatus,
          finalRating,
          user_review,
          newStartedAt,
          newFinishedAt,
          totalPages,
          userId,
          progressKey.val
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Запись не найдена' });
      }
  
      console.log('[updateProgress] Прогресс обновлен:', result.rows[0]);
      
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

  async addNote(req: Request, res: Response) {
    try {
      const { libraryId } = req.params;
      const userId = (req as any).user.id;
      const { content, page_number } = req.body;

      if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Текст заметки обязателен' });
      }
      if (page_number !== undefined && page_number !== null) {
        const p = Number(page_number);
        if (!Number.isInteger(p) || p < 1) {
          return res.status(400).json({ error: 'page_number должен быть положительным целым числом' });
        }
      }

      const libRes = await pool.query(
        'SELECT id FROM user_library WHERE id = $1 AND user_id = $2',
        [libraryId, userId]
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

  async getNotes(req: Request, res: Response) {
    try {
      const { libraryId } = req.params;
      const userId = (req as any).user.id;

      const result = await pool.query(
        `SELECT bn.*
         FROM book_notes bn
         JOIN user_library ul ON bn.user_library_id = ul.id
         WHERE ul.id = $1 AND ul.user_id = $2
         ORDER BY bn.created_at DESC`,
        [libraryId, userId]
      );

      res.json(result.rows);
    } catch (error) {
      console.error('Ошибка получения заметок:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async deleteNote(req: Request, res: Response) {
    try {
      const noteIdParam = req.params.noteId;
      
      if (!noteIdParam || Array.isArray(noteIdParam)) {
        return res.status(400).json({ error: 'Неверный ID заметки' });
      }
      
      const noteId = parseInt(noteIdParam);
      const userId = (req as any).user.id;

      console.log('[Controller] Удаление заметки:', { noteId, userId });

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

      await pool.query('DELETE FROM book_notes WHERE id = $1', [noteId]);

      console.log('[Controller] Заметка удалена');
      res.json({ success: true, message: 'Заметка удалена' });

    } catch (error) {
      console.error('Ошибка удаления заметки:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async getAllNotes(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      await pool.query(
        `ALTER TABLE book_notes ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false`
      );
      const result = await pool.query(
        `SELECT
           bn.id,
           bn.content,
           bn.page_number,
           bn.is_favorite,
           bn.created_at,
           bn.updated_at,
           ul.id AS library_id,
           COALESCE(w.title, 'Без названия') AS book_title,
           COALESCE(a.full_name, '') AS book_author,
           e.cover_url
         FROM book_notes bn
         JOIN user_library ul ON bn.user_library_id = ul.id
         LEFT JOIN editions e ON ul.edition_id = e.id
         LEFT JOIN works w ON e.work_id = w.id
         LEFT JOIN authors a ON w.author_id = a.id
         WHERE ul.user_id = $1
         ORDER BY bn.is_favorite DESC, bn.created_at DESC`,
        [userId]
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Ошибка получения всех заметок:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async toggleNoteFavorite(req: Request, res: Response) {
    try {
      const noteId = parseInt(req.params.noteId as string, 10);
      if (isNaN(noteId)) return res.status(400).json({ error: 'Неверный ID заметки' });
      const userId = (req as any).user.id;
      const { is_favorite } = req.body;
      const check = await pool.query(
        `SELECT bn.id FROM book_notes bn
         JOIN user_library ul ON bn.user_library_id = ul.id
         WHERE bn.id = $1 AND ul.user_id = $2`,
        [noteId, userId]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Заметка не найдена' });
      await pool.query(
        `UPDATE book_notes SET is_favorite = $1 WHERE id = $2`,
        [!!is_favorite, noteId]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Ошибка изменения избранного заметки:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async deleteNotesByLibrary(req: Request, res: Response) {
    try {
      const libraryId = parseInt(req.params.libraryId as string, 10);
      if (isNaN(libraryId)) return res.status(400).json({ error: 'Неверный ID записи библиотеки' });
      const userId = (req as any).user.id;
      const libCheck = await pool.query(
        `SELECT id FROM user_library WHERE id = $1 AND user_id = $2`,
        [libraryId, userId]
      );
      if (libCheck.rows.length === 0) return res.status(404).json({ error: 'Книга не найдена' });
      const result = await pool.query(
        `DELETE FROM book_notes WHERE user_library_id = $1 AND is_favorite = false`,
        [libraryId]
      );
      res.json({ success: true, deleted: result.rowCount });
    } catch (error) {
      console.error('Ошибка удаления заметок группы:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async updateNote(req: Request, res: Response) {
    try {
      const noteIdParam = req.params.noteId as string;
      const noteId = parseInt(noteIdParam, 10);
      const userId = (req as any).user.id;
      const { content, page_number } = req.body;

      if (!content?.trim()) {
        return res.status(400).json({ error: 'Содержимое заметки не может быть пустым' });
      }

      const check = await pool.query(
        `SELECT bn.id FROM book_notes bn
         JOIN user_library ul ON bn.user_library_id = ul.id
         WHERE bn.id = $1 AND ul.user_id = $2`,
        [noteId, userId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Заметка не найдена' });
      }

      const result = await pool.query(
        `UPDATE book_notes SET content = $1, page_number = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [content.trim(), page_number ?? null, noteId]
      );
      res.json({ success: true, note: result.rows[0] });
    } catch (error) {
      console.error('Ошибка обновления заметки:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async createCollection(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { name, description } = req.body;  
  
      console.log('[createCollection]', { userId, name, description });
  
      if (!name) {
        return res.status(400).json({ error: 'Название коллекции обязательно' });
      }
      const existingCheck = await pool.query(
        'SELECT id FROM user_collections WHERE user_id = $1 AND name = $2',
        [userId, name]
      );
  
      if (existingCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Коллекция с таким именем уже существует' });
      }
  
      const result = await pool.query(
        `INSERT INTO user_collections (user_id, name, description) 
         VALUES ($1, $2, $3) 
         RETURNING *`,
        [userId, name, description || null]
      );
  
      console.log('[createCollection] Коллекция создана:', result.rows[0]);
      
      res.status(201).json({ 
        success: true, 
        collection: result.rows[0] 
      });
  
    } catch (error) {
      console.error('Ошибка создания коллекции:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async addBookToCollection(req: Request, res: Response) {
    try {
      const { collectionId, libraryId } = req.body;
      const userId = (req as any).user.id;

      console.log('[addBookToCollection]', { collectionId, libraryId, userId });

      if (!collectionId || !libraryId) {
        return res.status(400).json({ error: 'collectionId и libraryId обязательны' });
      }

      const collectionCheck = await pool.query(
        'SELECT id FROM user_collections WHERE id = $1 AND user_id = $2',
        [collectionId, userId]
      );

      if (collectionCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Коллекция не найдена' });
      }

      const libRes = await pool.query(
        'SELECT id FROM user_library WHERE id = $1 AND user_id = $2',
        [libraryId, userId]
      );

      if (libRes.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      const result = await pool.query(
        `INSERT INTO book_collections (user_library_id, collection_id)
         VALUES ($1, $2)
         ON CONFLICT (user_library_id, collection_id) DO NOTHING
         RETURNING id`,
        [libraryId, collectionId]
      );
  
      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Книга уже в коллекции' });
      }
  
      console.log('[addBookToCollection] Книга добавлена в коллекцию');
      res.json({ success: true, message: 'Книга добавлена в коллекцию' });
  
    } catch (error) {
      console.error('Ошибка добавления в коллекцию:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async getCollections(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      await pool.query(
        `ALTER TABLE user_collections ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false`
      );
      const result = await pool.query(
        `SELECT
          uc.*,
          COUNT(bc.id) as books_count
         FROM user_collections uc
         LEFT JOIN book_collections bc ON uc.id = bc.collection_id
         WHERE uc.user_id = $1
         GROUP BY uc.id
         ORDER BY uc.is_pinned DESC, uc.created_at ASC`,
        [userId]
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Ошибка получения коллекций:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async togglePinCollection(req: Request, res: Response) {
    try {
      const collectionId = parseInt(req.params.id as string, 10);
      if (isNaN(collectionId)) return res.status(400).json({ error: 'Неверный ID коллекции' });
      const userId = (req as any).user.id;
      const { is_pinned } = req.body;
      const check = await pool.query(
        'SELECT id FROM user_collections WHERE id = $1 AND user_id = $2',
        [collectionId, userId]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Коллекция не найдена' });
      await pool.query(
        'UPDATE user_collections SET is_pinned = $1 WHERE id = $2',
        [!!is_pinned, collectionId]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Ошибка закрепления коллекции:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async getReadingStats(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;

      const totalStats = await pool.query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'finished') as books_finished,
           COUNT(*) FILTER (WHERE status = 'reading') as books_reading,
           COUNT(*) as books_total,
           COALESCE(AVG(user_rating) FILTER (WHERE user_rating IS NOT NULL), 0) as avg_rating
         FROM reading_progress
         WHERE user_id = $1`,
        [userId]
      );

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

      const topAuthors = await pool.query(
        `SELECT
           COALESCE((SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order) FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id WHERE wa.work_id = w.id), a.full_name) as author,
           COUNT(*) as books_read
         FROM reading_progress rp
         JOIN editions e ON rp.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         JOIN authors a ON w.author_id = a.id
         WHERE rp.user_id = $1 AND rp.status = 'finished'
         GROUP BY a.id, w.id
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

  async getReadingHistory(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;

      const result = await pool.query(
        `SELECT 
           e.id as edition_id,
           e.isbn,
           e.cover_url,
           w.id as work_id,
           w.title,
           COALESCE((SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order) FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id WHERE wa.work_id = w.id), a.full_name) as author,
           rp.finished_at,
           rp.user_rating
         FROM reading_progress rp
         JOIN editions e ON rp.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         JOIN authors a ON w.author_id = a.id
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

      const collectionCheck = await pool.query(
        'SELECT * FROM user_collections WHERE id = $1 AND user_id = $2',
        [collectionId, userId]
      );

      if (collectionCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Коллекция не найдена' });
      }

      const booksResult = await pool.query(
        `SELECT
          ul.id as library_id,
          e.id as edition_id,
          e.isbn,
          e.cover_url,
          w.id as work_id,
          w.title,
          a.full_name as author,
          COALESCE(bc.added_at, CURRENT_TIMESTAMP) as added_at
         FROM book_collections bc
         JOIN user_library ul ON bc.user_library_id = ul.id
         JOIN editions e ON ul.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         JOIN authors a ON w.author_id = a.id
         WHERE bc.collection_id = $1
         ORDER BY bc.added_at DESC`,
        [collectionId]
      );

      console.log('[Controller] Найдено книг в коллекции:', booksResult.rows.length);

      const collection = {
        ...collectionCheck.rows[0],
        books: booksResult.rows || []
      };

      res.json(collection);

    } catch (error) {
      console.error('Ошибка получения коллекции:', error);
      res.status(500).json({ error: 'Ошибка сервера при получении коллекции' });
    }
  },

  async removeBookFromCollection(req: Request, res: Response) {
    try {
      const { libraryId: libraryIdParam, collectionId: collectionIdParam } = req.params;

      if (!libraryIdParam || !collectionIdParam ||
          Array.isArray(libraryIdParam) || Array.isArray(collectionIdParam)) {
        return res.status(400).json({ error: 'Неверные параметры' });
      }

      const libraryId    = parseInt(libraryIdParam as string);
      const collectionId = parseInt(collectionIdParam as string);

      if (isNaN(libraryId) || isNaN(collectionId)) {
        return res.status(400).json({ error: 'ID должны быть числами' });
      }

      const userId = (req as any).user.id;

      console.log('[removeBookFromCollection]', { libraryId, collectionId, userId });

      const libRes = await pool.query(
        'SELECT id FROM user_library WHERE id = $1 AND user_id = $2',
        [libraryId, userId]
      );

      if (libRes.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      const result = await pool.query(
        'DELETE FROM book_collections WHERE collection_id = $1 AND user_library_id = $2 RETURNING id',
        [collectionId, libraryId]
      );
  
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в коллекции' });
      }
  
      console.log('[removeBookFromCollection] Книга удалена из коллекции');
      res.json({ success: true, message: 'Книга удалена из коллекции' });
  
    } catch (error) {
      console.error('Ошибка удаления из коллекции:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async deleteCollection(req: Request, res: Response) {
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

  async updateCollection(req: Request, res: Response) {
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
      const { name, description } = req.body; 
  
      console.log('[updateCollection]', { collectionId, userId, name, description });
  
      const checkRes = await pool.query(
        'SELECT id FROM user_collections WHERE id = $1 AND user_id = $2',
        [collectionId, userId]
      );
  
      if (checkRes.rows.length === 0) {
        return res.status(404).json({ error: 'Коллекция не найдена' });
      }
  
      if (name) {
        const nameCheck = await pool.query(
          'SELECT id FROM user_collections WHERE user_id = $1 AND name = $2 AND id != $3',
          [userId, name, collectionId]
        );
        if (nameCheck.rows.length > 0) {
          return res.status(400).json({ error: 'Коллекция с таким именем уже существует' });
        }
      }
  
      const result = await pool.query(
        `UPDATE user_collections 
         SET 
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND user_id = $4
         RETURNING *`,
        [name || null, description || null, collectionId, userId]
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
      console.error('Ошибка обновления коллекции:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

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

      const result = await pool.query(
        `SELECT
          ul.id as library_id,
          e.id as edition_id,
          e.cover_url,
          w.title,
          COALESCE((SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order) FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id WHERE wa.work_id = w.id), a.full_name) as author
         FROM user_library ul
         JOIN editions e ON ul.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         JOIN authors a ON w.author_id = a.id
         WHERE ul.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM book_collections bc
           WHERE bc.user_library_id = ul.id
           AND bc.collection_id = $2
         )
         ORDER BY w.title`,
        [userId, collectionId]
      );

      res.json(result.rows);

    } catch (error) {
      console.error('Ошибка получения доступных книг:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async addManualBook(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { isbn, title, authors, pages, publisher, publish_year, description, cover_url, language, series, forceUpdate, format, added_via: addedVia } = req.body;
      const genreRaw = req.body.genre;
      const genre: string | null = Array.isArray(genreRaw)
        ? (genreRaw.filter(Boolean).join(', ') || null)
        : (typeof genreRaw === 'string' ? genreRaw.trim() || null : null);
      const bookFormat = (typeof format === 'string' && ['physical','digital','audio'].includes(format)) ? format : 'physical';
      const bookAddedVia = (typeof addedVia === 'string' && addedVia.trim()) ? addedVia.trim() : 'manual';

      console.log('\n[Controller] ========== ДОБАВЛЕНИЕ КНИГИ ВРУЧНУЮ ==========');
      console.log('[Controller] User ID:', userId);
      console.log('[Controller] ISBN:', isbn);
      console.log('[Controller] Title:', title);

      if (!title) {
        return res.status(400).json({ error: 'Название книги обязательно' });
      }

      const cleanTitle = title.trim();
      if (cleanTitle.length < 2 || !/[а-яёa-z]/i.test(cleanTitle)) {
        return res.status(400).json({ error: 'Название книги не может быть таким коротким или содержать только символы' });
      }

      const cleanAuthors = authors?.filter((a: string) => a?.trim()) ?? [];
      const authorName = cleanAuthors[0] || 'Неизвестный автор';

      if (!isbn || !isbn.trim()) {
        const workId = await findOrCreateWork(title, authorName, userId);
        await upsertWorkAuthors(workId, cleanAuthors);

        const existEdRes = await pool.query(
          'SELECT id FROM editions WHERE work_id = $1 AND isbn IS NULL LIMIT 1',
          [workId]
        );

        let editionId: number;
        if (existEdRes.rows.length > 0) {
          editionId = existEdRes.rows[0].id;
          await pool.query(
            `UPDATE editions SET
               pages        = CASE WHEN $1::int  IS NOT NULL THEN $1::int  ELSE pages        END,
               publisher    = CASE WHEN $2::text IS NOT NULL THEN $2       ELSE publisher    END,
               publish_year = CASE WHEN $3::int  IS NOT NULL THEN $3::int  ELSE publish_year END,
               cover_url    = CASE WHEN $4::text IS NOT NULL THEN $4       ELSE cover_url    END,
               language     = CASE WHEN $5::text IS NOT NULL THEN $5       ELSE language     END,
               series       = CASE WHEN $7::text IS NOT NULL THEN $7       ELSE series       END
             WHERE id = $6`,
            [pages || null, publisher || null, publish_year || null, cover_url || null, language || null, editionId, series || null]
          );
        } else {
          const newEdRes = await pool.query(
            `INSERT INTO editions (work_id, publisher, publish_year, pages, cover_url, language, series)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [workId, publisher || null, publish_year || null, pages || null, cover_url || null, language || 'ru', series || null]
          );
          editionId = newEdRes.rows[0].id;
        }

        const existByEd = await pool.query(
          'SELECT id FROM user_library WHERE user_id = $1 AND edition_id = $2',
          [userId, editionId]
        );
        const existByWork = await pool.query(
          'SELECT id FROM user_library WHERE user_id = $1 AND work_id = $2 AND edition_id IS NULL',
          [userId, workId]
        );

        if (existByEd.rows.length > 0 || existByWork.rows.length > 0) {
          const libId = existByEd.rows[0]?.id || existByWork.rows[0]?.id;
          return res.status(200).json({
            success: true,
            message: 'Книга уже в вашей библиотеке',
            libraryId: libId,
            alreadyExists: true
          });
        }

        const libResult = await pool.query(
          `INSERT INTO user_library (user_id, edition_id, added_via, added_at, format)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
           ON CONFLICT DO NOTHING RETURNING id`,
          [userId, editionId, bookAddedVia, bookFormat]
        );

        if (libResult.rows.length > 0) {
          const libId = libResult.rows[0].id;
          await pool.query(
            `INSERT INTO reading_progress (user_id, edition_id, status, created_at)
             VALUES ($1, $2, 'want_to_read', CURRENT_TIMESTAMP)
             ON CONFLICT DO NOTHING`,
            [userId, editionId]
          );
          if (description || genre) {
            await pool.query(
              `UPDATE user_library
               SET custom_description = COALESCE($1, custom_description),
                   custom_genre       = COALESCE($2, custom_genre)
               WHERE id = $3`,
              [description?.trim() || null, genre?.trim() || null, libId]
            );
          }
          return res.status(201).json({
            success: true,
            message: 'Книга добавлена в библиотеку',
            libraryId: libId,
            alreadyExists: false
          });
        }
      }

      const cleanIsbn = isbn.replace(/[-\s]/g, '');

      const userEditionCheck = await pool.query(
        `SELECT ul.id, e.id as edition_id, e.isbn, w.title
         FROM user_library ul
         JOIN editions e ON ul.edition_id = e.id
         JOIN works w ON e.work_id = w.id
         WHERE ul.user_id = $1 AND e.isbn = $2`,
        [userId, cleanIsbn]
      );

      if (userEditionCheck.rows.length > 0) {
        console.log('[Controller] Книга уже есть у пользователя');
        return res.status(200).json({
          success: true,
          message: 'Книга уже в вашей библиотеке',
          editionId: userEditionCheck.rows[0].edition_id,
          alreadyExists: true
        });
      }

      let editionResult = await pool.query(
        'SELECT * FROM editions WHERE isbn = $1',
        [cleanIsbn]
      );

      let editionId;
      let workId;
      let workTitle = title;

      if (editionResult.rows.length === 0) {
        console.log('[Controller] Издание не найдено в БД, создаём...');

        workId = await findOrCreateWork(title, authorName, forceUpdate ? undefined : userId);
        await upsertWorkAuthors(workId, cleanAuthors);

        const newEdition = await pool.query(
          `INSERT INTO editions (work_id, isbn, publisher, publish_year, pages, cover_url, language, series)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            workId,
            cleanIsbn,
            publisher || null,
            publish_year || null,
            pages || null,
            cover_url || null,
            language || 'ru',
            series || null
          ]
        );

        editionId = newEdition.rows[0].id;
        console.log('[Controller] Издание добавлено в БД, ID:', editionId);
      } else {
        editionId = editionResult.rows[0].id;
        const workInfo = await pool.query(
          'SELECT w.title, w.id, w.author_id FROM works w JOIN editions e ON e.work_id = w.id WHERE e.id = $1',
          [editionId]
        );
        workTitle = workInfo.rows[0]?.title || title;
        workId = workInfo.rows[0]?.id;
        console.log('[Controller] Издание уже есть в БД, ID:', editionId);

        if (forceUpdate && workId) {
          console.log('[Controller] forceUpdate=true — обновляем данные издания и произведения');

          await upsertWorkAuthors(workId, cleanAuthors);

          await pool.query(
            'UPDATE works SET title = $1 WHERE id = $2',
            [title, workId]
          );
          workTitle = title;

          await pool.query(
            `UPDATE editions
             SET publisher    = $1,
                 publish_year = $2,
                 pages        = $3,
                 cover_url    = COALESCE($4, cover_url),
                 language     = $5,
                 series       = $6
             WHERE id = $7`,
            [
              publisher || null,
              publish_year || null,
              pages || null,
              cover_url || null,
              language || 'ru',
              series || null,
              editionId,
            ]
          );
          console.log('[Controller] Данные издания обновлены (forceUpdate)');
        }
      }

      let libraryResult;
      if (workId) {
        const workOnlyEntry = await pool.query(
          `SELECT id FROM user_library WHERE user_id = $1 AND work_id = $2 AND edition_id IS NULL`,
          [userId, workId]
        );
        if (workOnlyEntry.rows.length > 0) {
          const oldId = workOnlyEntry.rows[0].id;
          libraryResult = await pool.query(
            `UPDATE user_library SET edition_id = $1, work_id = NULL WHERE id = $2 RETURNING id`,
            [editionId, oldId]
          );
          await pool.query(
            `UPDATE reading_progress SET edition_id = $1, work_id = NULL
             WHERE user_id = $2 AND work_id = $3 AND edition_id IS NULL`,
            [editionId, userId, workId]
          );
        }
      }

      if (!libraryResult || libraryResult.rows.length === 0) {
        libraryResult = await pool.query(
          `INSERT INTO user_library (user_id, edition_id, added_via, added_at, format)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, editionId, bookAddedVia, bookFormat]
        );
      }

      if (libraryResult.rows.length > 0) {
        await pool.query(
          `INSERT INTO reading_progress (user_id, edition_id, status, created_at)
           VALUES ($1, $2, 'want_to_read', CURRENT_TIMESTAMP)
           ON CONFLICT DO NOTHING`,
          [userId, editionId]
        );

        const newLibraryId = libraryResult.rows[0].id;

        if (description || genre) {
          await pool.query(
            `UPDATE user_library
             SET custom_description = COALESCE($1, custom_description),
                 custom_genre       = COALESCE($2, custom_genre)
             WHERE id = $3`,
            [description?.trim() || null, genre?.trim() || null, newLibraryId]
          );
        }

        console.log('[Controller] Книга добавлена в библиотеку пользователя');
        res.status(201).json({
          success: true,
          message: 'Книга добавлена в библиотеку',
          libraryId: newLibraryId,
          editionId: editionId,
          alreadyExists: false
        });
      } else {
        console.log('[Controller] Книга уже была в библиотеке пользователя');
        const existingLib = await pool.query(
          'SELECT id FROM user_library WHERE user_id = $1 AND edition_id = $2',
          [userId, editionId]
        );
        res.status(200).json({
          success: true,
          message: 'Книга уже в вашей библиотеке',
          libraryId: existingLib.rows[0]?.id,
          editionId: editionId,
          alreadyExists: true
        });
      }

    } catch (error) {
      console.error('Ошибка добавления книги вручную:', error);
      
      if ((error as any).code === '23505') {
        return res.status(400).json({ 
          error: 'Книга с таким ISBN уже существует в системе',
          details: (error as any).detail
        });
      }
      
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async toggleFavorite(req: Request, res: Response) {
    try {
      const libraryIdParam = req.params.libraryId;

      if (!libraryIdParam || Array.isArray(libraryIdParam)) {
        return res.status(400).json({ error: 'Неверный ID записи библиотеки' });
      }

      const libraryId = parseInt(libraryIdParam);
      if (isNaN(libraryId)) {
        return res.status(400).json({ error: 'Неверный ID записи библиотеки' });
      }
      const userId = (req as any).user.id;
      const { isFavorite } = req.body;

      console.log('[Controller] Переключение избранного:', { userId, libraryId, isFavorite });

      const result = await pool.query(
        `UPDATE user_library
         SET is_favorite = $1
         WHERE id = $2 AND user_id = $3
         RETURNING id, is_favorite`,
        [isFavorite, libraryId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      let favoritesCollection = await pool.query(
        'SELECT id FROM user_collections WHERE user_id = $1 AND name = $2',
        [userId, 'Избранные']
      );

      let collectionId;
      if (favoritesCollection.rows.length === 0) {
        const newCollection = await pool.query(
          `INSERT INTO user_collections (user_id, name, description)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, 'Избранные', 'Книги, которые вы отметили как избранные']
        );
        collectionId = newCollection.rows[0].id;
        console.log('[Controller] Создана коллекция "Избранные"');
      } else {
        collectionId = favoritesCollection.rows[0].id;
      }

      if (isFavorite) {
        await pool.query(
          `INSERT INTO book_collections (user_library_id, collection_id)
           VALUES ($1, $2)
           ON CONFLICT (user_library_id, collection_id) DO NOTHING`,
          [libraryId, collectionId]
        );
        console.log('[Controller] Книга добавлена в коллекцию Избранные');
      } else {
        await pool.query(
          'DELETE FROM book_collections WHERE user_library_id = $1 AND collection_id = $2',
          [libraryId, collectionId]
        );
        console.log('[Controller] Книга удалена из коллекции Избранные');
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
      const libraryIdParam = req.params.libraryId;

      if (!libraryIdParam || Array.isArray(libraryIdParam)) {
        return res.status(400).json({ error: 'Неверный ID записи библиотеки' });
      }

      const libraryId = parseInt(libraryIdParam);

      if (isNaN(libraryId)) {
        return res.status(400).json({ error: 'ID должен быть числом' });
      }

      const userId = (req as any).user.id;

      const libEntry = await pool.query(
        `SELECT ul.work_id, COALESCE(e.work_id, ul.work_id) AS resolved_work_id
         FROM user_library ul
         LEFT JOIN editions e ON ul.edition_id = e.id
         WHERE ul.id = $1 AND ul.user_id = $2`,
        [libraryId, userId]
      );

      if (libEntry.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      const resolvedWorkId: number | null = libEntry.rows[0].resolved_work_id;

      const result = await pool.query(
        'DELETE FROM user_library WHERE id = $1 AND user_id = $2 RETURNING id',
        [libraryId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      if (resolvedWorkId) {
        const workMeta = await pool.query(
          'SELECT created_by_user_id FROM works WHERE id = $1',
          [resolvedWorkId]
        );
        const isPersonal = workMeta.rows[0]?.created_by_user_id === userId;

        if (isPersonal) {
          const otherUsers = await pool.query(
            `SELECT COUNT(*) FROM user_library
             WHERE COALESCE(work_id, (SELECT work_id FROM editions WHERE id = edition_id)) = $1`,
            [resolvedWorkId]
          );
          if (parseInt(otherUsers.rows[0].count) === 0) {
            await pool.query(
              'DELETE FROM editions WHERE work_id = $1 AND isbn IS NULL',
              [resolvedWorkId]
            );
            await pool.query('DELETE FROM works WHERE id = $1', [resolvedWorkId]);
          }
        }
      }

      res.json({ success: true, message: 'Книга удалена из библиотеки' });
    } catch (error) {
      console.error('Ошибка удаления книги:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async getRoutes(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      console.log('[Controller] Получение маршрутов для пользователя:', userId);
  
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
            FROM route_books rb
            WHERE rb.route_id = r.id
          ) as books_count,
      
          (
            SELECT COALESCE(
              AVG(
                CASE 
                  WHEN rp.status = 'finished' THEN 100
                  WHEN e.pages > 0 THEN (rp.current_page * 100.0 / e.pages)
                  ELSE 0
                END
              ),
              0
            )
            FROM route_books rb
      
            JOIN editions e 
              ON e.work_id = rb.work_id
      
            LEFT JOIN user_library ul
              ON ul.edition_id = e.id
             AND ul.user_id = r.user_id
      
            LEFT JOIN reading_progress rp
              ON rp.user_id = r.user_id
             AND rp.edition_id = e.id
      
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
      console.error('Ошибка получения маршрутов:', error);
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
  
      const booksResult = await pool.query(
        `SELECT
          rb.id,
          ul.id                                           AS book_id,
          w.id                                            AS work_id,
          w.title,
          COALESCE((SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order) FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id WHERE wa.work_id = w.id), a.full_name) AS author,
          e.cover_url,
          rb.order_index,
          COALESCE(rp.status, 'want_to_read')             AS status,
          COALESCE(rp.current_page, 0)                    AS current_page,
          COALESCE(e.pages, 0)                            AS total_pages,
          rp.user_rating,
          rp.finished_at,
          (ul.id IS NOT NULL)                             AS is_owned
         FROM route_books rb
         JOIN works w ON rb.work_id = w.id
         LEFT JOIN authors a ON w.author_id = a.id
         LEFT JOIN LATERAL (
           SELECT id, cover_url, pages
           FROM editions
           WHERE work_id = w.id
           ORDER BY id ASC
           LIMIT 1
         ) e ON true
         LEFT JOIN user_library ul
           ON ul.user_id = $1
           AND (
             (e.id IS NOT NULL AND ul.edition_id = e.id)
             OR (e.id IS NULL AND ul.work_id = w.id AND ul.edition_id IS NULL)
           )
         LEFT JOIN reading_progress rp
           ON rp.user_id = $1
           AND (
             (e.id IS NOT NULL AND rp.edition_id = e.id)
             OR (e.id IS NULL AND rp.work_id = w.id AND rp.edition_id IS NULL)
           )
         WHERE rb.route_id = $2
         ORDER BY rb.order_index`,
        [userId, routeId]
      );

      const books = booksResult.rows;
      const finishedCount = books.filter((b: any) => b.status === 'finished').length;
      const progress = books.length > 0 ? Math.round(finishedCount / books.length * 100) : 0;

      res.json({
        route: {
          ...routeResult.rows[0],
          progress,
          books_count: books.length,
          books
        }
      });
  
    } catch (error) {
      console.error('Ошибка получения маршрута:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async createRoute(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id; 
      const { name, description, planned_start_date, planned_end_date, books } = req.body;
  
      console.log('[createRoute]', { userId, name, description, booksCount: books?.length });
  
      if (!name) {
        return res.status(400).json({ error: 'Название маршрута обязательно' });
      }
  
      await pool.query('BEGIN');
  
      const routeResult = await pool.query(
        `INSERT INTO reading_routes 
         (user_id, name, description, planned_start_date, planned_end_date, status) 
         VALUES ($1, $2, $3, $4, $5, 'draft') 
         RETURNING id, name, description, status, planned_start_date, planned_end_date, created_at, updated_at`,
        [userId, name, description || null, planned_start_date || null, planned_end_date || null]
      );
  
      const routeId = routeResult.rows[0].id;
      const addedWorks = [];
  
      if (books && books.length > 0) {
        for (let i = 0; i < books.length; i++) {
          const book = books[i];
          const workResult = await pool.query(
            `SELECT COALESCE(e.work_id, ul.work_id) AS work_id
             FROM user_library ul
             LEFT JOIN editions e ON ul.edition_id = e.id
             WHERE ul.id = $1 AND ul.user_id = $2`,
            [book.bookId, userId]
          );

          if (workResult.rows.length === 0 || !workResult.rows[0].work_id) {
            throw new Error(`Книга с ID ${book.bookId} не найдена`);
          }

          const workId = workResult.rows[0].work_id;

          await pool.query(
            `INSERT INTO route_books (route_id, work_id, order_index)
             VALUES ($1, $2, $3)`,
            [routeId, workId, book.order_index !== undefined ? book.order_index : i]
          );

          addedWorks.push({
            workId: workId,
            editionId: book.bookId,
            order_index: i
          });
        }
      }
  
      await pool.query('COMMIT');
  
      const result = {
        ...routeResult.rows[0],
        books: addedWorks
      };
  
      res.status(201).json(result);
  
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('Ошибка создания маршрута:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async updateRoute(req: Request, res: Response) {
    try {
      const routeIdParam = req.params.id;
      
      if (!routeIdParam || Array.isArray(routeIdParam)) {
        return res.status(400).json({ error: 'Неверный ID маршрута' });
      }
      
      const routeId = parseInt(routeIdParam);
      const userId = (req as any).user.id;
      const { name, description, planned_start_date, planned_end_date, status, books } = req.body;
  
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
        [name || null, description || null, planned_start_date || null, planned_end_date || null, status || null, routeId, userId]
      );
  
      if (books !== undefined) {
        await pool.query('DELETE FROM route_books WHERE route_id = $1', [routeId]);
  
        for (let i = 0; i < books.length; i++) {
          const book = books[i];
          let workId: number | null = null;

          const libResult = await pool.query(
            `SELECT COALESCE(e.work_id, ul.work_id) AS work_id
             FROM user_library ul
             LEFT JOIN editions e ON ul.edition_id = e.id
             WHERE ul.id = $1 AND ul.user_id = $2`,
            [book.bookId, userId]
          );

          if (libResult.rows.length > 0 && libResult.rows[0].work_id) {
            workId = libResult.rows[0].work_id;
          } else {
            const directWork = await pool.query('SELECT id FROM works WHERE id = $1', [book.bookId]);
            if (directWork.rows.length > 0) workId = book.bookId;
          }

          if (workId) {
            await pool.query(
              `INSERT INTO route_books (route_id, work_id, order_index)
               VALUES ($1, $2, $3)`,
              [routeId, workId, book.order_index !== undefined ? book.order_index : i]
            );
          }
        }
      }
  
      await pool.query('COMMIT');

      const booksResult = await pool.query(
        `SELECT 
          rb.id,
          e.id as book_id,
          w.id as work_id,
          w.title,
          COALESCE((SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order) FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id WHERE wa.work_id = w.id), a.full_name) as author,
          e.cover_url,
          rb.order_index,
          COALESCE(rp.status, 'want_to_read') as status,
          COALESCE(rp.current_page, 0) as current_page,
          COALESCE(e.pages, 0) as total_pages
         FROM route_books rb
         JOIN works w ON rb.work_id = w.id
         JOIN authors a ON w.author_id = a.id
         JOIN editions e ON e.work_id = w.id
         LEFT JOIN reading_progress rp ON rp.user_id = $1 AND rp.edition_id = e.id
         WHERE rb.route_id = $2
         ORDER BY rb.order_index`,
        [userId, routeId]
      );
  
      res.json({
        ...routeResult.rows[0],
        books: booksResult.rows
      });
  
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('Ошибка обновления маршрута:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

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

  async activateRoute(req: Request, res: Response) {
    try {
      const routeIdParam = req.params.id;
      
      if (!routeIdParam || Array.isArray(routeIdParam)) {
        return res.status(400).json({ error: 'Неверный ID маршрута' });
      }
      
      const routeId = parseInt(routeIdParam);
      const userId = (req as any).user.id;

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

      const routeBooks = await pool.query(
        `SELECT rb.work_id FROM route_books rb WHERE rb.route_id = $1`,
        [routeId]
      );
      for (const rb of routeBooks.rows) {
        const edRes = await pool.query(
          `SELECT id FROM editions WHERE work_id = $1 ORDER BY id LIMIT 1`,
          [rb.work_id]
        );
        if (edRes.rows.length === 0) continue;
        const editionId = edRes.rows[0].id;
        const libRes = await pool.query(
          `INSERT INTO user_library (user_id, edition_id, added_via, added_at)
           VALUES ($1, $2, 'ai_route', CURRENT_TIMESTAMP)
           ON CONFLICT DO NOTHING RETURNING id`,
          [userId, editionId]
        );
        if (libRes.rows.length > 0) {
          await pool.query(
            `INSERT INTO reading_progress (user_id, edition_id, status, created_at)
             VALUES ($1, $2, 'want_to_read', CURRENT_TIMESTAMP)
             ON CONFLICT DO NOTHING`,
            [userId, editionId]
          );
        }
      }

      res.json({ success: true, message: 'Маршрут активирован' });

    } catch (error) {
      console.error('Ошибка активации маршрута:', error);
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
      console.error('Ошибка завершения маршрута:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async updatePages(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const libraryIdParam = req.params.libraryId;

      if (!libraryIdParam || Array.isArray(libraryIdParam)) {
        return res.status(400).json({ error: 'Неверный ID записи библиотеки' });
      }

      const libraryId = parseInt(libraryIdParam);
      if (isNaN(libraryId)) {
        return res.status(400).json({ error: 'ID должен быть числом' });
      }

      const { pages } = req.body;

      if (!pages || pages <= 0) {
        return res.status(400).json({ error: 'Некорректное число страниц' });
      }

      const libEntry = await pool.query(
        'SELECT edition_id FROM user_library WHERE id = $1 AND user_id = $2',
        [libraryId, userId]
      );

      if (libEntry.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена в библиотеке' });
      }

      const editionId = libEntry.rows[0].edition_id;
      if (!editionId) {
        return res.status(400).json({ error: 'У книги без ISBN нельзя обновить страницы через это поле' });
      }

      await pool.query(
        'UPDATE editions SET pages = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [pages, editionId]
      );
      
      res.json({ success: true, pages });
    } catch (error) {
      console.error('Ошибка обновления страниц:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },
    async findOrCreateWork(req: Request, res: Response) {
      try {
        const { title, author } = req.body;
        
        if (!title || !author) {
          return res.status(400).json({ error: 'Название и автор обязательны' });
        }
  
        const userId = (req as any).user?.id;
        const workId = await findOrCreateWork(title, author, userId);

        res.json({ success: true, workId, message: 'Произведение найдено или создано' });
        
      } catch (error) {
        console.error('[findOrCreateWork] Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
      }
    },
  
    async addBookToRoute(req: Request, res: Response) {
      try {
        const routeIdParam = req.params.routeId;
        if (typeof routeIdParam !== 'string') {
          return res.status(400).json({ error: 'Неверный ID маршрута' });
        }
    
        const routeId = parseInt(routeIdParam, 10);
        const { workId } = req.body;
        
        if (isNaN(routeId) || !workId) {
          return res.status(400).json({ error: 'Неверные параметры (routeId или workId)' });
        }
        
        const userId = (req as any).user.id;
        
        const routeCheck = await pool.query(
          'SELECT id FROM reading_routes WHERE id = $1 AND user_id = $2',
          [routeId, userId]
        );
        
        if (routeCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Маршрут не найден или нет доступа' });
        }
        
        const maxOrderRes = await pool.query(
          'SELECT MAX(order_index) as max_idx FROM route_books WHERE route_id = $1',
          [routeId]
        );
        const nextOrderIndex = (maxOrderRes.rows[0].max_idx ?? -1) + 1;
    
        await pool.query(
          `INSERT INTO route_books (route_id, work_id, order_index) 
           VALUES ($1, $2, $3)
           ON CONFLICT (route_id, work_id) DO NOTHING`,
          [routeId, workId, nextOrderIndex]
        );
        
        res.json({ success: true, message: 'Книга добавлена в маршрут' });

      } catch (error) {
        console.error('[addBookToRoute] Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
      }
    },

    async removeBookFromRoute(req: Request, res: Response) {
      try {
        const routeId = parseInt(req.params.routeId as string, 10);
        const workId  = parseInt(req.params.workId  as string, 10);
        const userId  = (req as any).user.id;

        if (isNaN(routeId) || isNaN(workId)) {
          return res.status(400).json({ error: 'Неверные параметры' });
        }

        const routeCheck = await pool.query(
          'SELECT id FROM reading_routes WHERE id = $1 AND user_id = $2',
          [routeId, userId]
        );
        if (routeCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Маршрут не найден' });
        }

        await pool.query(
          'DELETE FROM route_books WHERE route_id = $1 AND work_id = $2',
          [routeId, workId]
        );

        res.json({ success: true });
      } catch (error) {
        console.error('[removeBookFromRoute] Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
      }
    },

    async updateBookOrder(req: Request, res: Response) {
      try {
        const routeId = parseInt(req.params.routeId as string, 10);
        const userId  = (req as any).user.id;
        const { books } = req.body as { books: { bookId: number; order_index: number }[] };

        if (isNaN(routeId) || !Array.isArray(books)) {
          return res.status(400).json({ error: 'Неверные параметры' });
        }

        const routeCheck = await pool.query(
          'SELECT id FROM reading_routes WHERE id = $1 AND user_id = $2',
          [routeId, userId]
        );
        if (routeCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Маршрут не найден' });
        }

        await pool.query('BEGIN');
        for (const book of books) {
          await pool.query(
            'UPDATE route_books SET order_index = $1 WHERE route_id = $2 AND work_id = $3',
            [book.order_index, routeId, book.bookId]
          );
        }
        await pool.query('COMMIT');

        res.json({ success: true });
      } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[updateBookOrder] Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
      }
    },

  async updateBookMetadata(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const libraryId = parseInt(req.params.libraryId as string);
      if (isNaN(libraryId)) return res.status(400).json({ error: 'Неверный ID записи библиотеки' });
      const { title, authors, pages, publisher, publish_year, cover_url, language, series, description, genre, format, isbn } = req.body as {
        title?: string; authors?: string[]; pages?: any; publisher?: string;
        publish_year?: any; cover_url?: string; language?: string; series?: string; description?: string; genre?: string; format?: string; isbn?: string;
      };
      if (format !== undefined && !['physical', 'digital', 'audio'].includes(format)) {
        return res.status(400).json({ error: 'Недопустимый формат книги' });
      }

      const bookResult = await pool.query(
        `SELECT ul.edition_id,
                COALESCE(e.work_id, ul.work_id) AS work_id,
                w.author_id
         FROM user_library ul
         LEFT JOIN editions e ON ul.edition_id = e.id
         LEFT JOIN works w ON COALESCE(e.work_id, ul.work_id) = w.id
         WHERE ul.id = $1 AND ul.user_id = $2`,
        [libraryId, userId]
      );
      if (bookResult.rows.length === 0) {
        return res.status(404).json({ error: 'Книга не найдена' });
      }
      const { edition_id, work_id, author_id } = bookResult.rows[0];

      await pool.query('BEGIN');

      if (Array.isArray(authors) && authors.length > 0 && work_id) {
        await upsertWorkAuthors(work_id, authors.filter((a: string) => a?.trim()));
      }

      if (work_id && title?.trim()) {
        await pool.query('UPDATE works SET title = $1 WHERE id = $2', [title.trim(), work_id]);
      }

      {
        const ulUpdates: string[] = [];
        const ulParams: any[] = [];
        let idx = 1;
        if (description !== undefined) {
          ulUpdates.push(`custom_description = $${idx++}`);
          ulParams.push(description?.trim() || null);
        }
        if (genre !== undefined) {
          ulUpdates.push(`custom_genre = $${idx++}`);
          ulParams.push(genre?.trim() || null);
        }
        if (ulUpdates.length > 0) {
          ulParams.push(libraryId, userId);
          await pool.query(
            `UPDATE user_library SET ${ulUpdates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
            ulParams
          );
        }
      }

      if (edition_id) {
        const setClauses: string[] = [];
        const params: any[] = [];
        let idx = 1;

        if (pages !== undefined) {
          setClauses.push(`pages = $${idx++}`);
          params.push(pages ? parseInt(String(pages)) : null);
        }

        if (publisher !== undefined) {
          setClauses.push(`publisher = $${idx++}`);
          params.push(publisher?.trim() || null);
        }

        if (publish_year !== undefined) {
          setClauses.push(`publish_year = $${idx++}`);
          params.push(publish_year ? parseInt(String(publish_year)) : null);
        }

        if (cover_url !== undefined) {
          setClauses.push(`cover_url = $${idx++}`);
          params.push(cover_url?.trim() || null);
        }

        if (language !== undefined) {
          setClauses.push(`language = $${idx++}`);
          params.push(language?.trim() || 'ru');
        }

        if (series !== undefined) {
          setClauses.push(`series = $${idx++}`);
          params.push(series?.trim() || null);
        }

        if (isbn !== undefined) {
          setClauses.push(`isbn = $${idx++}`);
          params.push(isbn?.trim() || null);
        }

        if (setClauses.length > 0) {
          params.push(edition_id);
          await pool.query(
            `UPDATE editions SET ${setClauses.join(', ')} WHERE id = $${idx}`,
            params
          );
        }

        if (cover_url !== undefined) {
          await pool.query(
            'UPDATE user_library SET custom_cover_url = NULL WHERE id = $1 AND user_id = $2',
            [libraryId, userId]
          );
        }
      }

      if (format !== undefined) {
        await pool.query(
          'UPDATE user_library SET format = $1 WHERE id = $2 AND user_id = $3',
          [format, libraryId, userId]
        );
      }

      await pool.query('COMMIT');
      res.json({ success: true });
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('[updateBookMetadata] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async uploadCover(req: Request, res: Response) {
    try {
      if (!(req as any).file) {
        return res.status(400).json({ error: 'Файл не загружен' });
      }
      const file = (req as any).file as Express.Multer.File;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const coverUrl = `${baseUrl}/uploads/covers/${file.filename}`;
      res.json({ cover_url: coverUrl });
    } catch (error) {
      console.error('Ошибка загрузки обложки:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async scanCover(req: Request, res: Response) {
    const file = (req as any).file as Express.Multer.File | undefined;
    try {
      if (!file) return res.status(400).json({ error: 'Изображение не загружено' });

      const apiKey = process.env.YANDEX_API_KEY;
      const folderId = process.env.YANDEX_FOLDER_ID;
      if (!apiKey || !folderId) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(500).json({ error: 'Yandex Vision API не настроен' });
      }

      const imageBuffer = fs.readFileSync(file.path);
      const base64Image = imageBuffer.toString('base64');
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

      console.log('[CoverScan] Отправляем в Yandex Vision OCR...');
      const ocrResponse = await axios.post(
        'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText',
        {
          mimeType: file.mimetype || 'image/jpeg',
          languageCodes: ['ru', 'en'],
          model: 'page',
          content: base64Image,
        },
        {
          headers: {
            Authorization: `Api-Key ${apiKey}`,
            'x-folder-id': folderId,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );

      const fullText: string = ocrResponse.data?.result?.textAnnotation?.fullText || '';
      console.log('[CoverScan] OCR результат:', fullText.slice(0, 150));

      if (!fullText.trim()) {
        return res.json({ found: false, recognizedText: '', message: 'Текст не распознан' });
      }

      let query = fullText.replace(/\n/g, ' ').trim().slice(0, 120);
      let gptTitle: string | null = null;
      let gptAuthor: string | null = null;
      let gptSeries: string | null = null;
      try {
        console.log('[CoverScan] Отправляем в YandexGPT для извлечения названия...');
        const gptRes = await axios.post(
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
          {
            modelUri: `gpt://${folderId}/yandexgpt-lite`,
            completionOptions: { stream: false, temperature: 0.1, maxTokens: 80 },
            messages: [
              {
                role: 'system',
                text: 'Ты извлекаешь название книги и автора из текста с обложки. Отвечаешь ТОЛЬКО валидным JSON без пояснений и без markdown.',
              },
              {
                role: 'user',
                text: `Из текста с обложки книги извлеки название книги, имя автора и название серии/линейки издания. Серия — это маркетинговое название линейки (например: "Эксклюзивная классика", "Книги, изменившие мир", "Bestseller", "World Classics", "Азбука-классика", "МИФ. Прочитай это"). Серия — это НЕ название книги и НЕ имя автора. Верни JSON: {"title": "...", "author": "...", "series": "..."} — если серия не найдена, верни null для series.\n\nТекст с обложки:\n${fullText.slice(0, 500)}`,
              },
            ],
          },
          {
            headers: {
              Authorization: `Api-Key ${apiKey}`,
              'x-folder-id': folderId,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          },
        );

        const gptText: string = gptRes.data?.result?.alternatives?.[0]?.message?.text || '';
        const jsonStr = gptText.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        if (parsed.title) {
          gptTitle = parsed.title;
          gptAuthor = parsed.author || null;
          gptSeries = parsed.series || null;
          query = [parsed.title, parsed.author].filter(Boolean).join(' ');
          console.log('[CoverScan] YandexGPT извлёк:', query, '| Серия:', gptSeries);
        }
      } catch (gptErr: any) {
        console.warn('[CoverScan] YandexGPT не сработал, используем fallback:', gptErr.message);
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 2 && /[а-яёА-ЯЁa-zA-Z]{2,}/.test(l));
        query = lines.slice(0, 3).join(' ').trim().slice(0, 120);
      }

      console.log('[CoverScan] Поисковый запрос:', query);

      let bookData: any = null;

      const gbApiKey = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : '';

      const parseGoogleBook = (item: any) => {
        const info = item.volumeInfo;
        return {
          title: info.title,
          authors: info.authors || [],
          pages: info.pageCount || null,
          publisher: info.publisher || null,
          publish_year: info.publishedDate ? parseInt(info.publishedDate.split('-')[0]) : null,
          description: info.description || null,
          coverUrl: info.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
          isbn:
            info.industryIdentifiers?.find((i: any) => i.type === 'ISBN_13')?.identifier ||
            info.industryIdentifiers?.find((i: any) => i.type === 'ISBN_10')?.identifier ||
            null,
        };
      };

      const searchGoogleBooks = async (q: string, lang?: string): Promise<any> => {
        const langParam = lang ? `&langRestrict=${lang}` : '';
        const res = await axios.get(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3${langParam}${gbApiKey}`,
          { timeout: 10000 },
        );
        if (res.data?.totalItems > 0 && res.data.items?.length > 0) return parseGoogleBook(res.data.items[0]);
        return null;
      };

      const searchOpenLibrary = async (q: string): Promise<any> => {
        const olRes = await axios.get(
          `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=3&fields=title,author_name,isbn,cover_i,number_of_pages_median,publisher,first_publish_year`,
          { timeout: 15000 },
        );
        console.log('[CoverScan] Open Library нашёл:', olRes.data?.numFound);
        if (olRes.data?.numFound > 0 && olRes.data.docs?.length > 0) {
          const doc = olRes.data.docs[0];
          return {
            title: doc.title,
            authors: doc.author_name || [],
            pages: doc.number_of_pages_median || null,
            publisher: doc.publisher?.[0] || null,
            publish_year: doc.first_publish_year || null,
            description: null,
            coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
            isbn: doc.isbn?.[0] || null,
          };
        }
        return null;
      };

      const titleOnly = gptTitle || query.split(' ').slice(0, 3).join(' ');
      const queries = [query, titleOnly].filter((q, i, arr) => arr.indexOf(q) === i && q.trim());

      let google429 = false;
      for (const q of queries) {
        if (bookData || google429) break;
        try {
          bookData = await searchGoogleBooks(q, 'ru');
          if (!bookData) bookData = await searchGoogleBooks(q);
          if (bookData) console.log('[CoverScan] Google Books:', bookData.title);
        } catch (gbErr: any) {
          if (gbErr.response?.status === 429) {
            google429 = true;
            console.warn('[CoverScan] Google Books 429 — переходим к Open Library');
          } else {
            console.warn('[CoverScan] Google Books ошибка:', gbErr.message);
          }
        }
      }

      if (!bookData) {
        console.log('[CoverScan] Пробуем Open Library...');
        for (const q of queries) {
          if (bookData) break;
          try {
            bookData = await searchOpenLibrary(q);
            if (bookData) console.log('[CoverScan] Open Library:', bookData.title);
          } catch (olErr: any) {
            console.warn('[CoverScan] Open Library ошибка:', olErr.message);
          }
        }
      }

      if (!bookData) {
        return res.json({
          found: false,
          recognizedText: fullText,
          message: 'Книга не найдена',
          title: gptTitle || undefined,
          authors: gptAuthor ? [gptAuthor] : undefined,
          series: gptSeries || undefined,
        });
      }

      if (gptTitle) bookData.title = gptTitle;
      if (gptAuthor) bookData.authors = [gptAuthor];
      if (gptSeries) bookData.series = gptSeries;

      console.log('[CoverScan] Найдено:', bookData.title, '| Серия:', gptSeries);
      return res.json({ found: true, recognizedText: fullText, ...bookData });

    } catch (error: any) {
      if (file && fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch {}
      }
      console.error('[CoverScan] Ошибка:', error.response?.data || error.message);
      return res.status(500).json({ error: 'Ошибка распознавания обложки' });
    }
  },

  async getRecommendations(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const recs = await recommendationService.getRecommendations(userId);
      res.json({ recommendations: recs });
    } catch (error) {
      console.error('[getRecommendations] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async refreshRecommendations(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const recs = await recommendationService.refreshRecommendations(userId);
      res.json({ recommendations: recs });
    } catch (error) {
      console.error('[refreshRecommendations] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },
};