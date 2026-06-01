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
  publish_year: number | null;
}

class BookApiService {
  // Google Books API с повторными попытками
  async fetchFromGoogleByISBN(isbn: string, retryCount = 0): Promise<BookData | null> {
    console.log('\n📚 [Google API] ========== НАЧАЛО ЗАПРОСА ==========');
    console.log('📚 [Google API] ISBN:', isbn);
    console.log('📚 [Google API] Попытка:', retryCount + 1);

    try {
      const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
      const keyParam = apiKey ? `&key=${apiKey}` : '';
      const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${keyParam}`;
      console.log('📚 [Google API] URL:', url.replace(apiKey || '', '***'));

      const response = await fetch(url);

      console.log('📚 [Google API] Статус ответа:', response.status);

      // 429 — лимит запросов, не повторяем
      if (response.status === 429) {
        console.log('📚 [Google API] ⚠️ Rate limit (429), пропускаем Google');
        return null;
      }

      // 503 — сервис временно недоступен, пробуем ещё раз
      if (response.status === 503 && retryCount < 2) {
        const delay = 2000;
        console.log(`⏳ Повтор через ${delay/1000} секунд...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchFromGoogleByISBN(isbn, retryCount + 1);
      }

      if (response.status !== 200) {
        console.log('📚 [Google API] ❌ Ошибка, статус:', response.status);
        return null;
      }

      const data = await response.json();

      if (!data.items || data.items.length === 0) {
        console.log('📚 [Google API] ❌ Книга не найдена');
        return null;
      }

      // Ищем среди всех результатов тот, у которого ISBN совпадает с запрошенным
      const cleanSearchIsbn = isbn.replace(/[-\s]/g, '');
      let volume = null;
      for (const item of data.items) {
        const info = item.volumeInfo;
        const identifiers: any[] = info.industryIdentifiers || [];
        const isbnMatch = identifiers.some(
          (id: any) => id.identifier?.replace(/[-\s]/g, '') === cleanSearchIsbn
        );
        if (isbnMatch) {
          volume = info;
          console.log('📚 [Google API] ✅ ISBN подтверждён в ответе');
          break;
        }
      }

      // Если ISBN не подтверждён ни в одном результате — не доверяем Google
      if (!volume) {
        console.log('📚 [Google API] ⚠️ ISBN не совпал ни с одним результатом — пропускаем');
        return null;
      }

      let language = volume.language || 'ru';
      if (language === 'en') language = 'en';

      // Извлекаем год издания
      let publish_year = null;
      if (volume.publishedDate) {
        const yearMatch = volume.publishedDate.match(/^\d{4}/);
        if (yearMatch) {
          publish_year = parseInt(yearMatch[0]);
        }
      }

      return {
        title: volume.title || 'Без названия',
        authors: volume.authors || ['Неизвестный автор'],
        description: volume.description || '',
        coverUrl: volume.imageLinks?.thumbnail || volume.imageLinks?.smallThumbnail || '',
        pages: volume.pageCount || null,
        publisher: volume.publisher || '',
        language: language,
        isbn: isbn,
        publish_year: publish_year
      };
    } catch (error: any) {
      console.error('📚 [Google API] ❌ Ошибка:', error?.message || error);
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
      
      // Извлекаем год издания
      let publish_year = null;
      if (book.publish_date) {
        const yearMatch = book.publish_date.match(/\d{4}/);
        if (yearMatch) {
          publish_year = parseInt(yearMatch[0]);
        }
      }
      
      return {
        title: book.title || 'Без названия',
        authors: book.authors?.map((a: any) => a.name) || ['Неизвестный автор'],
        description: description,
        coverUrl: coverUrl,
        pages: book.number_of_pages || null,
        publisher: book.publishers?.[0]?.name || '',
        language: language,
        isbn: isbn,
        publish_year: publish_year
      };
    } catch (error: any) {
      console.error('📚 [OpenLibrary] ❌ Ошибка:', error?.message || error);
      return null;
    }
  }

  // Универсальный метод
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