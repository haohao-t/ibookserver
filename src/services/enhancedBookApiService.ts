// book_server/src/services/enhancedBookApiService.ts

import { bookApiService } from './bookApiService';
import { labirintParser, BookData as LabirintBookData } from './labirintParser';

// Единый интерфейс для всех источников - ДОБАВЛЕНО ПОЛЕ genre
export interface BookData {
  title: string;
  authors: string[];
  description: string;
  coverUrl: string;
  pages: number | null;
  publisher: string;
  language: string;
  isbn: string;
  publish_year: number | null;
  genre?: string;  // ДОБАВЛЕНО - опциональное поле
}

// Тип для кэша - допускает null
interface CacheEntry {
  data: BookData | null;  // Изменено: теперь может быть null
  timestamp: number;
  source: string;
}

class EnhancedBookApiService {
  private cache: Map<string, CacheEntry> = new Map();  // Используем новый тип
  private CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа
  private TIMEOUT_MS = 5000; // Таймаут 5 секунд для каждого источника

  /**
   * Поиск книги по ISBN с оптимизированным порядком и таймаутами
   */
  async findBookByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n🎯 [EnhancedService] ========== ПОИСК ПО ВСЕМ ИСТОЧНИКАМ ==========');
    console.log('🎯 [EnhancedService] ISBN:', isbn);
    
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    
    // 1️⃣ Проверяем кэш (мгновенно)
    const cached = this.cache.get(cleanIsbn);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log('🎯 [EnhancedService] 📦 Найдено в кэше, источник:', cached.source);
      return cached.data;  // cached.data может быть null, что соответствует возвращаемому типу
    }

    // 2️⃣ Сначала Open Library (быстрый и стабильный)
    console.log('\n🔄 [EnhancedService] 1. Пробуем Open Library (быстрый)...');
    const openLibraryPromise = this.fetchWithTimeout(
      bookApiService.fetchFromOpenLibraryByISBN(cleanIsbn),
      this.TIMEOUT_MS,
      'Open Library'
    );

    let bookData = await openLibraryPromise;
    if (bookData) {
      console.log('✅ [EnhancedService] Найдено в Open Library');
      const converted = await this.convertFromOldFormat(bookData);
      this.cache.set(cleanIsbn, { data: converted, timestamp: Date.now(), source: 'openlibrary' });
      return converted;
    }

    // 3️⃣ Потом Google Books (с повторными попытками)
    console.log('\n🔄 [EnhancedService] 2. Пробуем Google API...');
    const googlePromise = this.fetchWithTimeout(
      bookApiService.fetchFromGoogleByISBN(cleanIsbn),
      this.TIMEOUT_MS,
      'Google Books'
    );

    bookData = await googlePromise;
    if (bookData) {
      console.log('✅ [EnhancedService] Найдено в Google Books');
      const converted = await this.convertFromOldFormat(bookData);
      this.cache.set(cleanIsbn, { data: converted, timestamp: Date.now(), source: 'google' });
      return converted;
    }

    // 4️⃣ В последнюю очередь Лабиринт (медленный, но нужный для российских книг)
    console.log('\n🔄 [EnhancedService] 3. Пробуем Лабиринт (медленный)...');
    
    // Для Лабиринта даем больше времени, так как там несколько запросов
    const labirintPromise = this.fetchWithTimeout(
      labirintParser.searchByISBN(cleanIsbn),
      this.TIMEOUT_MS * 4, // Увеличиваем до 20 секунд (было 10)
      'Лабиринт'
    );

    const labirintData = await labirintPromise;
    if (labirintData) {
      console.log('✅ [EnhancedService] Найдено в Лабиринте');
      this.cache.set(cleanIsbn, { data: labirintData, timestamp: Date.now(), source: 'labirint' });
      return labirintData;
    }

    // Сохраняем в кэш, что книга не найдена (чтобы не искать снова)
    this.cache.set(cleanIsbn, { data: null, timestamp: Date.now(), source: 'not_found' });
    
    console.log('❌ [EnhancedService] Книга не найдена ни в одном источнике');
    return null;
  }

  /**
   * Выполняет промис с таймаутом
   */
  private async fetchWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    sourceName: string
  ): Promise<T | null> {
    try {
      const result = await Promise.race([
        promise,
        new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error(`${sourceName} timeout after ${timeoutMs}ms`)), timeoutMs)
        )
      ]);
      return result;
    } catch (error) {
      // Исправляем обработку unknown error
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ [EnhancedService] ${sourceName} не ответил за ${timeoutMs / 1000}с:`, errorMessage);
      return null;
    }
  }

  private async convertFromOldFormat(oldData: any): Promise<BookData | null> {
    if (!oldData) return null;
    
    return {
      title: oldData.title,
      authors: oldData.authors,
      description: oldData.description,
      coverUrl: oldData.coverUrl,
      pages: oldData.pages,
      publisher: oldData.publisher,
      language: oldData.language,
      isbn: oldData.isbn,
      publish_year: oldData.publish_year || null,
      genre: oldData.genre || ''  // ДОБАВЛЕНО - преобразуем genre, если есть
    };
  }

  /**
   * Очистить кэш
   */
  clearCache() {
    this.cache.clear();
    console.log('🧹 [EnhancedService] Кэш очищен');
  }

  /**
   * Получить статистику по источникам
   */
  getSourceStats() {
    const stats: Record<string, number> = {};
    this.cache.forEach((value) => {
      stats[value.source] = (stats[value.source] || 0) + 1;
    });
    return stats;
  }
}

export const enhancedBookApiService = new EnhancedBookApiService();