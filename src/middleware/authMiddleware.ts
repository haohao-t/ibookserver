// book_server/src/middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Получаем заголовок Authorization
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      console.log('[Auth] ❌ Нет заголовка Authorization');
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    // Формат: "Bearer TOKEN"
    const token = authHeader.split(' ')[1];
    
    if (!token) {
      console.log('[Auth] ❌ Неверный формат токена');
      return res.status(401).json({ error: 'Неверный формат токена' });
    }

    // Проверяем токен
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: number;
      email: string;
      username: string;
      role: string;
    };

    console.log('[Auth] ✅ Пользователь из токена:', decoded.id);
    
    // Добавляем пользователя в запрос
    (req as any).user = decoded;
    
    next();
  } catch (error) {
    console.error('[Auth] ❌ Ошибка проверки токена:', error);
    
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: 'Недействительный токен' });
    }
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Токен истек' });
    }
    
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
};