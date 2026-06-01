// src/swagger.ts
import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'API для управления персональной библиотекой',
      version: '1.0.0',
      description: `Документация API автоматизированной системы интеллектуального управления персональной библиотекой «Персональный библиограф».`,
      contact: {
        name: 'Фурсова А.М.',
        email: 'fursova@example.com'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000/api',
        description: ''
      },
      {
        url: 'https://api.library-app.com/api',
        description: ''
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Введите JWT-токен, полученный при авторизации'
        }
      },
      schemas: {
        // Пользователь
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            email: { type: 'string', format: 'email', example: 'user@example.com' },
            username: { type: 'string', example: 'booklover' },
            role: { type: 'string', enum: ['reader', 'admin'], example: 'reader' },
            reading_goal_pages: { type: 'integer', example: 30 },
            avatar_url: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            last_login_at: { type: 'string', format: 'date-time', nullable: true }
          }
        },
        // Книга (глобальный каталог)
        Book: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            title: { type: 'string', example: 'Война и мир' },
            isbn: { type: 'string', example: '9785170900001' },
            author: {
              type: 'object',
              properties: {
                id: { type: 'integer', example: 1 },
                full_name: { type: 'string', example: 'Лев Толстой' }
              }
            },
            pages: { type: 'integer', example: 1225 },
            genre: { type: 'string', example: 'Роман-эпопея' },
            cover_url: { type: 'string', format: 'url', example: 'https://example.com/cover.jpg' },
            average_rating: { type: 'number', format: 'float', example: 4.8 },
            publish_year: { type: 'integer', example: 1869 },
            description: { type: 'string', example: 'Роман-эпопея Льва Толстого...' }
          }
        },
        // Книга в библиотеке пользователя
        UserBook: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            book: { $ref: '#/components/schemas/Book' },
            added_via: { type: 'string', enum: ['isbn_scan', 'manual'], example: 'isbn_scan' },
            added_at: { type: 'string', format: 'date-time' },
            is_favorite: { type: 'boolean', example: false },
            reading_progress: {
              type: 'object',
              properties: {
                current_page: { type: 'integer', example: 450 },
                total_pages: { type: 'integer', example: 1225 },
                status: { type: 'string', enum: ['want_to_read', 'reading', 'finished', 'paused', 'abandoned'], example: 'reading' },
                user_rating: { type: 'integer', minimum: 1, maximum: 5, nullable: true },
                user_review: { type: 'string', nullable: true }
              }
            }
          }
        },
        // Читательский маршрут
        ReadingRoute: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', example: 'Русская классика' },
            description: { type: 'string', example: 'Погружение в золотой век русской литературы' },
            status: { type: 'string', enum: ['draft', 'active', 'completed'], example: 'active' },
            planned_start_date: { type: 'string', format: 'date', nullable: true },
            planned_end_date: { type: 'string', format: 'date', nullable: true },
            progress: { type: 'number', format: 'float', example: 75.5 },
            books: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  order_index: { type: 'integer' },
                  book: { $ref: '#/components/schemas/Book' },
                  progress: { type: 'number', format: 'float' },
                  planned_start_date: { type: 'string', format: 'date', nullable: true },
                  planned_end_date: { type: 'string', format: 'date', nullable: true }
                }
              }
            }
          }
        },
        // Коллекция
        Collection: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            is_private: { type: 'boolean' },
            books_count: { type: 'integer' }
          }
        },
        // Заметка
        BookNote: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            content: { type: 'string' },
            page_number: { type: 'integer', nullable: true },
            created_at: { type: 'string', format: 'date-time' }
          }
        },
        // Статистика
        ReadingStats: {
          type: 'object',
          properties: {
            total_books: { type: 'integer', example: 15 },
            finished_books: { type: 'integer', example: 8 },
            total_pages: { type: 'integer', example: 3420 },
            total_reading_minutes: { type: 'integer', example: 2460 },
            avg_rating: { type: 'number', format: 'float', example: 4.5 },
            favorite_genres: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  genre: { type: 'string' },
                  count: { type: 'integer' }
                }
              }
            }
          }
        },
        // Ошибка
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'BOOK_NOT_FOUND' },
                message: { type: 'string', example: 'Книга с указанным ISBN не найдена' }
              }
            }
          }
        }
      }
    },
    security: [
      {
        bearerAuth: []
      }
    ]
  },
  apis: ['./src/routes/*.ts'] // Путь к файлам с аннотациями
};

export const swaggerSpec = swaggerJsdoc(options);