import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bookRoutes from './routes/bookRoutes';
import authRoutes from './routes/authRoutes'; // ← ДОБАВЛЯЕМ

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// Маршруты
app.use('/api/books', bookRoutes);
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({ 
    message: '📚 API интеллектуальной библиотеки',
    endpoints: {
      auth: ['POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me'],
      books: ['GET /api/books', 'POST /api/books/isbn', 'PUT /api/books/:id/progress']
    }
  });
});

app.listen(PORT, '0.0.0.0', () => { // Добавь '0.0.0.0'
  console.log(`\n🚀 Сервер запущен на http://localhost:${PORT}`);
  console.log(`🌍 Доступен в сети по IP: ${require('os').networkInterfaces()['Беспроводная сеть']?.[1]?.address || 'не найден'}`);
});