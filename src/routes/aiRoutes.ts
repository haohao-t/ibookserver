import express from 'express';
import { aiController } from '../controllers/aiController';
import { authMiddleware } from '../middleware/authMiddleware';
import { aiRouteService } from '../services/aiRouteService';

const router = express.Router();

router.use(authMiddleware);

router.post('/ai/generate-route', aiController.generateRoute);
router.post('/ai/save-route', aiController.saveGeneratedRoute);
router.post('/link-edition', aiController.linkEditionToAiBook);  

router.get('/:id', async (req: express.Request, res: express.Response) => {
    try {

      const routeIdParam = req.params.id;
      if (!routeIdParam || Array.isArray(routeIdParam)) {
        return res.status(400).json({ error: 'Неверный ID маршрута' });
      }
      const routeId = parseInt(routeIdParam, 10);
      
      const userId = (req as any).user?.id;
  
      if (!userId) {
        return res.status(401).json({ error: 'Требуется авторизация' });
      }
      if (isNaN(routeId)) {
        return res.status(400).json({ error: 'Неверный ID маршрута' });
      }
   
      const data = await aiRouteService.getRouteWithBooks(routeId, userId);
      
      res.json({
        route: data.route,
        books: data.books
      });
      
    } catch (error: any) {
      console.error('[Routes] Ошибка GET /:id:', error);
      
      if (error.message === 'Маршрут не найден') {
        return res.status(404).json({ error: 'Маршрут не найден' });
      }
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });


export default router;