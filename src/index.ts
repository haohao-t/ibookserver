import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import bookRoutes from './routes/bookRoutes';
import authRoutes from './routes/authRoutes';
import aiRoutes from './routes/aiRoutes';
import adminRoutes from './routes/adminRoutes';
import { swaggerSpec } from './swagger';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Swagger UI (документация API)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'API документация - Персональная библиотека'
}));

// JSON-версия спецификации Swagger
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Маршруты API
app.use('/api/books', bookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api', aiRoutes);
app.use('/api/admin', adminRoutes);

// Корневой маршрут
app.get('/', (req, res) => {
  res.json({ 
    message: 'API интеллектуальной библиотеки',
    documentation: 'http://localhost:3000/api-docs',
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
        'PATCH /api/books/routes/:id/complete'
      ]
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n Сервер запущен на http://localhost:${PORT}`);
  console.log(` Документация API: http://localhost:${PORT}/api-docs`);
  console.log(` Доступен в сети по IP: ${require('os').networkInterfaces()['Беспроводная сеть']?.[1]?.address || 'не найден'}`);
});