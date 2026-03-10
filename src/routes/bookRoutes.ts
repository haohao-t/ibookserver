import { Router } from 'express';
import { bookController } from '../controllers/bookController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.use(authMiddleware);

// Существующие маршруты
router.get('/', bookController.getUserBooks);
router.post('/isbn', bookController.addBookByISBN);
router.put('/:bookId/progress', bookController.updateProgress);
router.get('/:bookId/notes', bookController.getNotes);
router.post('/:bookId/notes', bookController.addNote);
router.get('/collections', bookController.getCollections);
router.post('/collections', bookController.createCollection);
router.post('/collections/add-book', bookController.addBookToCollection);
router.get('/stats', bookController.getReadingStats);
router.get('/history', bookController.getReadingHistory);
router.get('/search/isbn/:isbn', bookController.searchBookByISBN);
router.get('/collections/:id', bookController.getCollectionById);
router.delete('/collections/:id', bookController.deleteCollection);
router.put('/collections/:id', bookController.updateCollection);
router.delete('/collections/:collectionId/books/:bookId', bookController.removeBookFromCollection);
router.get('/collections/:collectionId/available-books', bookController.getAvailableBooksForCollection);
router.post('/manual', bookController.addManualBook);
router.patch('/:bookId/favorite', bookController.toggleFavorite);
router.delete('/:bookId', bookController.deleteBook);

// ✅ НОВЫЕ МАРШРУТЫ ДЛЯ ЧИТАТЕЛЬСКИХ МАРШРУТОВ
router.get('/routes', bookController.getRoutes);
router.get('/routes/:id', bookController.getRouteById);
router.post('/routes', bookController.createRoute);
router.patch('/routes/:id', bookController.updateRoute);
router.delete('/routes/:id', bookController.deleteRoute);
router.post('/routes/:id/books', bookController.addBookToRoute);
router.delete('/routes/:id/books/:bookId', bookController.removeBookFromRoute);
router.patch('/routes/:id/books/order', bookController.updateBookOrder);
router.patch('/routes/:id/activate', bookController.activateRoute);
router.patch('/routes/:id/complete', bookController.completeRoute);
// Добавьте эту строку после маршрутов для заметок
router.delete('/notes/:noteId', bookController.deleteNote);
router.patch('/routes/:id/books', bookController.updateRouteBooks);

export default router;