import { Request, Response } from 'express';
import { aiRouteService } from '../services/aiRouteService';
import pool from '../config/database';

export const aiController = {
  async generateRoute(req: Request, res: Response) {
    console.log('\n[AI Controller] ========== ГЕНЕРАЦИЯ МАРШРУТА ==========');

    try {
      const userId = (req as any).user.id;
      const { query } = req.body;

      if (!query || query.trim() === '') {
        return res.status(400).json({ error: 'Введите запрос для создания маршрута' });
      }

      const userBooksRes = await pool.query(`
        SELECT w.title, a.full_name AS author, w.genre, rp.user_rating
        FROM user_library ul
        JOIN editions e ON ul.edition_id = e.id
        JOIN works w ON e.work_id = w.id
        JOIN authors a ON w.author_id = a.id
        LEFT JOIN reading_progress rp ON rp.user_id = $1
          AND (rp.edition_id = ul.edition_id OR rp.work_id = e.work_id)
        WHERE ul.user_id = $1 AND w.title IS NOT NULL
        LIMIT 30
      `, [userId]);

      const readBooks = userBooksRes.rows.map((r: any) => `«${r.title}» (${r.author})`);
      const genreCounts: Record<string, number> = {};
      const authorCounts: Record<string, number> = {};
      userBooksRes.rows.forEach((r: any) => {
        if (r.genre) genreCounts[r.genre] = (genreCounts[r.genre] || 0) + 1;
        if (r.author) authorCounts[r.author] = (authorCounts[r.author] || 0) + 1;
      });
      const favoriteGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
      const favoriteAuthors = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);

      const userInfoRes = await pool.query('SELECT birth_year FROM users WHERE id = $1', [userId]);
      const birthYear: number | null = userInfoRes.rows[0]?.birth_year ?? null;
      const userAge = birthYear ? new Date().getFullYear() - birthYear : null;

      const result = await aiRouteService.generateReadingRoute(query, { readBooks, favoriteGenres, favoriteAuthors, userAge });

      if (!result.ok) {
        const errorMessages: Record<string, string> = {
          not_related: 'Запрос не связан с книгами или чтением. Попробуйте уточнить: укажите жанр, автора, тему или цель чтения.',
          no_books: 'Не удалось подобрать книги по этому запросу. Уточните тему или попробуйте более широкую формулировку.',
          ai_error: 'Не удалось составить маршрут. Попробуйте ещё раз или измените запрос.',
        };
        return res.status(422).json({
          success: false,
          userError: true,
          errorCode: result.errorCode,
          error: errorMessages[result.errorCode],
        });
      }

      res.json({
        success: true,
        route: {
          name: result.route.name,
          description: result.route.description,
          books: result.route.books,
        },
      });

    } catch (error) {
      console.error('[AI Controller] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async saveGeneratedRoute(req: Request, res: Response) {
    console.log('\n[AI Controller] ========== СОХРАНЕНИЕ МАРШРУТА ==========');

    try {
      const userId = (req as any).user.id;
      const { name, description, books } = req.body;

      if (!name || !books || books.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Недостаточно данных'
        });
      }

      await pool.query('BEGIN');

      const routeResult = await pool.query(
        `
        INSERT INTO reading_routes (
          user_id,
          name,
          description,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
        `,
        [
          userId,
          name,
          description || null
        ]
      );

      const routeId = routeResult.rows[0].id;

      console.log(`Маршрут создан: ${routeId}`);

      for (let i = 0; i < books.length; i++) {
        const book = books[i];

        console.log(`Книга ${i + 1}: ${book.title}`);

        const workId = await aiRouteService.findOrCreateWork(
          book.title,
          book.author
        );

        if (!workId) {
          console.log(`Не удалось создать work`);
          continue;
        }

        const aiBookResult = await pool.query(
          `
          INSERT INTO ai_books (
            work_id,
            route_id,
            order_index,
            created_at
          )
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          RETURNING id
          `,
          [
            workId,
            routeId,
            i
          ]
        );

        console.log(`AI BOOK создан`);

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
            i
          ]
        );

        console.log(`route_books создан`);
      }

      await pool.query('COMMIT');

      return res.json({
        success: true,
        routeId
      });

    } catch (error) {

      await pool.query('ROLLBACK');

      console.error('saveGeneratedRoute ERROR:', error);

      return res.status(500).json({
        success: false,
        error: 'Ошибка сохранения маршрута'
      });
    }
  },

  async getRouteWithBooks(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { routeId } = req.params;

      const routeResult = await pool.query(
        `SELECT * FROM reading_routes
         WHERE id = $1 AND user_id = $2`,
        [routeId, userId]
      );

      if (routeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Маршрут не найден' });
      }

      const booksResult = await pool.query(
        `
        SELECT
          rb.id,
          rb.order_index,
          w.id as book_id,
          w.title,
          a.full_name as author,

          ed.id as edition_id,
          ed.pages as total_pages,
          ed.cover_url,

          COALESCE(rp.current_page, 0) as current_page,
          COALESCE(rp.status, 'want_to_read') as status

        FROM route_books rb

        JOIN works w
          ON rb.work_id = w.id

        LEFT JOIN authors a
          ON w.author_id = a.id

        LEFT JOIN LATERAL (
          SELECT *
          FROM editions e
          WHERE e.work_id = w.id
          ORDER BY e.id ASC
          LIMIT 1
        ) ed ON true

        LEFT JOIN reading_progress rp
          ON rp.edition_id = ed.id
          AND rp.user_id = $2

        WHERE rb.route_id = $1

        ORDER BY rb.order_index
        `,
        [routeId, userId]
      );

      const route = routeResult.rows[0];
      route.books = booksResult.rows;

      res.json({
        success: true,
        route: route
      });

    } catch (error) {
      console.error('[AI Controller] Ошибка получения маршрута:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async linkEditionToAiBook(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { aiBookId, editionId } = req.body;

      const check = await pool.query(
        `SELECT r.user_id
         FROM ai_books ab
         JOIN reading_routes r ON ab.route_id = r.id
         WHERE ab.id = $1`,
        [aiBookId]
      );

      if (check.rows.length === 0 || check.rows[0].user_id !== userId) {
        return res.status(403).json({ error: 'Доступ запрещён' });
      }

      await pool.query(
        `INSERT INTO ai_to_real_editions (ai_book_id, edition_id)
         VALUES ($1, $2)
         ON CONFLICT (ai_book_id) DO UPDATE
         SET edition_id = EXCLUDED.edition_id, replaced_at = CURRENT_TIMESTAMP`,
        [aiBookId, editionId]
      );

      res.json({ success: true, message: 'Издание привязано к рекомендации' });

    } catch (error) {
      console.error('[linkEditionToAiBook] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
};
