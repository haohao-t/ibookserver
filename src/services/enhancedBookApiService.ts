// book_server/src/services/enhancedBookApiService.ts

import { bookApiService } from './bookApiService';
import { labirintParser } from './labirintParser';
import { liveLibParser } from './liveLibParser';

// Единый интерфейс для всех источников
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
  genre?: string | undefined;
  series?: string | undefined;
  sourceUrl?: string | undefined;
}

// Тип для кэша
interface CacheEntry {
  data: BookData | null;
  timestamp: number;
  source: string;
}

class EnhancedBookApiService {
  private cache: Map<string, CacheEntry> = new Map();
  private CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа
  private TIMEOUT_MS = 5000;

  /**
   * Поиск книги по ISBN — LiveLib в приоритете, дополняем из Google при необходимости
   */
  async findBookByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n🎯 [EnhancedService] ========== ПОИСК ПО ВСЕМ ИСТОЧНИКАМ ==========');
    console.log('🎯 [EnhancedService] ISBN:', isbn);

    const cleanIsbn = isbn.replace(/[-\s]/g, '');

    // 1️⃣ Проверяем кэш
    const cached = this.cache.get(cleanIsbn);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log('🎯 [EnhancedService] 📦 Найдено в кэше, источник:', cached.source);
      return cached.data;
    }

    // 2️⃣ LiveLib — приоритет (лучшие данные для русских книг: серия, описание, обложка)
    console.log('\n🔄 [EnhancedService] 1. Пробуем LiveLib...');
    const liveLibData = await this.fetchWithTimeout(
      liveLibParser.searchByISBN(cleanIsbn),
      15000,
      'LiveLib'
    );

    if (liveLibData?.title) {
      // Если LiveLib нашёл книгу, но нет обложки или описания — дополняем из Google
      if (!liveLibData.coverUrl || !liveLibData.description) {
        console.log('\n🔄 [EnhancedService] LiveLib: нет обложки/описания — дополняем из Google...');
        const googleData = await this.fetchWithTimeout(
          bookApiService.fetchFromGoogleByISBN(cleanIsbn),
          this.TIMEOUT_MS * 2,
          'Google Books (дополнение)'
        );
        if (googleData) {
          if (!liveLibData.coverUrl && googleData.coverUrl) {
            liveLibData.coverUrl = googleData.coverUrl;
            console.log('📎 [EnhancedService] Обложка дополнена из Google');
          }
          if (!liveLibData.description && googleData.description) {
            liveLibData.description = googleData.description;
            console.log('📎 [EnhancedService] Описание дополнено из Google');
          }
        }
      }
      console.log('✅ [EnhancedService] Возвращаем данные LiveLib');
      this.cache.set(cleanIsbn, { data: liveLibData, timestamp: Date.now(), source: 'livelib' });
      return liveLibData;
    }

    // 3️⃣ Google Books
    console.log('\n🔄 [EnhancedService] 2. Пробуем Google Books...');
    const googleData = await this.fetchWithTimeout(
      bookApiService.fetchFromGoogleByISBN(cleanIsbn),
      this.TIMEOUT_MS * 2,
      'Google Books'
    );
    if (googleData?.title && googleData.title !== 'Без названия') {
      console.log('✅ [EnhancedService] Найдено в Google Books');
      this.cache.set(cleanIsbn, { data: googleData, timestamp: Date.now(), source: 'google' });
      return googleData;
    }

    // 4️⃣ Open Library
    console.log('\n🔄 [EnhancedService] 3. Пробуем Open Library...');
    const openLibData = await this.fetchWithTimeout(
      bookApiService.fetchFromOpenLibraryByISBN(cleanIsbn),
      this.TIMEOUT_MS,
      'Open Library'
    );
    if (openLibData?.title && openLibData.title !== 'Без названия') {
      console.log('✅ [EnhancedService] Найдено в Open Library');
      this.cache.set(cleanIsbn, { data: openLibData, timestamp: Date.now(), source: 'openlibrary' });
      return openLibData;
    }

    // 5️⃣ Лабиринт — последний запасной
    console.log('\n🔄 [EnhancedService] 4. Пробуем Лабиринт...');
    const labirintData = await this.fetchWithTimeout(
      labirintParser.searchByISBN(cleanIsbn),
      this.TIMEOUT_MS * 3,
      'Лабиринт'
    );
    if (labirintData) {
      console.log('✅ [EnhancedService] Найдено в Лабиринте');
      this.cache.set(cleanIsbn, { data: labirintData, timestamp: Date.now(), source: 'labirint' });
      return labirintData;
    }

    this.cache.set(cleanIsbn, { data: null, timestamp: Date.now(), source: 'not_found' });
    console.log('❌ [EnhancedService] Книга не найдена');
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ [EnhancedService] ${sourceName} не ответил:`, errorMessage);
      return null;
    }
  }

  /**
   * Поиск во всех источниках — LiveLib первым, Google+OL параллельно следом,
   * дополняем LiveLib из Google, Лабиринт только если LiveLib ничего не дал.
   */
  async findAllByISBN(isbn: string): Promise<Array<BookData & { source: string }>> {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    const results: Array<BookData & { source: string }> = [];

    // 1️⃣ LiveLib — запускаем первым (последовательно, т.к. он приоритетный)
    console.log('\n🔄 [EnhancedService findAll] 1. LiveLib...');
    const liveLibResult = await this.fetchWithTimeout(
      liveLibParser.searchByISBN(cleanIsbn), 15000, 'LiveLib'
    );

    // 2️⃣ Google + Open Library параллельно
    console.log('\n🔄 [EnhancedService findAll] 2. Google + Open Library параллельно...');
    const [googleSettled, openLibSettled] = await Promise.allSettled([
      this.fetchWithTimeout(bookApiService.fetchFromGoogleByISBN(cleanIsbn), this.TIMEOUT_MS * 2, 'Google Books'),
      this.fetchWithTimeout(bookApiService.fetchFromOpenLibraryByISBN(cleanIsbn), this.TIMEOUT_MS, 'Open Library'),
    ]);

    const googleData  = googleSettled.status  === 'fulfilled' ? googleSettled.value  : null;
    const openLibData = openLibSettled.status === 'fulfilled' ? openLibSettled.value : null;

    // Добавляем LiveLib (с дополнением из Google, если нет обложки/описания)
    if (liveLibResult?.title) {
      const entry = { ...liveLibResult };
      if (!entry.coverUrl && googleData?.coverUrl) {
        entry.coverUrl = googleData.coverUrl;
        console.log('📎 [EnhancedService] Обложка LiveLib дополнена из Google');
      }
      if (!entry.description && googleData?.description) {
        entry.description = googleData.description;
        console.log('📎 [EnhancedService] Описание LiveLib дополнено из Google');
      }
      results.push({ ...entry, source: 'LiveLib', sourceUrl: liveLibResult.sourceUrl });
    }

    if (googleData?.title)  results.push({ ...googleData,  source: 'Google Books' });
    if (openLibData?.title) results.push({ ...openLibData, source: 'Open Library' });

    // 3️⃣ Лабиринт — только если LiveLib ничего не вернул
    if (!liveLibResult) {
      console.log('\n🔄 [EnhancedService findAll] 3. LiveLib не нашёл — пробуем Лабиринт...');
      const labirintResult = await this.fetchWithTimeout(
        labirintParser.searchByISBN(cleanIsbn), 15000, 'Лабиринт'
      );
      if (labirintResult?.title) {
        results.push({ ...labirintResult, source: 'Лабиринт' });
      }
    }

    // Убираем дубликаты по названию
    const unique: Array<BookData & { source: string }> = [];
    for (const r of results) {
      const isDup = unique.some(
        u => u.title.toLowerCase().trim() === r.title.toLowerCase().trim()
      );
      if (!isDup) unique.push(r);
    }

    return unique;
  }

  /** Очистить кэш */
  clearCache() {
    this.cache.clear();
    console.log('🧹 [EnhancedService] Кэш очищен');
  }

  /** Статистика по источникам */
  getSourceStats() {
    const stats: Record<string, number> = {};
    this.cache.forEach(value => {
      stats[value.source] = (stats[value.source] || 0) + 1;
    });
    return stats;
  }
}

export const enhancedBookApiService = new EnhancedBookApiService();
