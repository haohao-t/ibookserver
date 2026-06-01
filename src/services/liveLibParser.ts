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
  series?: string | undefined;
  sourceUrl?: string | undefined;
}

class LiveLibParser {
  private readonly USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  private readonly REQUEST_DELAY = 600;
  private lastRequestTime = 0;

  private async rateLimit() {
    const now = Date.now();
    const diff = now - this.lastRequestTime;
    if (diff < this.REQUEST_DELAY) {
      await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY - diff));
    }
    this.lastRequestTime = Date.now();
  }

  private get headers() {
    return {
      'User-Agent': this.USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    };
  }

  async searchByISBN(isbn: string): Promise<BookData | null> {
    console.log('\n📗 [LiveLib] ========== НАЧАЛО ПАРСИНГА ==========');
    console.log('📗 [LiveLib] ISBN:', isbn);

    await this.rateLimit();

    try {
      // Шаг 1: страница поиска по ISBN
      const searchUrl = `https://www.livelib.ru/find/books/${isbn}`;
      console.log('📗 [LiveLib] Поиск:', searchUrl);

      const searchResp = await axios.get(searchUrl, {
        headers: this.headers,
        timeout: 12000,
        maxRedirects: 5,
        validateStatus: s => s < 500,
      });

      console.log('📗 [LiveLib] Статус поиска:', searchResp.status);
      if (searchResp.status !== 200) {
        console.log('📗 [LiveLib] ❌ Поиск вернул не 200');
        return null;
      }

      // Проверяем финальный URL после редиректов
      const finalSearchUrl: string = searchResp.request?.res?.responseUrl ?? searchUrl;
      console.log('📗 [LiveLib] Финальный URL после редиректа:', finalSearchUrl);

      // Шаг 2а: Если LiveLib сразу редиректнул на страницу книги — парсим напрямую
      if (finalSearchUrl.includes('/book/') && !finalSearchUrl.includes('/find/')) {
        console.log('📗 [LiveLib] Редирект на страницу книги — парсим напрямую');
        return this.parsePage(searchResp.data, isbn, finalSearchUrl);
      }

      // Шаг 2б: Страница поиска — извлекаем ссылку на первую книгу
      const bookUrl = this.extractFirstBookUrl(searchResp.data);
      if (!bookUrl) {
        console.log('📗 [LiveLib] ❌ Книги не найдены в результатах поиска');
        return null;
      }

      console.log('📗 [LiveLib] Страница книги:', bookUrl);
      await this.rateLimit();

      // Шаг 3: парсим страницу книги
      const bookResp = await axios.get(bookUrl, {
        headers: this.headers,
        timeout: 10000,
        maxRedirects: 5,
      });

      if (bookResp.status !== 200) return null;

      const finalUrl: string = bookResp.request?.res?.responseUrl ?? bookUrl;
      return this.parsePage(bookResp.data, isbn, finalUrl);

    } catch (error: any) {
      console.error('📗 [LiveLib] ❌ Ошибка:', error.message);
      return null;
    }
  }

  private extractFirstBookUrl(html: string): string | null {
    const $ = cheerio.load(html);

    // Приоритет — специфичные контейнеры поисковой выдачи LiveLib
    const mainResultSelectors = [
      '#objects-by-rating .brow-book-name a',
      '.objects-by-rating .brow-book-name a',
      '#search-objects .brow-book-name a',
      '.search-objects .brow-book-name a',
      '.objects-items .brow-book-name a',
      '.brow-book-name a',
      '.book-item__title a',
    ];

    for (const sel of mainResultSelectors) {
      const el = $(sel).first();
      const href = el.attr('href');
      if (href && href.includes('/book/') && !href.includes('/review') && !href.includes('/tag')) {
        console.log(`📗 [LiveLib] URL найден через селектор "${sel}":`, href);
        return href.startsWith('http') ? href : `https://www.livelib.ru${href}`;
      }
    }

    // Запасной вариант: ищем ссылку вида /book/ЦИФРЫ- (страница книги по ID)
    // Это надёжнее, чем брать любую /book/ ссылку, — боковые панели дают другие форматы
    let found: string | null = null;
    $('a[href*="/book/"]').each((_: any, el: any) => {
      if (found) return false as any;
      const href = $(el).attr('href') ?? '';
      // Формат страницы книги: /book/1003861-nazvanie или /book/nazvanie
      if (
        /\/book\/[\w][\w-]*$/.test(href) &&
        !href.includes('/review') &&
        !href.includes('/tag') &&
        !href.includes('/list') &&
        !href.includes('/author') &&
        !href.includes('/series')
      ) {
        found = href.startsWith('http') ? href : `https://www.livelib.ru${href}`;
        console.log('📗 [LiveLib] URL найден через fallback-паттерн:', found);
      }
    });

    if (!found) {
      console.log('📗 [LiveLib] Ни один селектор не дал результата');
    }
    return found;
  }

  private parsePage(html: string, isbn: string, pageUrl: string): BookData | null {
    const $ = cheerio.load(html);

    const title = this.extractTitle($);
    if (!title) {
      console.log('📗 [LiveLib] ❌ Название не найдено');
      return null;
    }

    const authors  = this.extractAuthors($);
    const cover    = this.extractCover($);
    const desc     = this.extractDescription($);
    const pages    = this.extractPages($);
    const year     = this.extractYear($);
    const publisher = this.extractPublisher($);
    const series   = this.extractSeries($);
    const lang     = this.extractLanguage($);

    console.log('📗 [LiveLib] ✅ Найдено:', title, '|', authors.join(', '));
    console.log('📗 [LiveLib] Обложка:', cover ? cover.slice(0, 60) + '...' : '❌ нет');
    console.log('📗 [LiveLib] Описание:', desc ? desc.slice(0, 80) + '...' : '❌ нет');
    if (series) console.log('📗 [LiveLib] Серия:', series);

    return {
      title,
      authors,
      description: desc,
      coverUrl: cover,
      pages,
      publisher,
      language: lang,
      isbn,
      publish_year: year,
      series: series || undefined,
      sourceUrl: pageUrl,
    };
  }

  // ─── Extractors ───────────────────────────────────────────────────────────

  private extractTitle($: cheerio.CheerioAPI): string {
    // h1 — самый точный, без лишних слов
    const h1Selectors = [
      'h1.bc-header__title',
      'h1[itemprop="name"]',
      'h1.work-title',
      'h1',
    ];
    for (const sel of h1Selectors) {
      const t = $(sel).first().text().trim();
      if (t && t.length > 1) return t;
    }

    // og:title — часто «Книга «Название» — Автор» или «Название — Автор — LiveLib»
    const ogTitle = ($('meta[property="og:title"]').attr('content') ?? '').trim();
    if (ogTitle) {
      // Извлекаем текст из кавычек «...»
      const quoted = ogTitle.match(/«([^»]+)»/);
      if (quoted?.[1]) return quoted[1].trim();
      // Убираем «Книга » в начале и всё после первого « — »
      return (ogTitle.replace(/^Книга\s+/i, '').split('—')[0] ?? '').trim();
    }

    // HTML <title> — «Книга «Название» — Автор — LiveLib.ru»
    const htmlTitle = $('title').text().trim();
    if (htmlTitle) {
      const quoted = htmlTitle.match(/«([^»]+)»/);
      if (quoted?.[1]) return quoted[1].trim();
      return (htmlTitle.split('—')[0] ?? '').replace(/^Книга\s+/i, '').trim();
    }

    return '';
  }

  private extractAuthors($: cheerio.CheerioAPI): string[] {
    const authors: string[] = [];

    // 1️⃣ itemprop="author" + вложенный itemprop="name" — самый точный
    $('[itemprop="author"] [itemprop="name"]').each((_: any, el: any) => {
      const name = $(el).text().trim();
      if (name && name.length > 1 && name.length < 100 && !authors.includes(name)) authors.push(name);
    });
    if (authors.length) return authors;

    // 2️⃣ itemprop="author" напрямую (без вложенности)
    $('[itemprop="author"]').each((_: any, el: any) => {
      const name = $(el).text().trim();
      if (name && name.length > 1 && name.length < 100 && !authors.includes(name)) authors.push(name);
    });
    if (authors.length) return authors;

    // 3️⃣ Ссылки на авторов только в шапке книги (не по всей странице)
    const headerAuthorSelectors = [
      '.bc-header__author a[href*="/author/"]',
      '.work-authors a[href*="/author/"]',
      '.book-author a[href*="/author/"]',
      'h2 a[href*="/author/"]',
      '.authors a[href*="/author/"]',
    ];
    for (const sel of headerAuthorSelectors) {
      $(sel).each((_: any, el: any) => {
        const name = $(el).text().trim();
        if (name && name.length > 2 && name.length < 100 && !authors.includes(name)) authors.push(name);
      });
      if (authors.length) return authors;
    }

    // 4️⃣ Последний шанс: первая ссылка /author/ в пределах первых 50 ссылок на странице
    // (не перебираем всю страницу, чтобы не захватить рекомендации)
    let checked = 0;
    $('a[href*="/author/"]').each((_: any, el: any) => {
      if (checked++ > 50 || authors.length) return false;
      const name = $(el).text().trim();
      if (name && name.length > 2 && name.length < 80 && !authors.includes(name)) {
        authors.push(name);
      }
    });

    return authors;
  }

  private extractCover($: cheerio.CheerioAPI): string {
    const normalize = (url: string | undefined): string => {
      if (!url) return '';
      if (url.startsWith('http')) return url;
      if (url.startsWith('//')) return 'https:' + url;
      if (url.startsWith('/')) return 'https://www.livelib.ru' + url;
      return '';
    };

    // 1️⃣ Мета-теги OG / Twitter — самый надёжный источник полного URL
    const metaCandidates = [
      $('meta[property="og:image"]').attr('content'),
      $('meta[property="og:image:secure_url"]').attr('content'),
      $('meta[name="twitter:image"]').attr('content'),
      $('meta[name="twitter:image:src"]').attr('content'),
    ];
    for (const url of metaCandidates) {
      const normalized = normalize(url);
      if (normalized) return normalized;
    }

    // 2️⃣ Прямые img-теги (src / data-src / data-original)
    const imgSelectors = [
      'img.bc-cover__img',
      'img[itemprop="image"]',
      '.bc-cover img',
      '#bc-book-cover img',
      '.book-page__cover img',
      'img.book-cover',
    ];
    for (const sel of imgSelectors) {
      const el = $(sel).first();
      const src = el.attr('src') ?? el.attr('data-src') ?? el.attr('data-original');
      const normalized = normalize(src);
      if (normalized) return normalized;
    }

    // 3️⃣ Любая картинка с CDN LiveLib (boocover / s1.livelib.ru)
    let cdnUrl = '';
    $('img').each((_: any, el: any) => {
      if (cdnUrl) return false as any;
      const src = $(el).attr('src') ?? $(el).attr('data-src') ?? $(el).attr('data-original') ?? '';
      if (src && (src.includes('boocover') || src.includes('livelib.ru/boocover'))) {
        cdnUrl = normalize(src);
      }
    });
    return cdnUrl;
  }

  /** Шаблонные тексты LiveLib — не являются описанием книги */
  private isJunkText(text: string): boolean {
    return /предлагаем вашему вниманию|читайте отзывы|рецензии.*цитаты|цитаты.*рецензии|купить книгу|скачать книгу|livelib\.ru/i.test(text);
  }

  private extractDescription($: cheerio.CheerioAPI): string {
    const candidates: string[] = [];

    // og:description — обычно содержит реальное описание (в отличие от meta[name="description"])
    const ogDesc = ($('meta[property="og:description"]').attr('content') ?? '').trim();
    if (ogDesc && ogDesc.length > 30 && !this.isJunkText(ogDesc)) {
      candidates.push(ogDesc);
    }

    const selectors = [
      '[itemprop="description"]',
      '.bc-annotation__text',
      '#annotation .bc-annotation__text',
      '#annotation',
      '.bc-description__text',
      '.book-description',
      '#book-description',
      '.annotation-text',
      '.ltr-text',
    ];

    for (const sel of selectors) {
      const t = $(sel).first().text().trim();
      // Минимум 30 символов, не шаблонный текст
      if (t && t.length > 30 && !this.isJunkText(t)) {
        candidates.push(t);
      }
    }

    // Берём самое длинное из подходящих
    if (candidates.length > 0) {
      return candidates.reduce((a, b) => (a.length >= b.length ? a : b));
    }

    // meta description — только если не содержит шаблонный мусор
    const meta = ($('meta[name="description"]').attr('content') ?? '').trim();
    if (meta && !this.isJunkText(meta)) {
      return meta;
    }

    return '';
  }

  private extractPages($: cheerio.CheerioAPI): number | null {
    const meta = $('[itemprop="numberOfPages"]').attr('content');
    if (meta) { const n = parseInt(meta, 10); if (!isNaN(n)) return n; }

    const text = $('body').text();
    const m = text.match(/(\d{2,4})\s*стр/);
    if (m && m[1]) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > 0) return n; }

    return null;
  }

  private extractYear($: cheerio.CheerioAPI): number | null {
    const text = $('body').text();
    const patterns = [
      /Год\s*(?:издания|выпуска)?[:\s]+(\d{4})/i,
      /(\d{4})\s*г(?:од)?[.\s]/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) {
        const y = parseInt(m[1], 10);
        if (y > 1900 && y <= new Date().getFullYear() + 1) return y;
      }
    }
    return null;
  }

  private extractPublisher($: cheerio.CheerioAPI): string {
    const selectors = [
      '[itemprop="publisher"] [itemprop="name"]',
      '[itemprop="publisher"]',
      'a[href*="/publisher/"]',
      'a[href*="/pub/"]',
    ];
    for (const sel of selectors) {
      const t = $(sel).first().text().trim();
      if (t && t.length > 1) return t;
    }

    const text = $('body').text();
    const m = text.match(/Издательство[:\s]+([^\n,]+)/i);
    if (m && m[1]) return m[1].trim();

    return '';
  }

  private extractSeries($: cheerio.CheerioAPI): string {
    const selectors = [
      'a[href*="/series/"]',
      '.bc-header__series a',
      '.serie-name',
      '[itemprop="isPartOf"] [itemprop="name"]',
    ];
    for (const sel of selectors) {
      const t = $(sel).first().text().trim();
      if (t && t.length > 1) return t;
    }

    const text = $('body').text();
    const m = text.match(/Серия[:\s]+([^\n,]{2,80})/i);
    if (m && m[1]) return m[1].trim();

    return '';
  }

  private extractLanguage($: cheerio.CheerioAPI): string {
    const text = $('body').text();
    if (/язык[:\s]+английский/i.test(text)) return 'en';
    if (/язык[:\s]+немецкий/i.test(text))  return 'de';
    if (/язык[:\s]+французский/i.test(text)) return 'fr';
    return 'ru';
  }
}

export const liveLibParser = new LiveLibParser();
