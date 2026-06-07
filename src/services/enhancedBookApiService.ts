import { bookApiService } from './bookApiService';
import { labirintParser } from './labirintParser';
import { liveLibParser } from './liveLibParser';

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
  genres?: string[] | undefined;
  series?: string | undefined;
  sourceUrl?: string | undefined;
  rating?: number | null;
}

interface CacheEntry {
  data: BookData | null;
  timestamp: number;
  source: string;
}

class EnhancedBookApiService {
  private cache: Map<string, CacheEntry> = new Map();
  private CACHE_TTL = 24 * 60 * 60 * 1000;
  private TIMEOUT_MS = 5000;

  async findBookByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n[EnhancedService] ========== ПОИСК ПО ВСЕМ ИСТОЧНИКАМ ==========');
    console.log('[EnhancedService] ISBN:', isbn);

    const cleanIsbn = isbn.replace(/[-\s]/g, '');

    const cached = this.cache.get(cleanIsbn);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log('[EnhancedService] Найдено в кэше, источник:', cached.source);
      return cached.data;
    }

    console.log('\n[EnhancedService] 1. Пробуем LiveLib...');
    const liveLibData = await this.fetchWithTimeout(
      liveLibParser.searchByISBN(cleanIsbn),
      15000,
      'LiveLib'
    );

    if (liveLibData?.title) {
      const needsGoogle = !liveLibData.coverUrl || !liveLibData.description ||
        !liveLibData.pages || !liveLibData.publisher || !liveLibData.publish_year;
      if (needsGoogle) {
        console.log('\n[EnhancedService] LiveLib: неполные данные — дополняем из Google...');
        const googleData = await this.fetchWithTimeout(
          bookApiService.fetchFromGoogleByISBN(cleanIsbn),
          this.TIMEOUT_MS * 2,
          'Google Books (дополнение)'
        );
        if (googleData) {
          if (!liveLibData.coverUrl && googleData.coverUrl) {
            liveLibData.coverUrl = googleData.coverUrl;
            console.log('[EnhancedService] Обложка дополнена из Google');
          }
          if (!liveLibData.description && googleData.description) {
            liveLibData.description = googleData.description;
            console.log('[EnhancedService] Описание дополнено из Google');
          }
          if (!liveLibData.pages && googleData.pages) {
            liveLibData.pages = googleData.pages;
            console.log('[EnhancedService] Страницы дополнены из Google');
          }
          if (!liveLibData.publisher && googleData.publisher) {
            liveLibData.publisher = googleData.publisher;
            console.log('[EnhancedService] Издательство дополнено из Google');
          }
          if (!liveLibData.publish_year && googleData.publish_year) {
            liveLibData.publish_year = googleData.publish_year;
            console.log('[EnhancedService] Год дополнен из Google');
          }
          if ((!liveLibData.genres || !liveLibData.genres.length) && googleData.genres?.length) {
            liveLibData.genres = googleData.genres;
            console.log('[EnhancedService] Жанры дополнены из Google');
          }
        }
      }
      console.log('[EnhancedService] Возвращаем данные LiveLib');
      this.cache.set(cleanIsbn, { data: liveLibData, timestamp: Date.now(), source: 'livelib' });
      return liveLibData;
    }

    console.log('\n[EnhancedService] 2. Пробуем Google Books...');
    const googleData = await this.fetchWithTimeout(
      bookApiService.fetchFromGoogleByISBN(cleanIsbn),
      this.TIMEOUT_MS * 2,
      'Google Books'
    );
    if (googleData?.title && googleData.title !== 'Без названия') {
      console.log('[EnhancedService] Найдено в Google Books');
      this.cache.set(cleanIsbn, { data: googleData, timestamp: Date.now(), source: 'google' });
      return googleData;
    }

    console.log('\n[EnhancedService] 3. Пробуем Open Library...');
    const openLibData = await this.fetchWithTimeout(
      bookApiService.fetchFromOpenLibraryByISBN(cleanIsbn),
      this.TIMEOUT_MS,
      'Open Library'
    );
    if (openLibData?.title && openLibData.title !== 'Без названия') {
      console.log('[EnhancedService] Найдено в Open Library');
      this.cache.set(cleanIsbn, { data: openLibData, timestamp: Date.now(), source: 'openlibrary' });
      return openLibData;
    }

    console.log('\n[EnhancedService] 4. Пробуем Лабиринт...');
    const labirintData = await this.fetchWithTimeout(
      labirintParser.searchByISBN(cleanIsbn),
      this.TIMEOUT_MS * 3,
      'Лабиринт'
    );
    if (labirintData) {
      console.log('[EnhancedService] Найдено в Лабиринте');
      this.cache.set(cleanIsbn, { data: labirintData, timestamp: Date.now(), source: 'labirint' });
      return labirintData;
    }

    this.cache.set(cleanIsbn, { data: null, timestamp: Date.now(), source: 'not_found' });
    console.log('[EnhancedService] Книга не найдена');
    return null;
  }

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
      console.log(`[EnhancedService] ${sourceName} не ответил:`, errorMessage);
      return null;
    }
  }

  async findAllByISBN(isbn: string): Promise<Array<BookData & { source: string }>> {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    const results: Array<BookData & { source: string }> = [];

    console.log('\n[EnhancedService findAll] 1. LiveLib...');
    const liveLibResult = await this.fetchWithTimeout(
      liveLibParser.searchByISBN(cleanIsbn), 15000, 'LiveLib'
    );

    console.log('\n[EnhancedService findAll] 2. Google + Open Library параллельно...');
    const [googleSettled, openLibSettled] = await Promise.allSettled([
      this.fetchWithTimeout(bookApiService.fetchFromGoogleByISBN(cleanIsbn), this.TIMEOUT_MS * 2, 'Google Books'),
      this.fetchWithTimeout(bookApiService.fetchFromOpenLibraryByISBN(cleanIsbn), this.TIMEOUT_MS, 'Open Library'),
    ]);

    const googleData  = googleSettled.status  === 'fulfilled' ? googleSettled.value  : null;
    const openLibData = openLibSettled.status === 'fulfilled' ? openLibSettled.value : null;

    if (liveLibResult?.title) {
      const entry = { ...liveLibResult };
      if (!entry.coverUrl && googleData?.coverUrl) {
        entry.coverUrl = googleData.coverUrl;
        console.log('[EnhancedService] Обложка LiveLib дополнена из Google');
      }
      if (!entry.description && googleData?.description) {
        entry.description = googleData.description;
        console.log('[EnhancedService] Описание LiveLib дополнено из Google');
      }
      results.push({ ...entry, source: 'LiveLib', sourceUrl: liveLibResult.sourceUrl });
    }

    if (googleData?.title)  results.push({ ...googleData,  source: 'Google Books' });
    if (openLibData?.title) results.push({ ...openLibData, source: 'Open Library' });

    if (!liveLibResult) {
      console.log('\n[EnhancedService findAll] 3. LiveLib не нашёл — пробуем Лабиринт...');
      const labirintResult = await this.fetchWithTimeout(
        labirintParser.searchByISBN(cleanIsbn), 15000, 'Лабиринт'
      );
      if (labirintResult?.title) {
        results.push({ ...labirintResult, source: 'Лабиринт' });
      }
    }

    const unique: Array<BookData & { source: string }> = [];
    for (const r of results) {
      const isDup = unique.some(
        u => u.title.toLowerCase().trim() === r.title.toLowerCase().trim()
      );
      if (!isDup) unique.push(r);
    }

    return unique;
  }

  clearCache() {
    this.cache.clear();
    console.log('[EnhancedService] Кэш очищен');
  }

  getSourceStats() {
    const stats: Record<string, number> = {};
    this.cache.forEach(value => {
      stats[value.source] = (stats[value.source] || 0) + 1;
    });
    return stats;
  }
}

export const enhancedBookApiService = new EnhancedBookApiService();
