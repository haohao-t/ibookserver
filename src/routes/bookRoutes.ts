import { Router } from 'express';
import { bookController } from '../controllers/bookController';
import { authMiddleware } from '../middleware/authMiddleware';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const uploadsDir = path.join(__dirname, '../../uploads/covers');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const coverStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `cover_${Date.now()}${ext}`);
  },
});

const uploadCoverMiddleware = multer({
  storage: coverStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения') as any, false);
  },
}).single('cover');

const tempDir = path.join(__dirname, '../../temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const uploadScanMiddleware = multer({
  storage: multer.diskStorage({
    destination: tempDir,
    filename: (_req, file, cb) => cb(null, `scan_${Date.now()}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('image');

const router = Router();

router.use(authMiddleware);

/**
 * @swagger
 * tags:
 *   name: Books
 *   description: Управление библиотекой, книгами, коллекциями, маршрутами
 */

/**
 * @swagger
 * /books:
 *   get:
 *     summary: Получить список книг пользователя
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [want_to_read, reading, finished, paused, abandoned]
 *         description: Фильтр по статусу чтения
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Список книг пользователя
 *       401:
 *         description: Не авторизован
 */
router.get('/', bookController.getUserBooks);

/**
 * @swagger
 * /books/isbn:
 *   post:
 *     summary: Добавить книгу по ISBN (сканирование)
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isbn
 *             properties:
 *               isbn:
 *                 type: string
 *                 example: "9785170900001"
 *     responses:
 *       201:
 *         description: Книга успешно добавлена
 *       404:
 *         description: Книга не найдена
 */
router.post('/isbn', bookController.addBookByISBN);

/**
 * @swagger
 * /books/manual:
 *   post:
 *     summary: Добавить книгу вручную
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - author
 *             properties:
 *               title:
 *                 type: string
 *               author:
 *                 type: string
 *               isbn:
 *                 type: string
 *               pages:
 *                 type: integer
 *               genre:
 *                 type: string
 *     responses:
 *       201:
 *         description: Книга успешно добавлена
 */
router.post('/manual', bookController.addManualBook);
router.post('/upload-cover', uploadCoverMiddleware, bookController.uploadCover);
router.post('/scan-cover', uploadScanMiddleware, bookController.scanCover);

/**
 * @swagger
 * /books/editions/{editionId}/progress:
 *   patch:
 *     summary: Обновить прогресс чтения книги
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: editionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               current_page:
 *                 type: integer
 *               status:
 *                 type: string
 *                 enum: [want_to_read, reading, finished, paused, abandoned]
 *               user_rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *               user_review:
 *                 type: string
 *     responses:
 *       200:
 *         description: Прогресс обновлен
 */
router.patch('/library/:libraryId/progress', bookController.updateProgress);

router.get('/library/:libraryId/notes', bookController.getNotes);

/**
 * @swagger
 * /books/editions/{editionId}/notes:
 *   post:
 *     summary: Добавить заметку к книге
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: editionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *               page_number:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Заметка добавлена
 */
router.post('/library/:libraryId/notes', bookController.addNote);

/**
 * @swagger
 * /books/notes/{noteId}:
 *   delete:
 *     summary: Удалить заметку
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: noteId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Заметка удалена
 */
router.get('/notes', bookController.getAllNotes);
router.patch('/notes/:noteId/favorite', bookController.toggleNoteFavorite);
router.patch('/notes/:noteId', bookController.updateNote);
router.delete('/notes/:noteId', bookController.deleteNote);
router.delete('/library/:libraryId/notes', bookController.deleteNotesByLibrary);

/**
 * @swagger
 * /books/collections:
 *   get:
 *     summary: Получить все коллекции пользователя
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список коллекций
 */
router.get('/collections', bookController.getCollections);

/**
 * @swagger
 * /books/collections:
 *   post:
 *     summary: Создать новую коллекцию
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               is_private:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Коллекция создана
 */
router.post('/collections', bookController.createCollection);

/**
 * @swagger
 * /books/collections/{id}:
 *   get:
 *     summary: Получить коллекцию по ID
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Данные коллекции
 */
router.get('/collections/:id', bookController.getCollectionById);

/**
 * @swagger
 * /books/collections/{id}:
 *   put:
 *     summary: Обновить коллекцию
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               is_private:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Коллекция обновлена
 */
router.put('/collections/:id', bookController.updateCollection);
router.delete('/collections/:id', bookController.deleteCollection);
router.patch('/collections/:id/pin', bookController.togglePinCollection);

/**
 * @swagger
 * /books/collections/{id}:
 *   delete:
 *     summary: Удалить коллекцию
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Коллекция удалена
 */
router.delete('/library/:libraryId/collections/:collectionId', bookController.removeBookFromCollection);
// Найти или создать произведение (для AI)
router.post('/works/find-or-create', bookController.findOrCreateWork);

// Добавить книгу в маршрут
router.post('/routes/:routeId/books', bookController.addBookToRoute);
// Удалить книгу из маршрута
router.delete('/routes/:routeId/books/:workId', bookController.removeBookFromRoute);
// Изменить порядок книг в маршруте
router.patch('/routes/:routeId/books/order', bookController.updateBookOrder);
/**
 * @swagger
 * /books/collections/add-book:
 *   post:
 *     summary: Добавить книгу в коллекцию
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - collectionId
 *               - editionId
 *             properties:
 *               collectionId:
 *                 type: integer
 *               editionId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Книга добавлена в коллекцию
 */

router.post('/collections/add-book', bookController.addBookToCollection);
/**
 * @swagger
 * /books/collections/{collectionId}/editions/{editionId}:
 *   delete:
 *     summary: Удалить книгу из коллекции
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: collectionId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: editionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Книга удалена из коллекции
 */
/**
 * @swagger
 * /books/collections/{collectionId}/available-books:
 *   get:
 *     summary: Получить книги, доступные для добавления в коллекцию
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: collectionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Список доступных книг
 */
router.get('/collections/:collectionId/available-books', bookController.getAvailableBooksForCollection);

/**
 * @swagger
 * /books/editions/{editionId}/favorite:
 *   patch:
 *     summary: Добавить/удалить книгу из избранного
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: editionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isFavorite
 *             properties:
 *               isFavorite:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Статус избранного изменен
 */
router.patch('/library/:libraryId/favorite', bookController.toggleFavorite);

/**
 * @swagger
 * /books/editions/{editionId}:
 *   delete:
 *     summary: Удалить книгу из библиотеки
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: editionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Книга удалена
 */
router.delete('/library/:libraryId', bookController.deleteBook);

/**
 * @swagger
 * /books/editions/{editionId}/pages:
 *   patch:
 *     summary: Обновить количество страниц издания
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: editionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pages
 *             properties:
 *               pages:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Страницы обновлены
 */
router.patch('/library/:libraryId/pages', bookController.updatePages);
router.patch('/library/:libraryId/metadata', bookController.updateBookMetadata);

/**
 * @swagger
 * /books/stats:
 *   get:
 *     summary: Получить статистику чтения пользователя
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Статистика (книг, страниц, времени, жанров)
 */
router.get('/stats', bookController.getReadingStats);

/**
 * @swagger
 * /books/history:
 *   get:
 *     summary: Получить историю чтения
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: История чтения с пагинацией
 */
router.get('/history', bookController.getReadingHistory);

/**
 * @swagger
 * /books/search/isbn/{isbn}:
 *   get:
 *     summary: Поиск книги по ISBN во внешних API
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: isbn
 *         required: true
 *         schema:
 *           type: string
 *         description: 10 или 13 цифр
 *     responses:
 *       200:
 *         description: Найденная книга
 *       404:
 *         description: Книга не найдена
 */
router.get('/search/isbn/:isbn/all', bookController.searchBookByISBNAll);
router.get('/search/isbn/:isbn', bookController.searchBookByISBN);

// ============================================
// ЧИТАТЕЛЬСКИЕ МАРШРУТЫ
// ============================================

/**
 * @swagger
 * tags:
 *   name: ReadingRoutes
 *   description: Управление читательскими маршрутами
 */

/**
 * @swagger
 * /books/routes:
 *   get:
 *     summary: Получить все маршруты пользователя
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список маршрутов
 */
router.get('/routes', bookController.getRoutes);

/**
 * @swagger
 * /books/routes/{id}:
 *   get:
 *     summary: Получить маршрут по ID
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Данные маршрута
 */
router.get('/routes/:id', bookController.getRouteById);

/**
 * @swagger
 * /books/routes:
 *   post:
 *     summary: Создать новый читательский маршрут
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - works
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               works:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     workId:
 *                       type: integer
 *               planned_start_date:
 *                 type: string
 *                 format: date
 *               planned_end_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       201:
 *         description: Маршрут создан
 */
router.post('/routes', bookController.createRoute);

/**
 * @swagger
 * /books/routes/{id}:
 *   patch:
 *     summary: Обновить маршрут
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               planned_start_date:
 *                 type: string
 *                 format: date
 *               planned_end_date:
 *                 type: string
 *                 format: date
 *               works:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     workId:
 *                       type: integer
 *     responses:
 *       200:
 *         description: Маршрут обновлен
 */
router.patch('/routes/:id', bookController.updateRoute);

/**
 * @swagger
 * /books/routes/{id}:
 *   delete:
 *     summary: Удалить маршрут
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Маршрут удален
 */
router.delete('/routes/:id', bookController.deleteRoute);

/**
 * @swagger
 * /books/routes/{id}/activate:
 *   patch:
 *     summary: Активировать маршрут (перевести в статус active)
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Маршрут активирован
 */
router.patch('/routes/:id/activate', bookController.activateRoute);

/**
 * @swagger
 * /books/routes/{id}/complete:
 *   patch:
 *     summary: Завершить маршрут (перевести в статус completed)
 *     tags: [ReadingRoutes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Маршрут завершен
 */
router.patch('/routes/:id/complete', bookController.completeRoute);

// ── Рекомендации ──────────────────────────────────────────────────────────────
router.get('/recommendations',         bookController.getRecommendations);
router.post('/recommendations/refresh', bookController.refreshRecommendations);

export default router;