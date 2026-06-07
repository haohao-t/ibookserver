import axios from 'axios';
import * as cheerio from 'cheerio';

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
  }

class LabirintParser {
  private readonly USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
  private readonly REQUEST_DELAY = 500;
  private lastRequestTime = 0;

  private async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.REQUEST_DELAY) {
      await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  async searchByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n[Лабиринт] ========== НАЧАЛО ПАРСИНГА ==========');
    console.log('[Лабиринт] ISBN:', isbn);

    await this.rateLimit();

    try {
      let bookData = await this.searchViaDirectUrl(isbn);
      if (bookData) return bookData;

      bookData = await this.searchViaSearchPage(isbn);
      if (bookData) return bookData;

      console.log('[Лабиринт] Книга не найдена');
      return null;

    } catch (error) {
      console.error('[Лабиринт] Ошибка парсинга:', error);
      return null;
    }
  }

  private async searchViaDirectUrl(isbn: string): Promise<BookData | null> {
    try {
      const cleanIsbn = isbn.replace(/[-\s]/g, '');
      const directUrl = `https://www.labirint.ru/books/${cleanIsbn}/`;
      console.log('[Лабиринт] Пробуем прямой URL:', directUrl);

      const response = await axios.get(directUrl, {
        headers: { 'User-Agent': this.USER_AGENT },
        timeout: 3000,
        validateStatus: (status) => status === 200
      });

      console.log('[Лабиринт] Прямой URL сработал!');
      await this.rateLimit();
      return await this.parseBookPage(directUrl, isbn);

    } catch (error) {
      console.log('[Лабиринт] Прямой URL не доступен');
      return null;
    }
  }

  private async searchViaSearchPage(isbn: string): Promise<BookData | null> {
    try {
      const searchUrl = `https://www.labirint.ru/search/${isbn}/`;
      console.log('[Лабиринт] URL поиска:', searchUrl);

      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': this.USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.8,en-US;q=0.5,en;q=0.3',
        },
        timeout: 12000
      });

      if (response.status !== 200) {
        return null;
      }

      const $ = cheerio.load(response.data);

      let bookLinks = $('.product a.product-title-link').toArray();
      
      if (bookLinks.length === 0) {
        bookLinks = $('a[href*="/books/"]').toArray();
      }

      if (bookLinks.length === 0) {
        console.log('[Лабиринт] Книги не найдены в поиске');
        return null;
      }

      const firstBookLink = $(bookLinks[0]).attr('href');
      if (!firstBookLink) return null;

      const bookUrl = firstBookLink.startsWith('http')
        ? firstBookLink
        : `https://www.labirint.ru${firstBookLink}`;

      console.log('[Лабиринт] URL книги:', bookUrl);
      await this.rateLimit();

      return await this.parseBookPage(bookUrl, isbn);

    } catch (error) {
      console.error('[Лабиринт] Ошибка поиска:', error);
      return null;
    }
  }

  private async parseBookPage(bookUrl: string, isbn: string): Promise<BookData | null> {
    try {
      const response = await axios.get(bookUrl, {
        headers: { 'User-Agent': this.USER_AGENT },
        timeout: 5000
      });

      if (response.status !== 200) {
        return null;
      }

      const $ = cheerio.load(response.data);
 
      let title = this.extractTitle($);
      let authors = this.extractAuthors($);
      const publisher = this.extractPublisher($);
      const pages = this.extractPages($);
      const year = this.extractYear($);
      const coverUrl = this.extractCoverUrl($);
      const description = this.extractDescription($);
 
      if (authors.length === 0 && title && title.includes(':')) {
        console.log('[Лабиринт] Автор не найден отдельно, проверяем название...');
         
        const parts = title.split(':');
        const possibleTitle = (parts[0] ?? '').trim();
        const possibleAuthor = parts.slice(1).join(':').trim();
        
        console.log('[Лабиринт] Возможное название:', possibleTitle);
        console.log('[Лабиринт] Возможный автор:', possibleAuthor);
        
        if (possibleAuthor.length > 0 && possibleAuthor.length < 100) {
          title = possibleTitle;
          authors = [possibleAuthor];
          console.log('[Лабиринт] Разделили название и автора');
        }
      }

      console.log('[Лабиринт] Книга найдена:');
      console.log('   Название:', title);
      console.log('   Авторы:', authors);
      console.log('   Издательство:', publisher);
      console.log('   Год:', year);

      return {
        title: title || 'Неизвестное название',
        authors: authors.length > 0 ? authors : ['Неизвестный автор'],
        description: description || '',
        coverUrl: coverUrl,
        pages: pages,
        publisher: publisher || '',
        language: 'ru',
        isbn: isbn,
        publish_year: year
      };

    } catch (error) {
      console.error('[Лабиринт] Ошибка парсинга страницы:', error);
      return null;
    }
  }

  private extractTitle($: any): string {
    const titleElement = $('h1.product-title');
    if (titleElement.length > 0) {
      return titleElement.text().trim() || '';
    }
    
    const altTitle = $('h1[itemprop="name"]');
    if (altTitle.length > 0) {
      return altTitle.text().trim() || '';
    }
    
    const metaTitle = $('meta[property="og:title"]').attr('content');
    if (metaTitle) {
      return metaTitle || '';
    }

    return '';
  }

  private extractAuthors($: any): string[] {
    const authors: string[] = [];
    
    const authorElements = $('a[data-event-label="author"]');
    authorElements.each((i: number, el: any) => {
      const author = $(el).text().trim();
      if (author && !authors.includes(author)) {
        authors.push(author);
      }
    });

    if (authors.length === 0) {
      const prodMeta = $('.product-meta');
      if (prodMeta.length > 0) {
        const text = prodMeta.text();
        
        const authorMatch = text.match(/Автор[:\s]+([^\n]+)/i);
        if (authorMatch && authorMatch[1]) {
          const authorList = authorMatch[1].split(/[,;]/).map((a: string) => a.trim());
          authors.push(...authorList);
        }
      }
    }

    if (authors.length === 0) {
      const details = $('.product-description').text();
      const detailsMatch = details.match(/Автор[:\s]+([^\n]+)/i);
      if (detailsMatch && detailsMatch[1]) {
        authors.push(detailsMatch[1].trim());
      }
    }

    return authors;
  }

  private extractPublisher($: any): string {
    const publisherElement = $('a[data-event-label="publisher"]');
    if (publisherElement.length > 0) {
      return publisherElement.first().text().trim() || '';
    }

    const meta = $('.product-meta').text();
    const match = meta.match(/Издательство[:\s]+([^\n]+)/);
    if (match && match[1]) {
      return match[1].trim() || '';
    }

    return '';
  }

  private extractPages($: any): number | null {
    const pagesElement = $('meta[itemprop="numberOfPages"]');
    if (pagesElement.length > 0) {
      const pages = parseInt(pagesElement.attr('content') || '');
      return isNaN(pages) ? null : pages;
    }

    const text = $('.product-meta').text();
    const match = text.match(/(\d+)\s+страниц/);
    if (match && match[1]) {
      const pages = parseInt(match[1]);
      return isNaN(pages) ? null : pages;
    }

    return null;
  }

  private extractYear($: any): number | null {
    const text = $('.product-meta').text();
    const match = text.match(/(19|20)\d{2}\s*г\./);
    if (match && match[0]) {
      const year = parseInt(match[0]);
      return isNaN(year) ? null : year;
    }

    const publisherInfo = $('.publisher-info').text();
    const pubMatch = publisherInfo.match(/(19|20)\d{2}/);
    if (pubMatch && pubMatch[0]) {
      const year = parseInt(pubMatch[0]);
      return isNaN(year) ? null : year;
    }

    return null;
  }

private extractCoverUrl($: any): string {
  let coverUrl = '';
  
  const imgSelectors = [
    'img.cover-image',
    'img.book-cover',
    'img[itemprop="image"]',
    '.product-cover img',
    '.book-cover img',
    'img.product-picture'
  ];

  for (const selector of imgSelectors) {
    const imgElement = $(selector);
    if (imgElement.length > 0) {
      const src = imgElement.attr('src');
      const dataSrc = imgElement.attr('data-src');
      const dataOriginal = imgElement.attr('data-original');
      
      if (src && typeof src === 'string' && src.trim() !== '') {
        coverUrl = src.trim();
        break;
      }
      if (dataSrc && typeof dataSrc === 'string' && dataSrc.trim() !== '') {
        coverUrl = dataSrc.trim();
        break;
      }
      if (dataOriginal && typeof dataOriginal === 'string' && dataOriginal.trim() !== '') {
        coverUrl = dataOriginal.trim();
        break;
      }
    }
  }

  if (!coverUrl) {
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage && typeof ogImage === 'string' && ogImage.trim() !== '') {
      coverUrl = ogImage.trim();
    }
  }

  if (coverUrl && coverUrl.trim() !== '') {
    coverUrl = coverUrl.trim();
    
    if (coverUrl.startsWith('//')) {
      coverUrl = 'https:' + coverUrl;
    }
    
    if (coverUrl.startsWith('/')) {
      coverUrl = 'https://www.labirint.ru' + coverUrl;
    }
    
    if (!coverUrl.startsWith('http')) {
      coverUrl = 'https://' + coverUrl;
    }
    
    console.log('[Лабиринт] Обложка найдена:', coverUrl);
    return coverUrl;
  }

  console.log('[Лабиринт] Обложка не найдена');
  return '';
}

  private extractDescription($: any): string {
    const description = $('.product-description');
    if (description.length > 0) {
      return description.text().trim() || '';
    }

    const annotation = $('.annotation');
    if (annotation.length > 0) {
      return annotation.text().trim() || '';
    }

    const metaDesc = $('meta[name="description"]').attr('content');
    if (metaDesc) {
      return metaDesc || '';
    }

    return '';
  }
}

export const labirintParser = new LabirintParser();