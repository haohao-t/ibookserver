import { Router } from 'express';
import { authController } from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// Публичные маршруты (не требуют авторизации)
router.post('/register', authController.register);
router.post('/login', authController.login);

// Защищённый маршрут (требуется токен)
router.get('/me', authMiddleware, authController.getMe);

export default router;