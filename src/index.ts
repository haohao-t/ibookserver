import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import bookRoutes from './routes/bookRoutes';
import authRoutes from './routes/authRoutes';
import aiRoutes from './routes/aiRoutes';
import adminRoutes from './routes/adminRoutes';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/books', bookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api', aiRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'API интеллектуальной библиотеки',
    endpoints: {
      auth: ['POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me'],
      books: [
        'GET /api/books',
        'POST /api/books/isbn',
        'POST /api/books/manual',
        'PUT /api/books/:bookId/progress',
        'GET /api/books/:bookId/notes',
        'POST /api/books/:bookId/notes',
        'DELETE /api/books/notes/:noteId',
        'GET /api/books/collections',
        'POST /api/books/collections',
        'GET /api/books/collections/:id',
        'PUT /api/books/collections/:id',
        'DELETE /api/books/collections/:id',
        'POST /api/books/collections/add-book',
        'DELETE /api/books/collections/:collectionId/books/:bookId',
        'GET /api/books/collections/:collectionId/available-books',
        'PATCH /api/books/:bookId/favorite',
        'DELETE /api/books/:bookId',
        'GET /api/books/stats',
        'GET /api/books/history',
        'GET /api/books/search/isbn/:isbn',
        'GET /api/books/routes',
        'GET /api/books/routes/:id',
        'POST /api/books/routes',
        'PATCH /api/books/routes/:id',
        'DELETE /api/books/routes/:id',
        'POST /api/books/routes/:id/books',
        'DELETE /api/books/routes/:id/books/:bookId',
        'PATCH /api/books/routes/:id/books/order',
        'PATCH /api/books/routes/:id/books',
        'PATCH /api/books/routes/:id/activate',
        'PATCH /api/books/routes/:id/complete',
      ],
    },
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n Сервер запущен на http://localhost:${PORT}`);
  console.log(
    ` Доступен в сети по IP: ${require('os').networkInterfaces()['Беспроводная сеть']?.[1]?.address || 'не найден'}`,
  );
});
