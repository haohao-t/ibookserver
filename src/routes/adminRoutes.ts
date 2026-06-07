import { Router, Request, Response, NextFunction } from 'express';
import { adminController } from '../controllers/adminController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Нет прав администратора' });
  next();
};

router.use(authMiddleware, adminOnly);

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.patch('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.get('/books', adminController.getBooks);
router.get('/books/:id', adminController.getBook);
router.patch('/books/:id', adminController.updateBook);
router.delete('/books/:id', adminController.deleteBook);
router.get('/detailed-stats', adminController.getDetailedStats);
router.get('/analytics', adminController.getAnalytics);

export default router;
