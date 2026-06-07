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

router.get('/', bookController.getUserBooks);
router.post('/isbn', bookController.addBookByISBN);
router.post('/manual', bookController.addManualBook);
router.post('/upload-cover', uploadCoverMiddleware, bookController.uploadCover);
router.post('/scan-cover', uploadScanMiddleware, bookController.scanCover);

router.patch('/library/:libraryId/progress', bookController.updateProgress);
router.get('/library/:libraryId/notes', bookController.getNotes);
router.post('/library/:libraryId/notes', bookController.addNote);

router.get('/notes', bookController.getAllNotes);
router.patch('/notes/:noteId/favorite', bookController.toggleNoteFavorite);
router.patch('/notes/:noteId', bookController.updateNote);
router.delete('/notes/:noteId', bookController.deleteNote);
router.delete('/library/:libraryId/notes', bookController.deleteNotesByLibrary);

router.get('/collections', bookController.getCollections);
router.post('/collections', bookController.createCollection);
router.get('/collections/:id', bookController.getCollectionById);
router.put('/collections/:id', bookController.updateCollection);
router.delete('/collections/:id', bookController.deleteCollection);
router.patch('/collections/:id/pin', bookController.togglePinCollection);
router.delete('/library/:libraryId/collections/:collectionId', bookController.removeBookFromCollection);
router.post('/collections/add-book', bookController.addBookToCollection);
router.get('/collections/:collectionId/available-books', bookController.getAvailableBooksForCollection);

router.patch('/library/:libraryId/favorite', bookController.toggleFavorite);
router.delete('/library/:libraryId', bookController.deleteBook);
router.patch('/library/:libraryId/pages', bookController.updatePages);
router.patch('/library/:libraryId/metadata', bookController.updateBookMetadata);

router.get('/stats', bookController.getReadingStats);
router.get('/history', bookController.getReadingHistory);

router.get('/search', bookController.searchBooksByQuery);
router.get('/search/isbn/:isbn/all', bookController.searchBookByISBNAll);
router.get('/search/isbn/:isbn', bookController.searchBookByISBN);

router.post('/works/find-or-create', bookController.findOrCreateWork);

router.get('/routes', bookController.getRoutes);
router.get('/routes/:id', bookController.getRouteById);
router.post('/routes', bookController.createRoute);
router.patch('/routes/:id', bookController.updateRoute);
router.delete('/routes/:id', bookController.deleteRoute);
router.post('/routes/:routeId/books', bookController.addBookToRoute);
router.delete('/routes/:routeId/books/:workId', bookController.removeBookFromRoute);
router.patch('/routes/:routeId/books/order', bookController.updateBookOrder);
router.patch('/routes/:id/activate', bookController.activateRoute);
router.patch('/routes/:id/complete', bookController.completeRoute);

router.get('/recommendations', bookController.getRecommendations);
router.post('/recommendations/refresh', bookController.refreshRecommendations);

export default router;
