import dotenv from 'dotenv';
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/database';
import { sendEmailVerificationCode, sendPasswordResetCode } from '../services/emailService';

interface EmailChangeEntry {
  newEmail: string;
  code: string;
  expiresAt: number;
}
const pendingEmailChanges = new Map<number, EmailChangeEntry>();

interface PasswordResetEntry {
  code: string;
  expiresAt: number;
}
const pendingPasswordResets = new Map<string, PasswordResetEntry>();

dotenv.config();

const log = {
  info: (msg: string) => console.log(msg),
  success: (msg: string) => console.log('✅', msg),
  warn: (msg: string) => console.log(msg),
  error: (msg: string, err?: any) => console.log('❌', msg, err?.message || ''),
  debug: (msg: string) => console.log(msg)
};

if (!process.env.JWT_SECRET) {
  log.error('JWT_SECRET не задан в .env!');
  process.exit(1);
}

export const authController = {
  async register(req: Request, res: Response) {
    try {
      log.info('Регистрация: ' + req.body.email);

      const { email, username, password, avatar_emoji } = req.body;
      const finalAvatar = avatar_emoji || '🌿';

      if (!email || !username || !password) {
        log.warn('Не все поля заполнены');
        return res.status(400).json({ error: 'Все поля обязательны' });
      }

      if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,10}$/.test(email.trim())) {
        log.warn('Неверный формат email');
        return res.status(400).json({ error: 'Неверный формат email' });
      }

      const trimmedUsername = username.trim();
      if (trimmedUsername.length < 3 || trimmedUsername.length > 30) {
        return res.status(400).json({ error: 'Имя пользователя: от 3 до 30 символов' });
      }
      if (!/^[a-zA-Zа-яёА-ЯЁ0-9_]+$/.test(trimmedUsername)) {
        return res.status(400).json({ error: 'Имя пользователя: только буквы, цифры и _' });
      }

      if (password.length < 6) {
        log.warn('Короткий пароль');
        return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
      }

      const existingEmail = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [email.trim()]
      );
      if (existingEmail.rows.length > 0) {
        return res.status(400).json({ error: 'Этот email уже зарегистрирован' });
      }

      const existingUsername = await pool.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
        [trimmedUsername]
      );
      if (existingUsername.rows.length > 0) {
        return res.status(400).json({ error: 'Это имя пользователя уже занято' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const newUser = await pool.query(
        `INSERT INTO users (email, username, password_hash, role, reading_goal_pages, avatar_emoji)
         VALUES ($1, $2, $3, 'reader', 30, $4)
         RETURNING id, email, username, role, avatar_emoji`,
        [email.trim().toLowerCase(), trimmedUsername, passwordHash, finalAvatar]
      );

      const user = newUser.rows[0];

      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '30d' }
      );

      log.success('Регистрация успешна: ' + user.email);

      res.status(201).json({
        message: 'Регистрация успешна',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          avatar_emoji: user.avatar_emoji
        }
      });

    } catch (error: any) {
      log.error('Ошибка регистрации:', error);
      if (error.code === '23514') {
        return res.status(400).json({ error: 'Неверный формат email' });
      }
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Email или username уже используется' });
      }
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async login(req: Request, res: Response) {
    try {
      log.info('Вход: ' + req.body.nameOrEmail);

      const { nameOrEmail, password } = req.body;

      if (!nameOrEmail || !password) {
        log.warn('Не все поля заполнены');
        return res.status(400).json({ error: 'Все поля обязательны' });
      }

      const userResult = await pool.query(
        'SELECT * FROM users WHERE email = $1 OR username = $1',
        [nameOrEmail]
      );

      if (userResult.rows.length === 0) {
        log.warn('Пользователь не найден: ' + nameOrEmail);
        return res.status(401).json({ error: 'Неверный email или пароль' });
      }

      const user = userResult.rows[0];

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        log.warn('Неверный пароль для: ' + nameOrEmail);
        return res.status(401).json({ error: 'Неверный email или пароль' });
      }

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
          role: user.role,
          avatar_emoji: user.avatar_emoji,
          reading_goal_pages: user.reading_goal_pages
        }
      });

    } catch (error: any) {
      log.error('Ошибка входа:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async getMe(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      log.info('Запрос данных пользователя: ' + userId);

      const userResult = await pool.query(
        `SELECT id, email, username, role, reading_goal_pages, avatar_emoji, created_at, birth_year
         FROM users WHERE id = $1`,
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
  },

  async updateAvatar(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { avatar_emoji } = req.body;

      if (!avatar_emoji || typeof avatar_emoji !== 'string' || avatar_emoji.trim().length === 0) {
        return res.status(400).json({ error: 'Аватар не может быть пустым' });
      }

      if ([...avatar_emoji].length > 10) {
        return res.status(400).json({ error: 'Некорректный аватар' });
      }

      const trimmedEmoji = avatar_emoji.trim();

      await pool.query(
        'UPDATE users SET avatar_emoji = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [trimmedEmoji, userId]
      );

      res.json({ success: true, avatar_emoji: trimmedEmoji });
    } catch (error) {
      console.error('Ошибка обновления аватара:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async updateReadingGoal(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { reading_goal_pages } = req.body;

      const goal = Number(reading_goal_pages);
      if (!reading_goal_pages || !Number.isInteger(goal) || goal < 1) {
        return res.status(400).json({ error: 'Цель должна быть числом больше 0' });
      }
      if (goal > 1000) {
        return res.status(400).json({ error: 'Цель не может превышать 1000 страниц в день' });
      }

      await pool.query(
        'UPDATE users SET reading_goal_pages = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [reading_goal_pages, userId]
      );

      res.json({ success: true, reading_goal_pages });
    } catch (error) {
      console.error('Ошибка обновления цели:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async updateUsername(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { username } = req.body;

      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Имя пользователя обязательно' });
      }

      const trimmed = username.trim();

      if (trimmed.length < 3) {
        return res.status(400).json({ error: 'Минимум 3 символа' });
      }
      if (trimmed.length > 30) {
        return res.status(400).json({ error: 'Максимум 30 символов' });
      }
      if (!/^[a-zA-Zа-яёА-ЯЁ0-9_]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'Только буквы, цифры и символ _' });
      }

      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2',
        [trimmed, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Это имя уже занято' });
      }

      await pool.query(
        'UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [trimmed, userId]
      );

      log.success(`Имя обновлено: ${trimmed}`);
      res.json({ success: true, username: trimmed });
    } catch (error) {
      console.error('Ошибка обновления имени:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async updateBirthYear(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { birth_year } = req.body;

      if (birth_year === null || birth_year === undefined) {
        await pool.query('UPDATE users SET birth_year = NULL WHERE id = $1', [userId]);
        return res.json({ success: true, birth_year: null });
      }

      const year = parseInt(birth_year, 10);
      const currentYear = new Date().getFullYear();
      if (isNaN(year) || year < 1900 || year > currentYear - 5) {
        return res.status(400).json({ error: 'Некорректный год рождения' });
      }

      await pool.query('UPDATE users SET birth_year = $1 WHERE id = $2', [year, userId]);
      res.json({ success: true, birth_year: year });
    } catch (error) {
      console.error('Ошибка обновления года рождения:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async requestEmailChange(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { newEmail } = req.body;

      if (!newEmail || typeof newEmail !== 'string') {
        return res.status(400).json({ error: 'Email обязателен' });
      }

      const email = newEmail.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Некорректный email' });
      }

      const currentUser = await pool.query(
        'SELECT email, username FROM users WHERE id = $1',
        [userId]
      );
      if (!currentUser.rows.length) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      if (currentUser.rows[0].email.toLowerCase() === email) {
        return res.status(400).json({ error: 'Это уже ваш текущий email' });
      }

      const taken = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = $1',
        [email]
      );
      if (taken.rows.length > 0) {
        return res.status(400).json({ error: 'Этот email уже используется' });
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString();

      pendingEmailChanges.set(userId, {
        newEmail: email,
        code,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      await sendEmailVerificationCode(email, code, currentUser.rows[0].username);

      log.success(`Код смены email отправлен для userId=${userId}`);
      res.json({ success: true, message: 'Код отправлен на новый email' });
    } catch (error) {
      console.error('Ошибка запроса смены email:', error);
      res.status(500).json({ error: 'Не удалось отправить код. Проверьте email' });
    }
  },

  async confirmEmailChange(req: Request, res: Response) {
    try {
      const userId = (req as any).user.id;
      const { code } = req.body;

      if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Код обязателен' });
      }

      const entry = pendingEmailChanges.get(userId);
      if (!entry) {
        return res.status(400).json({ error: 'Запрос не найден. Запросите код заново' });
      }

      if (Date.now() > entry.expiresAt) {
        pendingEmailChanges.delete(userId);
        return res.status(400).json({ error: 'Код истёк. Запросите новый' });
      }

      if (entry.code !== code.trim()) {
        return res.status(400).json({ error: 'Неверный код' });
      }

      await pool.query(
        'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [entry.newEmail, userId]
      );

      pendingEmailChanges.delete(userId);

      log.success(`Email обновлён для userId=${userId}: ${entry.newEmail}`);
      res.json({ success: true, email: entry.newEmail });
    } catch (error) {
      console.error('Ошибка подтверждения email:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async forgotPassword(req: Request, res: Response) {
    try {
      const { email } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email обязателен' });
      }

      const trimmedEmail = email.trim().toLowerCase();

      const userResult = await pool.query(
        'SELECT id, username FROM users WHERE LOWER(email) = $1',
        [trimmedEmail]
      );

      if (userResult.rows.length === 0) {
        return res.json({ success: true, message: 'Если email зарегистрирован, код будет отправлен' });
      }

      const user = userResult.rows[0];
      const code = Math.floor(100000 + Math.random() * 900000).toString();

      pendingPasswordResets.set(trimmedEmail, {
        code,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      await sendPasswordResetCode(trimmedEmail, code, user.username);

      log.success(`Код сброса пароля отправлен для ${trimmedEmail}`);
      res.json({ success: true, message: 'Если email зарегистрирован, код будет отправлен' });
    } catch (error) {
      console.error('Ошибка forgot password:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },

  async resetPassword(req: Request, res: Response) {
    try {
      const { email, code, newPassword } = req.body;

      if (!email || !code || !newPassword) {
        return res.status(400).json({ error: 'Все поля обязательны' });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
      }

      const trimmedEmail = email.trim().toLowerCase();
      const entry = pendingPasswordResets.get(trimmedEmail);

      if (!entry) {
        return res.status(400).json({ error: 'Запрос не найден. Запросите код заново' });
      }

      if (Date.now() > entry.expiresAt) {
        pendingPasswordResets.delete(trimmedEmail);
        return res.status(400).json({ error: 'Код истёк. Запросите новый' });
      }

      if (entry.code !== code.trim()) {
        return res.status(400).json({ error: 'Неверный код' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = $2',
        [passwordHash, trimmedEmail]
      );

      pendingPasswordResets.delete(trimmedEmail);

      log.success(`Пароль сброшен для ${trimmedEmail}`);
      res.json({ success: true, message: 'Пароль успешно изменён' });
    } catch (error) {
      console.error('Ошибка reset password:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  },
};
