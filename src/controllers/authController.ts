import dotenv from 'dotenv';
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/database';

dotenv.config();

// ============= ПРОСТЕЙШИЙ ЛОГГЕР =============
// Просто console.log с эмодзи, ничего больше!
const log = {
  info: (msg: string) => console.log('📝', msg),
  success: (msg: string) => console.log('✅', msg),
  warn: (msg: string) => console.log('⚠️', msg),
  error: (msg: string, err?: any) => console.log('❌', msg, err?.message || ''),
  debug: (msg: string) => console.log('🔍', msg)
};
// ============================================

// Проверка JWT_SECRET
if (!process.env.JWT_SECRET) {
  log.error('JWT_SECRET не задан в .env!');
  process.exit(1);
}

export const authController = {
  // РЕГИСТРАЦИЯ
  async register(req: Request, res: Response) {
    try {
      log.info('Регистрация: ' + req.body.email);
      
      const { email, username, password } = req.body;

      // Простые проверки
      if (!email || !username || !password) {
        log.warn('Не все поля заполнены');
        return res.status(400).json({ error: 'Все поля обязательны' });
      }

      if (password.length < 6) {
        log.warn('Короткий пароль');
        return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
      }

      // Проверка существующего пользователя
      const existingUser = await pool.query(
        'SELECT * FROM users WHERE email = $1 OR username = $2',
        [email, username]
      );

      if (existingUser.rows.length > 0) {
        log.warn('Пользователь уже существует');
        return res.status(400).json({ error: 'Email или username уже используется' });
      }

      // Создание пользователя
      const passwordHash = await bcrypt.hash(password, 10);
      
      const newUser = await pool.query(
        `INSERT INTO users (email, username, password_hash, role, reading_goal_pages) 
         VALUES ($1, $2, $3, 'reader', 30) 
         RETURNING id, email, username, role`,
        [email, username, passwordHash]
      );

      const user = newUser.rows[0];

      // Токен
      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '30d' }
      );

      log.success('Регистрация успешна: ' + user.email);
      
      res.status(201).json({
        message: 'Регистрация успешна',
        token,
        user
      });

    } catch (error: any) {
      log.error('Ошибка регистрации:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // ВХОД
  async login(req: Request, res: Response) {
    try {
      log.info('Вход: ' + req.body.nameOrEmail);
      
      const { nameOrEmail, password } = req.body;

      if (!nameOrEmail || !password) {
        log.warn('Не все поля заполнены');
        return res.status(400).json({ error: 'Все поля обязательны' });
      }

      // Поиск пользователя
      const userResult = await pool.query(
        'SELECT * FROM users WHERE email = $1 OR username = $1',
        [nameOrEmail]
      );

      if (userResult.rows.length === 0) {
        log.warn('Пользователь не найден: ' + nameOrEmail);
        return res.status(401).json({ error: 'Неверный email или пароль' });
      }

      const user = userResult.rows[0];

      // Проверка пароля
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        log.warn('Неверный пароль для: ' + nameOrEmail);
        return res.status(401).json({ error: 'Неверный email или пароль' });
      }

      // Обновляем время входа
      await pool.query(
        'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );

      // Токен
      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '30d' }
      );

      log.success('Вход выполнен: ' + user.email);
      
      res.json({
        message: 'Вход выполнен успешно',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role
        }
      });

    } catch (error: any) {
      log.error('Ошибка входа:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  // ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ
  async getMe(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      log.info('Запрос данных пользователя: ' + userId);

      const userResult = await pool.query(
        'SELECT id, email, username, role, reading_goal_pages, created_at, last_login_at FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        log.warn('Пользователь не найден: ' + userId);
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      log.success('Данные отправлены');
      res.json(userResult.rows[0]);

    } catch (error: any) {
      log.error('Ошибка получения пользователя:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
};