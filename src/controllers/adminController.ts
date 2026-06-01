import { Request, Response } from 'express';
import pool from '../config/database';

export const adminController = {

  async getStats(req: Request, res: Response) {
    try {
      const [users, books, routes, notes, booksPerDay, usersPerDay, recentUsers] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM users'),
        pool.query('SELECT COUNT(*) FROM editions'),
        pool.query('SELECT COUNT(*) FROM reading_routes'),
        pool.query('SELECT COUNT(*) FROM book_notes'),
        pool.query(`
          SELECT TO_CHAR(ul.added_at::date, 'DD.MM') AS date, COUNT(*) AS count
          FROM user_library ul
          WHERE ul.added_at >= NOW() - INTERVAL '30 days'
          GROUP BY ul.added_at::date ORDER BY ul.added_at::date
        `),
        pool.query(`
          SELECT TO_CHAR(created_at::date, 'DD.MM') AS date, COUNT(*) AS count
          FROM users
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY created_at::date ORDER BY created_at::date
        `),
        pool.query(`
          SELECT id, username, email, created_at
          FROM users ORDER BY created_at DESC LIMIT 8
        `),
      ]);

      res.json({
        totalUsers: Number(users.rows[0].count),
        totalBooks: Number(books.rows[0].count),
        totalRoutes: Number(routes.rows[0].count),
        totalNotes: Number(notes.rows[0].count),
        booksPerDay: booksPerDay.rows.map((r: any) => ({ ...r, count: Number(r.count) })),
        usersPerDay: usersPerDay.rows.map((r: any) => ({ ...r, count: Number(r.count) })),
        recentUsers: recentUsers.rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async getUsers(req: Request, res: Response) {
    try {
      const result = await pool.query(`
        SELECT u.id, u.username, u.email, u.created_at,
               COUNT(ul.id)::int AS books_count
        FROM users u
        LEFT JOIN user_library ul ON ul.user_id = u.id
        GROUP BY u.id ORDER BY u.created_at DESC
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async deleteUser(req: Request, res: Response) {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: 'Неверный ID пользователя' });
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async getBooks(req: Request, res: Response) {
    try {
      const result = await pool.query(`
        SELECT e.id, w.title,
               STRING_AGG(DISTINCT a.full_name, ', ') AS authors,
               COUNT(DISTINCT ul.user_id)::int AS users_count
        FROM editions e
        JOIN works w ON w.id = e.work_id
        LEFT JOIN authors a ON a.id = w.author_id
        LEFT JOIN user_library ul ON ul.edition_id = e.id
        GROUP BY e.id, w.title
        ORDER BY users_count DESC, e.id DESC
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async deleteBook(req: Request, res: Response) {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: 'Неверный ID книги' });
    try {
      // Delete progress rows that would violate the CHECK constraint on SET NULL
      await pool.query(
        'DELETE FROM reading_progress WHERE edition_id = $1 AND work_id IS NULL',
        [id]
      );
      await pool.query('DELETE FROM user_library WHERE edition_id = $1', [id]);
      await pool.query('DELETE FROM editions WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async getBook(req: Request, res: Response) {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: 'Неверный ID книги' });
    try {
      const result = await pool.query(`
        SELECT e.id, w.title, w.id AS work_id,
               a.full_name AS author, a.id AS author_id,
               e.isbn, e.publisher, e.publish_year, e.pages, e.cover_url, e.language
        FROM editions e
        JOIN works w ON w.id = e.work_id
        LEFT JOIN authors a ON a.id = w.author_id
        WHERE e.id = $1
      `, [id]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Не найдено' });
      res.json(result.rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async updateBook(req: Request, res: Response) {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: 'Неверный ID книги' });
    const { title, author, pages, publisher, publish_year } = req.body;
    if (pages !== undefined && pages !== null && pages !== '') {
      const p = Number(pages);
      if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: 'pages должен быть положительным целым числом' });
    }
    if (publish_year !== undefined && publish_year !== null && publish_year !== '') {
      const y = Number(publish_year);
      if (!Number.isInteger(y) || y < 1000 || y > new Date().getFullYear() + 1) {
        return res.status(400).json({ error: 'Некорректный год издания' });
      }
    }
    try {
      const current = await pool.query(`
        SELECT e.id, w.id AS work_id, a.id AS author_id
        FROM editions e
        JOIN works w ON w.id = e.work_id
        LEFT JOIN authors a ON a.id = w.author_id
        WHERE e.id = $1
      `, [id]);

      if (!current.rows[0]) return res.status(404).json({ error: 'Не найдено' });
      const { work_id, author_id } = current.rows[0];

      if (title !== undefined) {
        await pool.query('UPDATE works SET title = $1 WHERE id = $2', [title, work_id]);
      }
      if (author !== undefined && author_id) {
        await pool.query('UPDATE authors SET full_name = $1 WHERE id = $2', [author, author_id]);
      }

      await pool.query(
        `UPDATE editions SET pages = $1, publisher = $2, publish_year = $3 WHERE id = $4`,
        [pages || null, publisher || null, publish_year || null, id]
      );

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async getDetailedStats(req: Request, res: Response) {
    try {
      const [statusDist, topBooks, addedVia] = await Promise.all([
        pool.query(`
          SELECT status, COUNT(*) AS count
          FROM reading_progress GROUP BY status
        `),
        pool.query(`
          SELECT w.title, STRING_AGG(DISTINCT a.full_name, ', ') AS authors,
                 COUNT(ul.id)::int AS count
          FROM user_library ul
          LEFT JOIN editions e ON e.id = ul.edition_id
          JOIN works w ON w.id = COALESCE(e.work_id, ul.work_id)
          LEFT JOIN authors a ON a.id = w.author_id
          GROUP BY w.title ORDER BY count DESC LIMIT 10
        `),
        pool.query(`
          SELECT added_via AS via, COUNT(*)::int AS count
          FROM user_library GROUP BY added_via ORDER BY count DESC
        `),
      ]);

      res.json({
        statusDistribution: statusDist.rows,
        topBooks: topBooks.rows,
        addedVia: addedVia.rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
};
