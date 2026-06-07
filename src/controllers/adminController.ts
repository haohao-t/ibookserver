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
        SELECT u.id, u.username, u.email, u.created_at, u.birth_year,
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

  async updateUser(req: Request, res: Response) {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: 'Неверный ID пользователя' });
    const { birth_year } = req.body;
    try {
      await pool.query('UPDATE users SET birth_year = $1 WHERE id = $2', [birth_year ?? null, id]);
      res.json({ success: true });
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

  async getAnalytics(req: Request, res: Response) {
    const safeQuery = async (label: string, sql: string, params: any[] = []) => {
      try {
        const r = await pool.query(sql, params);
        return r;
      } catch (err: any) {
        console.error(`[analytics] Ошибка запроса "${label}":`, err.message);
        return { rows: [] };
      }
    };

    const [genreStats, authorStats] = await Promise.all([
      safeQuery('genreStats', `
        SELECT COALESCE(ul.custom_genre, w.genre) AS genre,
               COUNT(DISTINCT ul.user_id)::int AS readers,
               COUNT(*)::int AS entries
        FROM user_library ul
        LEFT JOIN editions e ON e.id = ul.edition_id
        JOIN works w ON w.id = COALESCE(e.work_id, ul.work_id)
        WHERE COALESCE(ul.custom_genre, w.genre) IS NOT NULL
          AND COALESCE(ul.custom_genre, w.genre) <> ''
        GROUP BY 1 ORDER BY readers DESC LIMIT 12
      `),
      safeQuery('authorStats', `
        SELECT a.full_name AS author, COUNT(DISTINCT ul.user_id)::int AS readers
        FROM user_library ul
        LEFT JOIN editions e ON e.id = ul.edition_id
        JOIN works w ON w.id = COALESCE(e.work_id, ul.work_id)
        JOIN authors a ON a.id = w.author_id
        WHERE a.full_name NOT IN ('Неизвестный автор', 'Unknown Author')
        GROUP BY a.full_name ORDER BY readers DESC LIMIT 10
      `),
    ]);

    const [formatStats, languageStats] = await Promise.all([
      safeQuery('formatStats', `
        SELECT COALESCE(format, 'physical') AS format, COUNT(*)::int AS count
        FROM user_library GROUP BY 1 ORDER BY count DESC
      `),
      safeQuery('languageStats', `
        SELECT COALESCE(e.language, 'ru') AS language,
               COUNT(DISTINCT ul.user_id)::int AS readers
        FROM user_library ul
        JOIN editions e ON e.id = ul.edition_id
        WHERE e.language IS NOT NULL AND e.language <> ''
        GROUP BY e.language ORDER BY readers DESC LIMIT 8
      `),
    ]);

    const [ratingStats, routeStats] = await Promise.all([
      safeQuery('ratingStats', `
        SELECT user_rating::int AS rating, COUNT(*)::int AS count
        FROM reading_progress
        WHERE user_rating IS NOT NULL
        GROUP BY user_rating ORDER BY user_rating
      `),
      safeQuery('routeStats', `
        SELECT status, COUNT(*)::int AS count FROM reading_routes GROUP BY status
      `),
    ]);

    const [activeUsers, avgLibrarySize] = await Promise.all([
      safeQuery('activeUsers', `
        SELECT
          COUNT(DISTINCT CASE WHEN added_at >= NOW() - INTERVAL '7 days'  THEN user_id END)::int AS active_7d,
          COUNT(DISTINCT CASE WHEN added_at >= NOW() - INTERVAL '30 days' THEN user_id END)::int AS active_30d
        FROM user_library
      `),
      safeQuery('avgLibrarySize', `
        SELECT ROUND(AVG(cnt)::numeric, 1) AS avg_books
        FROM (SELECT COUNT(*) AS cnt FROM user_library GROUP BY user_id) t
      `),
    ]);

    const [notesStats, goalStats] = await Promise.all([
      safeQuery('notesStats', `
        SELECT
          COUNT(DISTINCT ul.user_id)::int AS users_with_notes,
          COUNT(*)::int AS total_notes,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT ul.user_id), 0), 1) AS avg_per_user
        FROM book_notes bn
        JOIN user_library ul ON ul.id = bn.user_library_id
      `),
      safeQuery('goalStats', `
        SELECT
          CASE
            WHEN reading_goal_pages < 20  THEN '< 20'
            WHEN reading_goal_pages < 50  THEN '20–49'
            WHEN reading_goal_pages < 100 THEN '50–99'
            ELSE '100+'
          END AS bracket,
          COUNT(*)::int AS count
        FROM users
        WHERE reading_goal_pages IS NOT NULL
        GROUP BY 1 ORDER BY MIN(reading_goal_pages)
      `),
    ]);

    const [statusDist, addedVia] = await Promise.all([
      safeQuery('statusDist', `
        SELECT status, COUNT(*)::int AS count FROM reading_progress GROUP BY status
      `),
      safeQuery('addedVia', `
        SELECT added_via AS via, COUNT(*)::int AS count
        FROM user_library GROUP BY added_via ORDER BY count DESC
      `),
    ]);

    const topBooks = await safeQuery('topBooks', `
      SELECT w.title,
             COALESCE(
               (SELECT STRING_AGG(a2.full_name, ', ' ORDER BY wa.sort_order)
                FROM work_authors wa JOIN authors a2 ON a2.id = wa.author_id
                WHERE wa.work_id = w.id),
               a.full_name
             ) AS authors,
             COUNT(ul.id)::int AS count
      FROM user_library ul
      LEFT JOIN editions e ON e.id = ul.edition_id
      JOIN works w ON w.id = COALESCE(e.work_id, ul.work_id)
      LEFT JOIN authors a ON a.id = w.author_id
      GROUP BY w.id, w.title, a.full_name
      ORDER BY count DESC LIMIT 10
    `);

    const ageGroupStats = await safeQuery('ageGroupStats', `
      WITH grp AS (
        SELECT
          CASE
            WHEN birth_year IS NULL                                      THEN 'Не указан'
            WHEN EXTRACT(YEAR FROM NOW()) - birth_year < 18              THEN 'до 18'
            WHEN EXTRACT(YEAR FROM NOW()) - birth_year BETWEEN 18 AND 25 THEN '18-25'
            WHEN EXTRACT(YEAR FROM NOW()) - birth_year BETWEEN 26 AND 35 THEN '26-35'
            WHEN EXTRACT(YEAR FROM NOW()) - birth_year BETWEEN 36 AND 50 THEN '36-50'
            ELSE '50+'
          END AS age_group,
          COUNT(*)::int AS cnt
        FROM users
        GROUP BY 1
      )
      SELECT age_group, cnt AS count
      FROM grp
      ORDER BY
        CASE WHEN age_group = 'до 18' THEN 1
             WHEN age_group = '18-25'  THEN 2
             WHEN age_group = '26-35'  THEN 3
             WHEN age_group = '36-50'  THEN 4
             WHEN age_group = '50+'    THEN 5
             ELSE 6
        END
    `);

    const ageGenreMatrix = await safeQuery('ageGenreMatrix', `
      WITH ag AS (
        SELECT
          CASE
            WHEN u.birth_year IS NULL                                      THEN 'Не указан'
            WHEN EXTRACT(YEAR FROM NOW()) - u.birth_year < 18              THEN 'до 18'
            WHEN EXTRACT(YEAR FROM NOW()) - u.birth_year BETWEEN 18 AND 25 THEN '18-25'
            WHEN EXTRACT(YEAR FROM NOW()) - u.birth_year BETWEEN 26 AND 35 THEN '26-35'
            WHEN EXTRACT(YEAR FROM NOW()) - u.birth_year BETWEEN 36 AND 50 THEN '36-50'
            ELSE '50+'
          END AS age_group,
          COALESCE(ul.custom_genre, w.genre) AS genre,
          COUNT(*)::int AS cnt
        FROM users u
        JOIN user_library ul ON ul.user_id = u.id
        LEFT JOIN editions e ON e.id = ul.edition_id
        JOIN works w ON w.id = COALESCE(e.work_id, ul.work_id)
        WHERE COALESCE(ul.custom_genre, w.genre) IS NOT NULL
          AND COALESCE(ul.custom_genre, w.genre) <> ''
        GROUP BY 1, 2
      ),
      ranked AS (
        SELECT *, RANK() OVER (PARTITION BY age_group ORDER BY cnt DESC) AS rnk FROM ag
      )
      SELECT age_group, genre, cnt AS count FROM ranked WHERE rnk <= 5
      ORDER BY
        CASE WHEN age_group = 'до 18' THEN 1
             WHEN age_group = '18-25'  THEN 2
             WHEN age_group = '26-35'  THEN 3
             WHEN age_group = '36-50'  THEN 4
             WHEN age_group = '50+'    THEN 5
             ELSE 6
        END, cnt DESC
    `);

    console.log('[analytics] ageGroupStats:', JSON.stringify(ageGroupStats.rows));
    console.log('[analytics] OK — данные собраны');

    res.json({
      genreStats:         genreStats.rows,
      authorStats:        authorStats.rows,
      formatStats:        formatStats.rows,
      languageStats:      languageStats.rows,
      ratingStats:        ratingStats.rows,
      routeStats:         routeStats.rows,
      activeUsers:        activeUsers.rows[0] ?? { active_7d: 0, active_30d: 0 },
      avgLibrarySize:     Number(avgLibrarySize.rows[0]?.avg_books ?? 0),
      notesStats:         notesStats.rows[0] ?? { users_with_notes: 0, total_notes: 0, avg_per_user: '0' },
      goalStats:          goalStats.rows,
      ageGroupStats:      ageGroupStats.rows,
      ageGenreMatrix:     ageGenreMatrix.rows,
      statusDistribution: statusDist.rows,
      addedVia:           addedVia.rows,
      topBooks:           topBooks.rows,
    });
  },
};
