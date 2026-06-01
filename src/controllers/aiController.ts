import { Request, Response } from 'express';
import { aiRouteService } from '../services/aiRouteService';
import pool from '../config/database';

export const aiController = {
  async generateRoute(req: Request, res: Response) {
    console.log('\n🤖 [AI Controller] ========== ГЕНЕРАЦИЯ МАРШРУТА ==========');
    
    try {
      const userId = (req as any).user.id;
      const { query } = req.body;

      if (!query || query.trim() === '') {
        return res.status(400).json({ error: 'Введите запрос для создания маршрута' });
      }

      // Используем YandexGPT вместо OpenAI
      const route = await aiRouteService.generateReadingRoute(query);

      if (!route) {
        return res.status(500).json({ 
          success: false, 
          error: 'Не удалось сгенерировать маршрут. Попробуйте изменить запрос.' 
        });
      }

      res.json({
        success: true,
        route: {
          name: route.name,
          description: route.description,
          books: route.books
        }
      });

    } catch (error) {
      console.error('🤖 [AI Controller] Ошибка:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },
 
  async saveGeneratedRoute(req: Request, res: Response) {
    console.log('\n🤖 [AI Controller] ========== СОХРАНЕНИЕ МАРШРУТА ==========');
  
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
  
      // СОЗДАЕМ МАРШРУТ
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
        VALUES ($1, $2, $3, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
        `,
        [
          userId,
          name,
          description || null
        ]
      );
  
      const routeId = routeResult.rows[0].id;
  
      console.log(`✅ Маршрут создан: ${routeId}`);
  
      // ДОБАВЛЯЕМ КНИГИ
      for (let i = 0; i < books.length; i++) {
        const book = books[i];
  
        console.log(`📚 Книга ${i + 1}: ${book.title}`);
  
        // СОЗДАЕМ/ИЩЕМ WORK
        const workId = await aiRouteService.findOrCreateWork(
          book.title,
          book.author
        );
  
        if (!workId) {
          console.log(`❌ Не удалось создать work`);
          continue;
        }
  
        // СОЗДАЕМ AI BOOK
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
  
        console.log(`✅ AI BOOK создан`);
  
        // ДОБАВЛЯЕМ В ROUTE_BOOKS
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
  
        console.log(`✅ route_books создан`);
      }
  
      await pool.query('COMMIT');
  
      return res.json({
        success: true,
        routeId
      });
  
    } catch (error) {
  
      await pool.query('ROLLBACK');
  
      console.error('❌ saveGeneratedRoute ERROR:', error);
  
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
      
        -- берем только одно издание
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
      console.error('🤖 [AI Controller] Ошибка получения маршрута:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },
  async linkEditionToAiBook(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { aiBookId, editionId } = req.body;
      
      // Проверка прав: маршрут принадлежит пользователю
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
      
      // Привязываем издание к рекомендации
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