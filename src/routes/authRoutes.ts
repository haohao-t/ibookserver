import { Router } from 'express';
import { authController } from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get('/me', authMiddleware, authController.getMe);
router.patch('/me/avatar', authMiddleware, authController.updateAvatar);
router.patch('/me/goal', authMiddleware, authController.updateReadingGoal);
router.patch('/me/username', authMiddleware, authController.updateUsername);
router.post('/me/email/request', authMiddleware, authController.requestEmailChange);
router.post('/me/email/confirm', authMiddleware, authController.confirmEmailChange);

export default router;