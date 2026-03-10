// book_server/src/services/bookApiService.ts

import fetch from 'node-fetch';

export interface BookData {
  title: string;
  authors: string[];
  description: string;
  coverUrl: string;
  pages: number | null;
  publisher: string;
  language: string;
  isbn: string;
}

class BookApiService {
  // Google Books API с повторными попытками при ошибке 429
  async fetchFromGoogleByISBN(isbn: string, retryCount = 0): Promise<BookData | null> {
    console.log('\n📚 [Google API] ========== НАЧАЛО ЗАПРОСА ==========');
    console.log('📚 [Google API] ISBN:', isbn);
    console.log('📚 [Google API] Попытка:', retryCount + 1);

    try {
      const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
      console.log('📚 [Google API] URL:', url);

      const response = await fetch(url);
      console.log('📚 [Google API] Статус ответа:', response.status);

      // Если получили 429 (Too Many Requests) и не превысили лимит попыток
      if (response.status === 429 && retryCount < 2) { // Уменьшили до 2 попыток
        const delay = (retryCount + 1) * 1000; // 1с, 2с
        console.log(`📚 [Google API] ⏳ Получили 429, повтор через ${delay / 1000} секунд...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchFromGoogleByISBN(isbn, retryCount + 1);
      }

      const data = await response.json();
      console.log('📚 [Google API] totalItems:', data.totalItems);
      console.log('📚 [Google API] количество items:', data.items?.length || 0);

      if (!data.items || data.items.length === 0) {
        console.log('📚 [Google API] ❌ Книга не найдена');
        return null;
      }

      const volume = data.items[0].volumeInfo;
      
      let language = volume.language || 'ru';
      if (language === 'en') language = 'en';
      
      return {
        title: volume.title || 'Без названия',
        authors: volume.authors || ['Неизвестный автор'],
        description: volume.description || '',
        coverUrl: volume.imageLinks?.thumbnail || volume.imageLinks?.smallThumbnail || '',
        pages: volume.pageCount || null,
        publisher: volume.publisher || '',
        language: language,
        isbn: isbn
      };
    } catch (error) {
      console.error('📚 [Google API] ❌ Ошибка:', error);
      return null;
    }
  }

  // Open Library API
  async fetchFromOpenLibraryByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n📚 [OpenLibrary] ========== НАЧАЛО ЗАПРОСА ==========');
    console.log('📚 [OpenLibrary] ISBN:', isbn);

    try {
      const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
      console.log('📚 [OpenLibrary] URL:', url);

      const response = await fetch(url);
      console.log('📚 [OpenLibrary] Статус ответа:', response.status);

      const data = await response.json();
      const bookKey = `ISBN:${isbn}`;
      
      console.log('📚 [OpenLibrary] Есть книга:', !!data[bookKey]);

      if (!data[bookKey]) {
        console.log('📚 [OpenLibrary] ❌ Книга не найдена');
        return null;
      }

      const book = data[bookKey];
      
      let description = '';
      if (book.description) {
        if (typeof book.description === 'string') {
          description = book.description;
        } else if (book.description.value) {
          description = book.description.value;
        }
      }

      let coverUrl = '';
      if (book.cover) {
        coverUrl = book.cover.large || book.cover.medium || book.cover.small || '';
      }

      let language = 'ru';
      if (book.languages && book.languages[0]?.key) {
        const langKey = book.languages[0].key;
        if (langKey.includes('eng')) language = 'en';
      }
      
      return {
        title: book.title || 'Без названия',
        authors: book.authors?.map((a: any) => a.name) || ['Неизвестный автор'],
        description: description,
        coverUrl: coverUrl,
        pages: book.number_of_pages || null,
        publisher: book.publishers?.[0]?.name || '',
        language: language,
        isbn: isbn
      };
    } catch (error) {
      console.error('📚 [OpenLibrary] ❌ Ошибка:', error);
      return null;
    }
  }

  // Универсальный метод с fallback (оставляем для обратной совместимости)
  async findBookByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n🎯 [BookService] ========== ПОИСК КНИГИ ==========');
    console.log('🎯 [BookService] ISBN:', isbn);
    
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    if (cleanIsbn !== isbn) {
      console.log('🎯 [BookService] Очищенный ISBN:', cleanIsbn);
    }

    // Сначала пробуем Open Library
    console.log('\n🔄 [BookService] Пробуем Open Library...');
    let bookData = await this.fetchFromOpenLibraryByISBN(cleanIsbn);
    
    // Если не нашли — пробуем Google Books
    if (!bookData) {
      console.log('\n🔄 [BookService] Open Library не нашёл, пробуем Google...');
      bookData = await this.fetchFromGoogleByISBN(cleanIsbn);
    }

    if (bookData) {
      console.log('\n✅ [BookService] КНИГА НАЙДЕНА!');
    } else {
      console.log('\n❌ [BookService] КНИГА НЕ НАЙДЕНА');
    }

    return bookData;
  }
}

export const bookApiService = new BookApiService();